/**
 * Claude Code transcript reader — an interactive session's event stream, recovered
 * from the file the CLI writes as it goes.
 *
 * There is no socket to attach to. A `claude` process started by anything other
 * than the SDK reports its work exactly once, as JSONL appended to
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`, by a process that knows
 * nothing about us. So this module tails that file and projects it onto the same
 * `AdapterEvent` union every other adapter produces. Everything here is written
 * against a format nobody promised to keep: unknown record kinds are inert,
 * unparseable lines are counted rather than thrown, and no field is trusted to
 * exist.
 *
 * Three decisions carry the module:
 *
 *  1. LINES ARE FRAMED IN BYTES, NOT TEXT. We read raw bytes, split on 0x0A, and
 *     decode only complete lines. A record still being written is therefore held
 *     as an undecoded remainder until its newline arrives — which also means a
 *     multi-byte character straddling a read boundary can never be mangled into
 *     U+FFFD. Both failures are otherwise routine: the writer is another process
 *     and we sample it mid-write constantly.
 *
 *  2. USAGE IS DEDUPLICATED BY `message.id`. ONE logical assistant message is
 *     written as SEVERAL records sharing an id — measured on the real corpus on
 *     this machine, 61,760 assistant records for 33,154 messages — and every one
 *     of them repeats a `usage` block. Only the last is complete (observed: 2
 *     output tokens on the first five records of a message, 698 on the sixth).
 *     Billing per record would therefore over-count turns by ~1.9x AND read the
 *     wrong numbers, so a message's usage is held and emitted exactly once, on the
 *     first record that belongs to something else. `stop_reason` deliberately does
 *     NOT trigger that flush: it is stamped on every record of a multi-tool-call
 *     message (12,475 messages in the same corpus carry more than one), so using it
 *     as a terminator reintroduces the double-count it was meant to prevent.
 *
 *  3. NO EXIT IS INVENTED. `stop_reason: "end_turn"` means the assistant stopped
 *     talking, not that the run is over — the caller decides that, from its Stop
 *     hook. Only stop reasons that are genuinely terminal failures become `exit`.
 *
 * Sidechain (subagent) records are NOT filtered: a subagent's tokens are real money
 * and its work is real work. Note that on Claude Code 2.1.222 those records live in
 * a sibling file (`<session-uuid>/subagents/agent-<id>.jsonl`) rather than inline,
 * so a caller wanting the whole fleet's cost reads those paths too — this reader
 * handles either, because it never looks at `isSidechain` at all.
 */

import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AdapterEvent } from '../adapters/types.js';
import type { TranscriptUsage } from '../pricing/index.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Read size. Large enough that a busy session drains in one syscall per wake. */
const READ_CHUNK_BYTES = 256 * 1024;

/**
 * A single line longer than this is treated as corruption rather than data. Real
 * lines carry whole tool results and can reach megabytes, so the ceiling is high;
 * its only job is to stop a file with no newline in it from eating all the memory.
 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_FOR_FILE_MS = 30_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The transcript never appeared within `waitForFileMs`. */
export class TranscriptNotFoundError extends Error {
  constructor(
    readonly transcriptPath: string,
    readonly waitedMs: number,
  ) {
    super(`transcript ${transcriptPath} did not appear within ${waitedMs}ms`);
    this.name = 'TranscriptNotFoundError';
  }
}

/**
 * A session id that is not a UUID. It is interpolated into a filename and matched
 * against a directory tree, so anything else is rejected outright rather than
 * given the chance to mean `../`.
 */
export class InvalidSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super(`not a session id: ${JSON.stringify(sessionId)} (expected a UUID)`);
    this.name = 'InvalidSessionIdError';
  }
}

// ---------------------------------------------------------------------------
// Options and stats
// ---------------------------------------------------------------------------

/**
 * Token counts -> dollars, injected. The transcript has NO cost field — the SDK
 * used to supply one and the CLI does not — so someone has to convert, and it is
 * deliberately not this module: pricing is a table with an expiry date and belongs
 * to `src/pricing`. The argument order matches `(usage, model)` so a caller wires
 * it as `(u, m) => priceUsage(m, u).usd`.
 */
export type PriceFn = (usage: TranscriptUsage, model: string | undefined) => number;

