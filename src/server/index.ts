/**
 * Starmap server — the captain's map, served locally.
 *
 * Owns: a dependency-free node:http server (no express) that exposes the
 * Blackbox projections as JSON, streams new events over SSE, and serves the
 * single-file dashboard in `web/`.
 *
 * Design notes that matter:
 *  - Bound to 127.0.0.1 ONLY. This is an unauthenticated view of the captain's
 *    work — worktree diffs, briefs, costs. It must never be reachable from the
 *    network. A Host-header check additionally blocks DNS-rebinding attempts.
 *  - The server keeps an in-memory mirror of the event log so projections are
 *    cheap to recompute on every poll. The mirror is fed by `blackbox.subscribe`
 *    (same-process appends) AND by a low-frequency `read({sinceSeq})` poll, so a
 *    second process writing to the same SQLite file still shows up.
 *  - Every handler returns JSON on failure with a plain message. Stack traces
 *    stay on this side of the wire.
 *  - `/api/diff/:id` is best-effort by contract: it shells out to read-only git
 *    inside the task's worktree and returns `{diff:null}` when there is nothing
 *    to show, rather than turning a missing worktree into an HTTP error.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  crewIdOf,
  projectAllDecisions,
  projectCost,
  projectCrewLog,
  taskIdOf,
  type Blackbox,
} from '../blackbox/index.js';
import { dataDir, ProjectRegistry } from '../config/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { Decision, Project, Task, TaskId } from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7777;
/** How many consecutive ports to try before giving up. */
const PORT_ATTEMPTS = 8;
/** SSE comment heartbeat. Keeps proxies and sleeping laptops from dropping us. */
const HEARTBEAT_MS = 15_000;
/** How often to look for events appended by another process. */
const POLL_MS = 2_000;
/** Request body ceiling. Nothing we accept is remotely this big. */
const MAX_BODY_BYTES = 256 * 1024;
/** Hard cap on a single /api/events page. */
const MAX_EVENT_PAGE = 20_000;
/** Diffs above this get truncated with a marker rather than blowing up a tab. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
/** Untracked files rendered into a diff, newest-listed first. */
const MAX_UNTRACKED_FILES = 60;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Minimal shape Starmap needs from a project registry. */
export interface ProjectSource {
  list(): Project[];
}

export interface StarmapOptions {
  blackbox: Blackbox;
  orch: Orchestrator;
  /** First port to try. Subsequent ports are tried if it is taken. */
  port?: number;
  /**
   * Project registry to read project names from. Optional: when omitted the
   * server opens the default registry, and falls back to `project.registered`
   * events if that is unavailable.
   */
  registry?: ProjectSource;
}

export interface StarmapHandle {
  url: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Event mirror
// ---------------------------------------------------------------------------

/**
 * An ordered, de-duplicated in-memory copy of the Blackbox log.
 *
 * Subscribing before the initial read closes the race where an event lands
 * between the two; `ingest` drops anything whose seq we already hold.
 *
 * The copy is deliberately complete rather than windowed: `projectCost` and
 * `projectAllDecisions` fold the entire log, so a trimmed mirror would report
 * a wrong total rather than a stale one. A local captain's log is small.
 */
class EventMirror {
  private events: BlueEvent[] = [];
  private maxSeq = 0;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<(e: BlueEvent) => void>();

  constructor(private readonly blackbox: Blackbox) {}

  start(): void {
    const buffered: BlueEvent[] = [];
    let live = false;
    this.unsubscribe = this.blackbox.subscribe((e) => {
      if (live) this.ingest([e]);
      else buffered.push(e);
    });
    this.ingest(this.blackbox.read({}));
    live = true;
    this.ingest(buffered);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
  }

  /** Fires for every event the mirror has not seen before. */
  onEvent(fn: (e: BlueEvent) => void): void {
    this.listeners.add(fn);
  }

  /** Pull in anything appended by another process. Cheap: indexed by seq. */
  refresh(): void {
    try {
      this.ingest(this.blackbox.read({ sinceSeq: this.maxSeq }));
    } catch {
      // A transient SQLite error must not take the dashboard down; the next
      // poll picks the events up.
    }
  }

  all(): readonly BlueEvent[] {
    return this.events;
  }