export interface ReadTranscriptOptions {
  /** Absolute path to the `.jsonl`. Use {@link findTranscript} to get one. */
  path: string;
  price: PriceFn;
  /**
   * Stop tailing. The generator drains to EOF one last time, flushes the held
   * usage, and returns cleanly; it does not throw. Abort is "drain and stop".
   */
  signal?: AbortSignal;
  /** Tail for appended records (default). `false` reads to EOF and stops. */
  follow?: boolean;
  /**
   * Byte offset to start at. Default 0 — the whole file.
   *
   * Exists so ONE transcript can be read as SEVERAL runs without re-billing the
   * earlier ones: a Claude Code session outlives a turn, appends every turn to
   * the same file, and a reader that started over at byte 0 for the second turn
   * would emit the first turn's usage a second time. Feed back
   * {@link TranscriptReadStats.consumedBytes} to resume exactly where the last
   * read stopped. An offset past the end of a file that was truncated or
   * rewritten is detected as a shrink and reset to 0, which re-reads rather
   * than silently skipping.
   */
  startAtByte?: number;
  /** How long to wait for a file that does not exist yet. Default 30s. */
  waitForFileMs?: number;
  /** Backstop poll interval; `fs.watch` supplies the low-latency path. Default 100ms. */
  pollIntervalMs?: number;
  /**
   * Mutated in place as reading proceeds, so a caller that is still iterating can
   * see the damage counters. Also returned by the generator.
   */
  stats?: TranscriptReadStats;
}

/**
 * What the reader had to survive. Every field here is a thing that would otherwise
 * have been an exception or, worse, a silently dropped record.
 */
export interface TranscriptReadStats {
  linesSeen: number;
  recordsParsed: number;
  /** Lines that were not parseable JSON, or were not a record-shaped object. */
  malformedLines: number;
  /** Lines discarded for exceeding {@link MAX_LINE_BYTES}. */
  oversizedLines: number;
  /** Times `price()` threw. The usage event is still emitted, with `costUsd: 0`. */
  pricingFailures: number;
  /** Record `type` values seen and not mapped, with counts. Diagnostic only. */
  ignoredKinds: Record<string, number>;
  /** Assistant content-block `type` values seen and not mapped, with counts. */
  ignoredBlockKinds: Record<string, number>;
  eventsEmitted: number;
  /**
   * Absolute byte offset just past the last COMPLETE line consumed — never
   * inside a record still being written. Pass it as {@link
   * ReadTranscriptOptions.startAtByte} to resume this read where it stopped.
   */
  consumedBytes: number;
}

export function createStats(): TranscriptReadStats {
  return {
    linesSeen: 0,
    recordsParsed: 0,
    malformedLines: 0,
    oversizedLines: 0,
    pricingFailures: 0,
    ignoredKinds: {},
    ignoredBlockKinds: {},
    eventsEmitted: 0,
    consumedBytes: 0,
  };
}

// ---------------------------------------------------------------------------
// stop_reason -> exit
// ---------------------------------------------------------------------------

/**
 * The only stop reasons that are an `exit`.
 *
 * `end_turn`, `tool_use` and `stop_sequence` are all ordinary mid-run states: a
 * Crew ends dozens of turns before its run is over, and a reader that emitted
 * `exit` on each one would tell the orchestrator to tear down a live worktree. The
 * end of a run is signalled by the caller's Stop hook, not by anything in here.
 *
 * What IS terminal is a turn the model could not complete: a refusal, or an output
 * or context ceiling. Those cannot be recovered from by continuing, so the caller
 * is told, with `ok: false` and the raw reason preserved.
 */
export function stopReasonToExit(
  stopReason: string | undefined,
): Extract<AdapterEvent, { type: 'exit' }> | undefined {
  switch (stopReason) {
    case 'refusal':
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return { type: 'exit', ok: false, reason: stopReason };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Locating a transcript
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** How deep the fallback walk goes. Session dirs nest one level (`<uuid>/subagents/`). */
const SEARCH_MAX_DEPTH = 4;

/**
 * Where transcripts live. `CLAUDE_CONFIG_DIR` replaces `~/.claude` wholesale when
 * set, which is how a sandboxed or multi-account setup relocates the lot.
 */
export function transcriptRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  const base = configDir && configDir.trim() !== '' ? configDir : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Find `<sessionId>.jsonl` by SEARCHING, never by computing the directory.
 *
 * The project directory name is a lossy encoding of the cwd — `/`, `.` and `_` all
 * become `-`, so `/Users/a.b/x_y` and `/Users/a-b/x-y` produce the same directory
 * and no inverse exists. Deriving the path from a cwd is therefore wrong in a way
 * that only shows up on somebody else's machine. The session id is unique on its
 * own, so we look for it.
 *
 * Returns the most recently modified match when a session id appears under more
 * than one project directory (it does, when a session outlives a `cd`).
 *
 * Candidates are qualified with `stat`, not with the directory entry's own type,
 * because transcripts really are symlinks sometimes: a resumed session's subagent
 * transcripts are symlinked back to the session that produced them. `stat` follows
 * the link, so a live one qualifies and a DANGLING one is skipped — and skipping it
 * matters, since returning a broken path would strand the caller in the reader's
 * wait-for-file loop for the whole timeout before it failed.
 */
export async function findTranscript(
  sessionId: string,
  opts?: { root?: string },
): Promise<string | undefined> {
  if (!SESSION_ID_RE.test(sessionId)) throw new InvalidSessionIdError(sessionId);

  const root = opts?.root ?? transcriptRoot();
  const filename = `${sessionId}.jsonl`;

  // Fast path: the layout as it exists today — one flat directory per project.
  const shallow: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return undefined; // no projects dir at all: nothing to find, not an error.
  }
  for (const entry of entries) {
    const direct = entry.name === filename ? path.join(root, entry.name) : undefined;
    if (direct !== undefined) {
      if (await isFile(direct)) shallow.push(direct);
      continue;
    }
    const candidate = path.join(root, entry.name, filename);
    if (await isFile(candidate)) shallow.push(candidate);
  }
  if (shallow.length > 0) return newestOf(shallow);

  // Slow path, for a layout that changes under us: walk, bounded.
  const deep: string[] = [];
  await walkFor(root, filename, SEARCH_MAX_DEPTH, deep);
  return deep.length > 0 ? newestOf(deep) : undefined;
}

async function walkFor(dir: string, filename: string, depth: number, out: string[]): Promise<void> {
  if (depth <= 0) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subtree; the rest of the search is still valid.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name === filename) {
      if (await isFile(full)) out.push(full);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      // Symlinked directories are followed, bounded by depth — which is also what
      // keeps a link that points back up the tree from looping forever.
      await walkFor(full, filename, depth - 1, out);
    }
  }
}