  since(seq: number, limit: number): BlueEvent[] {
    const out: BlueEvent[] = [];
    for (const e of this.events) {
      if (e.seq > seq) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * Everything that belongs to a task: its own events plus the crew-scoped
   * events (crew.text, crew.usage, …) that only carry a crewId.
   */
  forTask(taskId: TaskId, crewIds: string[]): BlueEvent[] {
    const crew = new Set(crewIds);
    return this.events.filter((e) => {
      if (taskIdOf(e) === taskId) return true;
      const cid = crewIdOf(e);
      return cid !== undefined && crew.has(cid);
    });
  }

  latestSeq(): number {
    return this.maxSeq;
  }

  private ingest(incoming: readonly BlueEvent[]): void {
    for (const e of incoming) {
      if (typeof e?.seq !== 'number' || e.seq <= this.maxSeq) continue;
      this.events.push(e);
      this.maxSeq = e.seq;
      for (const fn of this.listeners) {
        try {
          fn(e);
        } catch {
          // A broken SSE client must not stall ingestion.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(opts: StarmapOptions): Promise<StarmapHandle> {
  const { blackbox, orch } = opts;

  const mirror = new EventMirror(blackbox);
  mirror.start();

  const projects = new ProjectLookup(opts.registry);
  const clients = new Set<ServerResponse>();

  mirror.onEvent((e) => {
    const frame = `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) {
      if (res.writableEnded) continue;
      try {
        res.write(frame);
      } catch {
        // Client vanished mid-write; its 'close' handler does the cleanup.
      }
    }
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: messageOf(err) });
      else res.end();
    });
  });
  // An SSE *request* completes immediately — only the response is long-lived —
  // so requestTimeout stays at its default. The socket timeout is what would
  // reap an idle stream, and the heartbeat plus this keep it open.
  server.timeout = 0;
  server.keepAliveTimeout = 72_000;

  const port = await listenOnFreePort(server, opts.port ?? DEFAULT_PORT);
  const url = `http://${HOST}:${port}`;

  const heartbeat = setInterval(() => {
    const frame = `: ping ${Date.now()}\n\n`;
    for (const res of clients) {
      if (res.writableEnded) continue;
      try {
        res.write(frame);
      } catch {
        /* handled by 'close' */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const poll = setInterval(() => mirror.refresh(), POLL_MS);
  poll.unref?.();

  let closed = false;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const target = req.url ?? '/';
    let url: URL;
    try {
      url = new URL(target, `http://${HOST}`);
    } catch {
      sendJson(res, 400, { error: 'malformed request url' });
      return;
    }

    if (!hostIsLocal(req.headers.host)) {
      // DNS-rebinding guard: a browser on some other origin must not be able to
      // drive this server through the captain's own machine.
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, POST, OPTIONS' });
      res.end();
      return;
    }

    const segs = url.pathname.split('/').filter(Boolean).map(decodeSegment);
    const isApi = segs[0] === 'api';

    if (!isApi) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await serveStatic(url.pathname, res, method === 'HEAD');
      return;
    }

    // ---- /api/* -----------------------------------------------------------
    const [, a, b, c] = segs;

    if (method === 'GET' && a === 'health' && segs.length === 2) {
      sendJson(res, 200, { ok: true, seq: mirror.latestSeq(), now: Date.now() });
      return;
    }

    if (method === 'GET' && a === 'state' && segs.length === 2) {
      mirror.refresh();
      sendJson(res, 200, buildState());
      return;
    }

    if (method === 'GET' && a === 'events' && segs.length === 2) {
      mirror.refresh();
      const since = intParam(url.searchParams.get('since'), 0);
      const limit = clamp(intParam(url.searchParams.get('limit'), MAX_EVENT_PAGE), 1, MAX_EVENT_PAGE);
      const events = mirror.since(since, limit);
      sendJson(res, 200, { events, seq: mirror.latestSeq(), now: Date.now() });
      return;
    }

    if (method === 'GET' && a === 'stream' && segs.length === 2) {
      openStream(req, res, url);
      return;
    }

    if (a === 'task' && typeof b === 'string' && b.length > 0) {
      if (method === 'GET' && segs.length === 3) {
        mirror.refresh();
        const task = lookupTask(b);
        if (!task) {
          sendJson(res, 404, { error: 'no such task' });
          return;
        }
        const crewIds = crewIdsFor(task.id);
        sendJson(res, 200, {
          task,
          project: projects.get(task.projectId, mirror.all()) ?? null,
          events: mirror.forTask(task.id, crewIds),
          crewLog: crewIds.flatMap((id) => projectCrewLog(mirror.all() as BlueEvent[], id)),
          now: Date.now(),
        });
        return;
      }

      if (method === 'POST' && segs.length === 4 && c === 'cancel') {
        if (!lookupTask(b)) {
          sendJson(res, 404, { error: 'no such task' });
          return;
        }
        try {
          await orch.cancelTask(b);
        } catch (err) {
          sendJson(res, 409, { error: messageOf(err) });
          return;
        }
        mirror.refresh();
        sendJson(res, 200, { ok: true, task: lookupTask(b) ?? null });
        return;
      }

      if (method === 'POST' && segs.length === 4 && c === 'steer') {
        const body = await readJsonBody(req, res);
        if (!body.ok) return;
        const message = stringField(body.value, 'message');
        if (!message) {
          sendJson(res, 400, { error: 'body must be {"message": "<non-empty string>"}' });
          return;
        }
        if (!lookupTask(b)) {
          sendJson(res, 404, { error: 'no such task' });
          return;
        }
        try {
          await orch.steer(b, message);
        } catch (err) {
          sendJson(res, 409, { error: messageOf(err) });
          return;
        }
        mirror.refresh();
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    if (method === 'GET' && a === 'diff' && typeof b === 'string' && segs.length === 3) {
      mirror.refresh();
      const task = lookupTask(b);
      if (!task) {
        sendJson(res, 404, { error: 'no such task' });
        return;
      }
      sendJson(res, 200, await diffForTask(task));
      return;
    }

    if (method === 'POST' && a === 'decision' && typeof b === 'string' && segs.length === 3) {
      const body = await readJsonBody(req, res);
      if (!body.ok) return;
      const answer = stringField(body.value, 'answer');
      if (!answer) {
        sendJson(res, 400, { error: 'body must be {"answer": "<non-empty string>"}' });
        return;
      }
      try {
        await orch.resolveDecision(b, answer);
      } catch (err) {
        sendJson(res, 409, { error: messageOf(err) });
        return;
      }
      mirror.refresh();
      sendJson(res, 200, { ok: true, decisions: openDecisions() });
      return;
    }

    sendJson(res, 404, { error: 'no such endpoint' });
  }

  // ---- helpers bound to this server instance -----------------------------

  function buildState(): {
    tasks: Task[];
    decisions: Decision[];
    allDecisions: Decision[];
    cost: ReturnType<typeof projectCost>;
    projects: Project[];
    seq: number;
    now: number;
  } {
    const events = mirror.all() as BlueEvent[];
    let tasks: Task[] = [];
    try {
      tasks = orch.tasks();
    } catch {
      tasks = [];
    }
    let all: Decision[] = [];
    try {
      all = projectAllDecisions(events);
    } catch {
      all = [];
    }
    let cost: ReturnType<typeof projectCost>;
    try {
      cost = projectCost(events);
    } catch {
      cost = { totalUsd: 0, byTask: {}, byModel: {} };
    }
    return {
      tasks,
      decisions: openDecisions(),
      allDecisions: all,
      cost,
      projects: projects.list(events),
      seq: mirror.latestSeq(),
      now: Date.now(),
    };
  }

  function openDecisions(): Decision[] {
    try {
      return orch.openDecisions();
    } catch {
      try {
        return projectAllDecisions(mirror.all() as BlueEvent[]).filter((d) => d.resolvedAt === undefined);
      } catch {
        return [];
      }
    }
  }

  function lookupTask(id: string): Task | undefined {
    try {
      const direct = orch.task(id);
      if (direct) return direct;
    } catch {
      // fall through to the task list
    }
    try {
      return orch.tasks().find((t) => t.id === id);
    } catch {
      return undefined;
    }
  }

  /** Every crew that has ever worked this task, oldest first. */
  function crewIdsFor(taskId: TaskId): string[] {
    const ids: string[] = [];
    for (const e of mirror.all()) {
      if ((e.type === 'crew.spawned' || e.type === 'task.dispatched') && e.taskId === taskId) {
        if (!ids.includes(e.crewId)) ids.push(e.crewId);
      }
    }
    return ids;
  }

  function openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Belt and braces for any proxy that buffers by default.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Replay: `Last-Event-ID` on browser reconnect, `?since=` on first connect.
    const lastId = req.headers['last-event-id'];
    const fromHeader = intParam(Array.isArray(lastId) ? lastId[0] : lastId, -1);
    const fromQuery = intParam(url.searchParams.get('since'), -1);
    const since = fromHeader >= 0 ? fromHeader : fromQuery;
    if (since >= 0) {
      for (const e of mirror.since(since, MAX_EVENT_PAGE)) {
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      }
    }
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: mirror.latestSeq(), now: Date.now() })}\n\n`);

    clients.add(res);
    const drop = (): void => {
      clients.delete(res);
      try {
        res.end();
      } catch {
        /* already gone */
      }
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearInterval(poll);
    mirror.stop();
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections?.();
    });
  }

  return { url, close };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * Resolves project metadata, in order of trustworthiness: an injected registry,
 * then the on-disk registry, then whatever the event log remembers.
 */
class ProjectLookup {
  private registry: ProjectSource | undefined;
  private tried = false;
  private cache: Project[] = [];

  constructor(injected?: ProjectSource) {
    this.registry = injected;
    this.tried = injected !== undefined;
  }

  list(events: readonly BlueEvent[]): Project[] {
    if (!this.tried) {
      this.tried = true;
      try {
        this.registry = ProjectRegistry.open(dataDir());
      } catch {
        this.registry = undefined;
      }
    }
    if (this.registry) {
      try {
        const listed = this.registry.list();
        if (listed.length > 0) {
          this.cache = listed;
          return listed;
        }
      } catch {
        // fall through to the event-derived view
      }
    }
    const derived = derivedProjects(events);
    this.cache = derived.length > 0 ? derived : this.cache;
    return this.cache;
  }

  get(id: string, events: readonly BlueEvent[]): Project | undefined {
    return this.list(events).find((p) => p.id === id);
  }
}

function derivedProjects(events: readonly BlueEvent[]): Project[] {
  const out = new Map<string, Project>();
  for (const e of events) {
    if (e.type !== 'project.registered') continue;
    out.set(e.projectId, {
      id: e.projectId,
      name: e.name,
      path: e.path,
      description: e.description,
      delivery: 'pr',
      addedAt: e.at,
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Diff (best effort, read-only git)
// ---------------------------------------------------------------------------

interface DiffResult {
  diff: string | null;
  path?: string;
  base?: string;
  truncated?: boolean;
  reason?: string;
}

async function diffForTask(task: Task): Promise<DiffResult> {
  const wt = task.worktree;
  if (!wt) return { diff: null, reason: 'task has no worktree yet' };
  if (!existsSync(wt)) return { diff: null, path: wt, reason: 'worktree has been torn down' };

  const inside = await git(wt, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { diff: null, path: wt, reason: 'worktree is not a git checkout' };
  }

  const base = await resolveBase(wt);
  let body = '';

  if (base) {
    const mb = await git(wt, ['merge-base', base, 'HEAD']);
    const from = mb.code === 0 ? mb.stdout.trim() : base;
    const d = await git(wt, ['diff', '--no-color', '--find-renames', from]);
    if (d.code === 0) body += d.stdout;
  }
  if (body.length === 0) {
    // No base to compare against (or nothing landed yet): show working tree
    // against HEAD so uncommitted Crew work is still visible.
    const d = await git(wt, ['diff', '--no-color', '--find-renames', 'HEAD']);
    if (d.code === 0) body += d.stdout;
  }

  body += await untrackedDiff(wt);

  if (body.length === 0) return { diff: null, path: wt, base: base ?? undefined, reason: 'no changes yet' };
  if (body.length > MAX_DIFF_BYTES) {
    return {
      diff: `${body.slice(0, MAX_DIFF_BYTES)}\n\n… diff truncated at ${MAX_DIFF_BYTES} bytes …\n`,
      path: wt,
      base: base ?? undefined,
      truncated: true,
    };
  }
  return { diff: body, path: wt, base: base ?? undefined };
}

/** The branch this worktree most plausibly forked from. */
async function resolveBase(cwd: string): Promise<string | null> {
  const originHead = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead.code === 0) {
    const name = originHead.stdout.trim();
    if (name) return name;
  }
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    const found = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (found.code === 0 && found.stdout.trim()) return candidate;
  }
  return null;
}

/** New files a Crew created but has not committed still count as its work. */
async function untrackedDiff(cwd: string): Promise<string> {
  const listed = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) return '';
  const files = listed.stdout.split('\0').filter((f) => f.length > 0);
  let out = '';
  for (const file of files.slice(0, MAX_UNTRACKED_FILES)) {
    // `--no-index` exits 1 when there is a difference, which is the normal case.
    const d = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file]);
    if (d.stdout) out += d.stdout;
    if (out.length > MAX_DIFF_BYTES) break;
  }
  if (files.length > MAX_UNTRACKED_FILES) {
    out += `\n… ${files.length - MAX_UNTRACKED_FILES} more untracked files not shown …\n`;
  }
  return out;
}

function git(
  cwd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const raw = (err as NodeJS.ErrnoException & { code?: number | string }).code;
          code = typeof raw === 'number' ? raw : 1;
        }
        done({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

let webDirCache: string | null | undefined;

/** Walk up from this module until a `web/index.html` turns up (src/ and dist/). */
function webDir(): string | null {
  if (webDirCache !== undefined) return webDirCache;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'web', 'index.html'))) {
      webDirCache = join(dir, 'web');
      return webDirCache;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  webDirCache = null;
  return null;
}

async function serveStatic(pathname: string, res: ServerResponse, headOnly: boolean): Promise<void> {
  const root = webDir();
  if (!root) {
    sendHtml(res, 500, fallbackPage('Dashboard files not found — expected <code>web/index.html</code>.'), headOnly);
    return;
  }

  const rel = pathname === '/' || pathname === '' ? 'index.html' : decodeSegment(pathname).replace(/^\/+/, '');
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    sendJson(res, 403, { error: 'forbidden path' });
    return;
  }

  let data: Buffer;
  try {
    data = await readFile(abs);
  } catch {
    if (rel === 'index.html') {
      sendHtml(res, 500, fallbackPage('Could not read <code>web/index.html</code>.'), headOnly);
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return;
  }

  const dot = abs.lastIndexOf('.');
  const ext = dot >= 0 ? abs.slice(dot).toLowerCase() : '';
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': data.byteLength,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (headOnly) res.end();
  else res.end(data);
}

function fallbackPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Starmap</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#1c2024}
code{background:#eceef0;padding:.1em .35em;border-radius:4px}
@media(prefers-color-scheme:dark){body{background:#0e1113;color:#e3e6e8}code{background:#22272b}}</style>
<h1>Starmap could not load</h1><p>${message}</p>`;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

async function listenOnFreePort(server: Server, first: number): Promise<number> {
  let lastErr: unknown;
  for (let i = 0; i < PORT_ATTEMPTS; i++) {
    const port = first + i;
    try {
      await listen(server, port);
      const addr = server.address() as AddressInfo | string | null;
      return typeof addr === 'object' && addr ? addr.port : port;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    }
  }
  throw new Error(
    `starmap: no free port in ${first}..${first + PORT_ATTEMPTS - 1} (${messageOf(lastErr)})`,
  );
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((done, fail) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      fail(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      done();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

/** Only loopback names may drive this server. */
function hostIsLocal(host: string | undefined): boolean {
  if (!host) return true; // HTTP/1.0 clients and some tools omit it.
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : (host.split(':')[0] ?? '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(body ?? null);
  } catch {
    text = '{"error":"response could not be serialized"}';
    status = 500;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string, headOnly = false): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  if (headOnly) res.end();
  else res.end(html);
}

type BodyRead = { ok: true; value: unknown } | { ok: false };

/** Reads and parses a JSON body, answering the client itself on failure. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      size += buf.byteLength;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'request body too large' });
        req.destroy();
        return { ok: false };
      }
      chunks.push(buf);
    }
  } catch {
    sendJson(res, 400, { error: 'could not read request body' });
    return { ok: false };
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    sendJson(res, 400, { error: 'body must be valid JSON' });
    return { ok: false };
  }
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = (value as Record<string, unknown>)[key];
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function intParam(value: string | undefined | null, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unexpected server error';
}