async function newestOf(paths: string[]): Promise<string | undefined> {
  if (paths.length === 1) return paths[0];
  const stamped: Array<{ p: string; mtime: number }> = [];
  for (const p of paths) {
    try {
      stamped.push({ p, mtime: (await fs.stat(p)).mtimeMs });
    } catch {
      // vanished mid-search; simply not a candidate.
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped[0]?.p;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * The running summary of the message currently being read, held back until a
 * record arrives that proves the message is finished. Each record of a message
 * overwrites this wholesale, so what is eventually emitted is the LAST record's
 * view — which is the complete one.
 */
interface PendingUsage {
  /** Undefined when the record carried no usable id — see {@link asId}. Never merges. */
  messageId: string | undefined;
  usage: TranscriptUsage;
  model: string | undefined;
  stopReason: string | undefined;
}

interface ReaderState {
  sessionEmitted: boolean;
  pending: PendingUsage | undefined;
}

/**
 * Tail a transcript, yielding normalized events as records land.
 *
 * Ends when the abort signal fires, when the caller stops iterating, or — with
 * `follow: false` — at EOF. Cleanup (file handle, watcher, timer, abort listener)
 * happens on every one of those paths, including the abandoned-iterator one.
 */
export async function* readTranscript(
  opts: ReadTranscriptOptions,
): AsyncGenerator<AdapterEvent, TranscriptReadStats, void> {
  const stats = opts.stats ?? createStats();
  const follow = opts.follow !== false;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const waitForFileMs = opts.waitForFileMs ?? DEFAULT_WAIT_FOR_FILE_MS;
  const signal = opts.signal;

  const state: ReaderState = { sessionEmitted: false, pending: undefined };
  const waker = new Waker();
  // Read through a call, not a property: `AbortSignal.aborted` is readonly, so
  // TypeScript narrows it at the first check and keeps that narrowing across the
  // awaits — which is exactly where it stops being true.
  const aborted = (): boolean => signal?.aborted === true;

  const onAbort = (): void => waker.wake();
  signal?.addEventListener('abort', onAbort, { once: true });

  let handle: fs.FileHandle | undefined;
  let watcher: FSWatcher | undefined;

  try {
    handle = await openWhenReady(opts.path, { waker, pollIntervalMs, waitForFileMs, signal });
    if (handle === undefined) return stats; // aborted while waiting.

    if (follow) watcher = startWatcher(opts.path, waker);

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = Math.max(0, Math.trunc(opts.startAtByte ?? 0));
    stats.consumedBytes = position;
    let carry: Buffer = Buffer.alloc(0);
    /** Set after a discarded oversized line: swallow bytes up to the next newline. */
    let resyncing = false;

    for (;;) {
      // Sampled BEFORE the read pass and acted on AFTER it: an abort means
      // "drain what is there, then stop", never "stop". The difference is a
      // dropped bill — the abort arrives from a watcher that has just seen the
      // Stop hook, and the records the turn was still writing are on disk by
      // then. Bounded: the drain below runs against a size sampled once, so a
      // file that keeps growing costs one extra pass, not an unbounded loop.
      const stopping = aborted();

      const size = (await handle.stat()).size;
      // A shrunken file means it was truncated or replaced (a resumed session gets
      // rewritten). Start over rather than decode from a stale offset.
      if (size < position) {
        position = 0;
        stats.consumedBytes = 0;
        carry = Buffer.alloc(0);
        resyncing = false;
      }

      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, position);
        if (bytesRead <= 0) break;
        position += bytesRead;

        let chunk = buffer.subarray(0, bytesRead);
        // Consume complete lines only; the tail of the chunk stays in `carry`
        // until its newline arrives, so a half-written record is never parsed.
        for (;;) {
          const nl = chunk.indexOf(0x0a);
          if (nl === -1) break;
          // Zero-copy when the whole line is in this chunk: `buffer` is reused,
          // but the only thing that overwrites it is the read above, which cannot
          // run again until this loop finishes with the view.
          const head = chunk.subarray(0, nl);
          const line = carry.length > 0 ? Buffer.concat([carry, head]) : head;
          carry = Buffer.alloc(0);
          chunk = chunk.subarray(nl + 1);
          if (resyncing) {
            resyncing = false; // this line is the tail of a discarded one.
            continue;
          }
          for (const event of handleLine(line, state, opts.price, stats)) {
            stats.eventsEmitted++;
            yield event;
          }
        }

        if (chunk.length > 0) carry = Buffer.concat([carry, chunk]);
        if (carry.length > MAX_LINE_BYTES) {
          stats.oversizedLines++;
          carry = Buffer.alloc(0);
          resyncing = true;
        }
        // Everything before `carry` is a decoded, complete line; `carry` is a
        // record still being written. Resuming from here therefore never splits
        // a record and never re-reads one.
        stats.consumedBytes = position - carry.length;
      }

      if (!follow) break;
      if (stopping) break;
      await waker.wait(pollIntervalMs);
    }

    // The last message's usage is still held if the file ended (or we were
    // stopped) before a following record proved it complete. Emit it now — a
    // dropped usage event is a dropped bill.
    for (const event of flushUsage(state, opts.price, stats)) {
      stats.eventsEmitted++;
      yield event;
    }
    return stats;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    waker.dispose();
    watcher?.close();
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Open the transcript, waiting for it to be created.
 *
 * A run's transcript does not exist until the CLI writes its first record, so a
 * caller that starts the reader at spawn time races it every single time.
 * Returns undefined if the wait was aborted; throws only on a real timeout.
 *
 * THE OPEN IS ATTEMPTED BEFORE THE ABORT IS CHECKED. An abort is a reason to
 * stop WAITING for a file, never a reason to refuse one that already exists —
 * checking first would mean a reader whose signal fired while it was starting up
 * returns zero events for a transcript sitting complete on disk, which is a whole
 * turn billed at nothing.
 */
async function openWhenReady(
  transcriptPath: string,
  o: {
    waker: Waker;
    pollIntervalMs: number;
    waitForFileMs: number;
    signal: AbortSignal | undefined;
  },
): Promise<fs.FileHandle | undefined> {
  const deadline = Date.now() + o.waitForFileMs;
  for (;;) {
    try {
      return await fs.open(transcriptPath, 'r');
    } catch (e: unknown) {
      if (!isMissingFile(e)) throw e;
    }
    if (o.signal?.aborted === true) return undefined;
    if (Date.now() >= deadline) throw new TranscriptNotFoundError(transcriptPath, o.waitForFileMs);
    // Poll rather than watch the parent: the directory may not exist yet either,
    // and a watch on a path that appears later is not portable.
    await o.waker.wait(Math.min(o.pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function isMissingFile(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * `fs.watch` is the latency optimization, not the correctness mechanism — it is
 * unreliable on network filesystems and after a rename, so every failure here is
 * swallowed and the poll interval carries the load.
 */
function startWatcher(transcriptPath: string, waker: Waker): FSWatcher | undefined {
  try {
    const w = watch(transcriptPath, { persistent: false }, () => waker.wake());
    w.on('error', () => undefined);
    return w;
  } catch {
    return undefined;
  }
}

/**
 * One-shot wake with a timeout, shared by the watcher, the abort signal and the
 * poll backstop. The timer is cleared on every path so nothing outlives the
 * generator; `persistent: false` on the watcher plus an unref'd timer would let
 * the process exit under a caller that is still awaiting us, so neither is unref'd
 * and `dispose()` is what releases the loop.
 */
class Waker {
  #resolve: (() => void) | undefined;
  #timer: NodeJS.Timeout | undefined;
  #signalled = false;
  #disposed = false;

  wake(): void {
    this.#signalled = true;
    this.#settle();
  }

  async wait(timeoutMs: number): Promise<void> {
    if (this.#disposed) return;
    if (this.#signalled) {
      this.#signalled = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#resolve = resolve;
      this.#timer = setTimeout(() => this.#settle(), timeoutMs);
    });
    this.#signalled = false;
  }

  dispose(): void {
    this.#disposed = true;
    this.#settle();
  }

  #settle(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const resolve = this.#resolve;
    this.#resolve = undefined;
    resolve?.();
  }
}

// ---------------------------------------------------------------------------
// Line -> record -> events
// ---------------------------------------------------------------------------

function* handleLine(
  line: Buffer,
  state: ReaderState,
  price: PriceFn,
  stats: TranscriptReadStats,
): Generator<AdapterEvent> {
  const text = line.toString('utf8').trim();
  if (text === '') return;
  stats.linesSeen++;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The writer is another process mid-flight and the format is not ours to
    // guarantee. A bad line costs one record, never the stream.
    stats.malformedLines++;
    return;
  }
  if (!isObject(parsed) || typeof parsed['type'] !== 'string') {
    stats.malformedLines++;
    return;
  }
  stats.recordsParsed++;
  yield* mapRecord(parsed, parsed['type'], state, price, stats);
}

function* mapRecord(
  record: Record<string, unknown>,
  kind: string,
  state: ReaderState,
  price: PriceFn,
  stats: TranscriptReadStats,
): Generator<AdapterEvent> {
  const sessionId = asId(record['sessionId']) ?? asId(record['session_id']);
  if (sessionId !== undefined && !state.sessionEmitted) {
    state.sessionEmitted = true;
    yield { type: 'session', sessionId };
  }

  const assistant = kind === 'assistant' ? parseAssistantMessage(record['message']) : undefined;

  // Held usage becomes final the moment a record arrives that is not another slice
  // of the same message. Flushing here rather than on the next assistant record is
  // what keeps a turn's usage ahead of its tool results in the stream.
  //
  // Continuation requires a usable id on BOTH sides. Comparing the ids directly
  // would make two records that each lost their id (`undefined === undefined`)
  // look like one message and merge their usage, discarding a real bill; an
  // unidentifiable record is therefore always its own message.
  const continuesPending =
    state.pending?.messageId !== undefined && state.pending.messageId === assistant?.id;
  if (state.pending !== undefined && !continuesPending) {
    yield* flushUsage(state, price, stats);
  }

  switch (kind) {
    case 'assistant':
      if (assistant === undefined) stats.malformedLines++;
      else yield* mapAssistant(assistant, state, stats);
      return;

    case 'user':
      yield* mapUserToolResults(record['message']);
      return;

    case 'system':
      // `stop_hook_summary`, `turn_duration`, `away_summary`, `compact_boundary`…
      // None of them is an AdapterEvent, and the Stop hook in particular is the
      // caller's signal to read, not ours to reinterpret as an exit.
      countKind(stats.ignoredKinds, `system:${asString(record['subtype']) ?? 'unknown'}`);
      return;

    default:
      // Every other kind is inert BY DESIGN — `mode`, `attachment`, `ai-title`,
      // `queue-operation`, `file-history-delta`, and whatever ships next month.
      // Counting them means a new kind shows up in diagnostics instead of as a
      // crash or, worse, as silence.
      countKind(stats.ignoredKinds, kind);
      return;
  }
}

interface AssistantMessage {
  /** Undefined when absent or empty. Such a record is billed alone, never merged. */
  id: string | undefined;
  model: string | undefined;
  content: readonly unknown[];
  usage: TranscriptUsage;
  stopReason: string | undefined;
}

/**
 * A missing `id` is deliberately NOT malformed. The record still carries real
 * content and real tokens, and rejecting it would drop both — so it is parsed
 * and simply never merged with a neighbour. Only a message that is not an object,
 * or whose content is not a list, is damage.
 */
function parseAssistantMessage(raw: unknown): AssistantMessage | undefined {
  if (!isObject(raw)) return undefined;
  const content = Array.isArray(raw['content']) ? raw['content'] : undefined;
  if (content === undefined) return undefined;
  return {
    id: asId(raw['id']),
    model: asString(raw['model']),
    content,
    usage: parseUsage(raw['usage']),
    stopReason: asString(raw['stop_reason']),
  };
}

function* mapAssistant(
  message: AssistantMessage,
  state: ReaderState,
  stats: TranscriptReadStats,
): Generator<AdapterEvent> {
  for (const raw of message.content) {
    if (!isObject(raw)) continue;
    const blockKind = asString(raw['type']);
    switch (blockKind) {
      case 'text': {
        const text = asString(raw['text']);
        // Empty text blocks are routine padding around tool calls; they carry no
        // information and would only add noise to a transcript view.
        if (text !== undefined && text !== '') yield { type: 'text', text };
        break;
      }
      case 'thinking':
      case 'redacted_thinking':
        // The union carries no payload deliberately: reasoning text is not for
        // anything upstream to store, quote, or feed back to a model.
        yield { type: 'thinking' };
        break;
      case 'tool_use': {
        const toolUseId = asId(raw['id']);
        const name = asId(raw['name']);
        if (toolUseId !== undefined && name !== undefined) {
          yield { type: 'tool_use', toolUseId, name, input: raw['input'] };
        }
        break;
      }
      default:
        countKind(stats.ignoredBlockKinds, blockKind ?? 'unknown');
        break;
    }
  }

  // Overwrite rather than accumulate, and DO NOT emit here even when stop_reason
  // is set. A stop_reason is not a message terminator: 12,475 messages in the
  // corpus on this machine carry a non-null one on more than one record (two
  // parallel tool calls arrive as two records, each stamped `tool_use`). Treating
  // it as the end of the message is precisely how usage gets counted twice. The
  // only reliable terminator is a record belonging to something else, so that is
  // what {@link mapRecord} flushes on.
  state.pending = {
    messageId: message.id,
    usage: message.usage,
    model: message.model,
    stopReason: message.stopReason,
  };
}

/**
 * Tool results arrive on a `user` record, in `message.content[]`. The record also
 * carries a richer top-level `toolUseResult`, which is deliberately ignored: its
 * shape is per-tool and the normalized event has one string field, so reading it
 * would mean inventing a serialization that every consumer then has to un-invent.
 */
function* mapUserToolResults(raw: unknown): Generator<AdapterEvent> {
  if (!isObject(raw)) return;
  const content = raw['content'];
  // A plain-string content is the captain's own prompt — no event models that.
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isObject(block) || block['type'] !== 'tool_result') continue;
    const toolUseId = asId(block['tool_use_id']);
    if (toolUseId === undefined) continue;
    const result = toolResultText(block['content']);
    yield {
      type: 'tool_result',
      toolUseId,
      // Absent `is_error` means success; only an explicit `true` is a failure.
      ok: block['is_error'] !== true,
      ...(result === undefined ? {} : { result }),
    };
  }
}

/** `content` is a string, or a block list mixing text with images and references. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content === '' ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block) || block['type'] !== 'text') continue; // images have no text form.
    const text = asString(block['text']);
    if (text !== undefined && text !== '') parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/**
 * Close out the pending message: its usage, then any exit its stop_reason implies.
 * Called on every transition and once at end of stream, so a message produces at
 * most one of each no matter how many records it was written as.
 */
function* flushUsage(
  state: ReaderState,
  price: PriceFn,
  stats: TranscriptReadStats,
): Generator<AdapterEvent> {
  const pending = state.pending;
  state.pending = undefined;
  if (pending === undefined) return;

  yield* flushUsageEvent(pending, price, stats);

  const exit = stopReasonToExit(pending.stopReason);
  if (exit !== undefined) yield exit;
}

function* flushUsageEvent(
  pending: PendingUsage,
  price: PriceFn,
  stats: TranscriptReadStats,
): Generator<AdapterEvent> {
  const inputTokens = pending.usage.input_tokens ?? 0;
  const outputTokens = pending.usage.output_tokens ?? 0;
  const cacheReadTokens = pending.usage.cache_read_input_tokens ?? 0;
  // The TTL split, not just the total. `src/pricing` bills whichever is larger
  // (a split that exceeds its total is trusted as-is), so reading only the
  // total here would let a block that IS billed be dropped as empty, and would
  // report zero cache-creation tokens for a cost the captain was charged.
  const split = pending.usage.cache_creation;
  const cacheCreationTokens = Math.max(
    pending.usage.cache_creation_input_tokens ?? 0,
    (split?.ephemeral_1h_input_tokens ?? 0) + (split?.ephemeral_5m_input_tokens ?? 0),
  );

  // An all-zero block bills nothing and reports nothing. It is also what the
  // `<synthetic>` model records (CLI-injected API errors) carry, which is the
  // case worth not forwarding: a fake model priced against a real table.
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return;

  let costUsd = 0;
  try {
    costUsd = price(pending.usage, pending.model);
    if (!Number.isFinite(costUsd)) {
      stats.pricingFailures++;
      costUsd = 0;
    }
  } catch {
    // Pricing rejects impossible counts. The tokens are still worth reporting —
    // suppressing the whole event would hide the anomaly as well as the cost.
    stats.pricingFailures++;
    costUsd = 0;
  }

  yield {
    type: 'usage',
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(pending.model === undefined ? {} : { model: pending.model }),
  };
}

// ---------------------------------------------------------------------------
// Narrowing helpers — this is parsed JSON off disk, so nothing is assumed
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A string used to IDENTIFY something — a session, a message, a tool call.
 *
 * `''` is rejected as well as a missing field, because an empty identifier is
 * worse than an absent one: it is a value that compares equal to every other
 * empty one. Two unrelated messages both carrying `id: ""` would look like one
 * message and have their usage merged — which silently drops a bill, the one
 * failure {@link flushUsage} exists to prevent. An empty `tool_use_id` fails the
 * same way, correlating a result to whichever other call also lost its id.
 */
function asId(value: unknown): string | undefined {
  const s = asString(value);
  return s === undefined || s === '' ? undefined : s;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Copy the fields `src/pricing` prices, dropping anything that is not a number. */
function parseUsage(raw: unknown): TranscriptUsage {
  if (!isObject(raw)) return {};
  const split = isObject(raw['cache_creation']) ? raw['cache_creation'] : undefined;
  return {
    input_tokens: asNumber(raw['input_tokens']),
    output_tokens: asNumber(raw['output_tokens']),
    cache_creation_input_tokens: asNumber(raw['cache_creation_input_tokens']),
    cache_read_input_tokens: asNumber(raw['cache_read_input_tokens']),
    ...(split === undefined
      ? {}
      : {
          cache_creation: {
            ephemeral_1h_input_tokens: asNumber(split['ephemeral_1h_input_tokens']),
            ephemeral_5m_input_tokens: asNumber(split['ephemeral_5m_input_tokens']),
          },
        }),
  };
}

function countKind(into: Record<string, number>, kind: string): void {
  into[kind] = (into[kind] ?? 0) + 1;
}
