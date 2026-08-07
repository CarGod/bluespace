/**
 * tmux session backend tests.
 *
 * These drive a REAL tmux server — no mocks, no fake runner. The properties
 * this backend claims are all about what tmux actually does with a target
 * string, and tmux is the only authority on that; a mock would only ever
 * confirm my reading of the manual.
 *
 * Three conventions keep the suite from wedging a developer's machine:
 *   - every backend gets a SOCKET unique to this process (`tmux -L <name>`), so
 *     the suite never shares a server with the captain's own tmux, with the
 *     real fleet on `bluespace`, or with another test;
 *   - every backend also gets a unique session name, so a target that escapes
 *     its socket somehow still cannot address anything real;
 *   - `afterEach` runs `kill-server` on every socket a test touched. That is a
 *     total, leak-free reap — and it is only safe to write because of the first
 *     convention, which is the same reason the production backend has a socket
 *     at all.
 *
 * The one deliberate exception is `strandedOnSharedSocket`, which is about the
 * shared `default` socket by definition. Those tests create and remove a single
 * uniquely-named session there and never run `kill-server` on it.
 *
 * The payload is always inert (`cat`, `sleep`, `sh -c`), never `claude`.
 *
 * Nothing here reads rendered pane content, in the tests either: where a test
 * needs to prove text arrived, the launched program writes it to a FILE and the
 * test reads the file.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionBackendUnavailableError } from '../src/session/types.js';
import {
  DEFAULT_TMUX_SOCKET,
  SHARED_TMUX_SOCKET,
  TMUX_COMMAND_BUDGET_BYTES,
  TMUX_INSTALL_HINT,
  TMUX_MAX_COMMAND_BYTES,
  TmuxBackend,
  TmuxCommandTooLongError,
  TmuxError,
  chunkByBytes,
  createTmuxRunner,
  sanitizeWindowName,
  tmuxCommandBytes,
  type TmuxRunner,
} from '../src/session/tmux.js';

const execFileAsync = promisify(execFile);

/** Generous: these tests start processes and poll for their side effects. */
const SLOW = 30_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Sockets to `kill-server` in afterEach. Never contains `default`. */
let sockets: string[] = [];
/** Sessions on the SHARED socket, reaped by exact name — never by kill-server. */
let sharedSessions: string[] = [];
let tmpDirs: string[] = [];

function unique(): string {
  return `bluetest-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** A private socket for one backend, registered for teardown. */
function socketName(): string {
  const name = unique();
  sockets.push(name);
  return name;
}

/**
 * The constructor options every test uses: a private socket and a private
 * session. Spelled as one helper so a test cannot accidentally land on the real
 * fleet's socket by omitting the option.
 */
function names(): { session: string; socket: string } {
  return { session: unique(), socket: socketName() };
}

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-tmux-')));
  tmpDirs.push(dir);
  return dir;
}

/** Direct tmux on a given socket, bypassing the backend — to observe and to stage hazards. */
async function tmux(socket: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', socket, ...args], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

async function tmuxOrEmpty(socket: string, args: string[]): Promise<string> {
  try {
    return await tmux(socket, args);
  } catch {
    return '';
  }
}

/** Direct tmux on the SHARED socket. Used only by the migration tests. */
async function sharedTmuxOrEmpty(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tmux', args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Session names on the shared socket — empty when no server is running there.
 *
 * Asked this way rather than with `has-session`, which prints nothing whether it
 * succeeds or fails and would make "it is not over there" pass vacuously.
 */
async function sharedSessionNames(): Promise<string[]> {
  return (await sharedTmuxOrEmpty(['list-sessions', '-F', '#{session_name}']))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** A backend that records every argv it hands to tmux, then really runs it. */
function recording(opts: { session: string; socket: string; cols?: number; rows?: number }): {
  backend: TmuxBackend;
  calls: string[][];
} {
  const calls: string[][] = [];
  const real = createTmuxRunner('tmux');
  const runner: TmuxRunner = async (args) => {
    calls.push([...args]);
    return real(args);
  };
  return { backend: new TmuxBackend({ ...opts, runner }), calls };
}

/**
 * A recorded argv with its `-L <socket>` prefix removed.
 *
 * Assertions about WHAT the backend asked tmux read better without it; that the
 * prefix is there on every single call is asserted once, on its own, below.
 */
function subcommand(call: readonly string[]): string[] {
  return call[0] === '-L' ? call.slice(2) : [...call];
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function readFileOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

/** Wait until a file's contents stop being empty, then return them. */
function waitForContent(p: string, what: string): Promise<string> {
  return waitFor(async () => {
    const body = await readFileOrEmpty(p);
    return body === '' ? undefined : body;
  }, what);
}

/** `sh -c 'cat > <file>'`: an inert sink that turns typed text into a file. */
function sink(file: string): string[] {
  return ['sh', '-c', `cat > ${file}`];
}

/**
 * Take a socket's whole server down AND remove its socket file.
 *
 * Both halves. `kill-server` stops the processes but leaves the socket behind,
 * and one stale file per test in a shared `/tmp/tmux-<uid>/` is a leak that
 * every developer who ever runs this suite keeps. The path is asked of tmux
 * while there is still a server to answer, and only guessed (tmux's documented
 * default: `$TMUX_TMPDIR` or `/tmp`) when a test already took the server down.
 */
async function reapSocket(socket: string): Promise<void> {
  const shown = (await tmuxOrEmpty(socket, ['display-message', '-p', '#{socket_path}'])).trim();
  await tmuxOrEmpty(socket, ['kill-server']);
  const socketPath =
    shown !== ''
      ? shown
      : path.join(process.env['TMUX_TMPDIR'] ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket);
  await fs.rm(socketPath, { force: true });
}

afterEach(async () => {
  // Total per socket. Safe precisely because each socket is this suite's own.
  for (const s of sockets) await reapSocket(s);
  sockets = [];
  // On the shared socket, by exact name only.
  for (const s of sharedSessions) await sharedTmuxOrEmpty(['kill-session', '-t', `=${s}`]);
  sharedSessions = [];
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Sanitisation — pure, and the reason the rest of the file is safe
// ---------------------------------------------------------------------------

describe('sanitizeWindowName', () => {
  const legal = /^[A-Za-z0-9_-]+$/;

  it('keeps an already-safe name unchanged', () => {
    expect(sanitizeWindowName('crew-42_a')).toBe('crew-42_a');
  });

  it('replaces every target separator, collapsing runs', () => {
    expect(sanitizeWindowName('crew: fix the parser')).toBe('crew-fix-the-parser');
    expect(sanitizeWindowName('a.b:c')).toBe('a-b-c');
    expect(sanitizeWindowName('a...b')).toBe('a-b');
    expect(sanitizeWindowName('a   :::   b')).toBe('a-b');
    expect(sanitizeWindowName('a---b')).toBe('a-b');
  });

  it('never emits a ":" or a "." — the two characters that re-target', () => {
    for (const raw of ['a:b', 'a.b', '::..::', 'x:1.2', 'sess:win.pane']) {
      const out = sanitizeWindowName(raw);
      expect(out).not.toContain(':');
      expect(out).not.toContain('.');
      expect(out).toMatch(legal);
    }
  });

  it('survives a name that is PURE punctuation', () => {
    for (const raw of [':::', '...', '!!!', '  ', '', '::..::', '///', '$(){}[]|&;<>']) {
      const out = sanitizeWindowName(raw);
      expect(out).not.toBe('');
      expect(out).toMatch(legal);
    }
  });

  it('trims leading and trailing separators so a name never looks like a flag', () => {
    expect(sanitizeWindowName('  -crew-  ')).toBe('crew');
    expect(sanitizeWindowName('__x__')).toBe('x');
    expect(sanitizeWindowName('-')).toMatch(legal);
    expect(sanitizeWindowName('-')).not.toMatch(/^-/);
  });

  it('never returns an all-digit name, which tmux would read as a window index', () => {
    for (const raw of ['1', '42', '007', ':1:']) {
      expect(sanitizeWindowName(raw)).not.toMatch(/^[0-9]+$/);
    }
  });

  it('truncates, and still truncates once a uniqueness suffix is added', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeWindowName(long).length).toBeLessThanOrEqual(32);
    const collided = sanitizeWindowName(long, new Set([sanitizeWindowName(long)]));
    expect(collided.length).toBeLessThanOrEqual(32);
    expect(collided).not.toBe(sanitizeWindowName(long));
  });

  it('disambiguates against names already taken', () => {
    const taken = new Set(['crew', 'crew-2']);
    expect(sanitizeWindowName('crew', taken)).toBe('crew-3');
    // Distinct raw names that sanitise identically must still get distinct windows.
    expect(sanitizeWindowName('crew!!!', new Set(['crew']))).toBe('crew-2');
  });
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('available', () => {
  it('is true when tmux is installed', async () => {
    expect(await new TmuxBackend(names()).available()).toBe(true);
  });

  it('returns false rather than throwing when tmux is absent', async () => {
    const backend = new TmuxBackend({
      ...names(),
      tmuxPath: path.join(os.tmpdir(), `no-such-tmux-${randomUUID()}`),
    });
    await expect(backend.available()).resolves.toBe(false);
  });

  it('exports an install hint that names the fix', () => {
    expect(TMUX_INSTALL_HINT).toContain('brew install tmux');
  });
});

// ---------------------------------------------------------------------------
// The private socket — isolation in both directions
// ---------------------------------------------------------------------------

describe('the fleet has its own tmux server', () => {
  it('defaults to a named socket that is not the shared one', () => {
    // The default is what ships, so it is the default that has to be isolated:
    // an option nobody sets is not a fix. Constructed only — never launched
    // against, because that socket is where a real fleet would be flying.
    expect(new TmuxBackend().socket).toBe(DEFAULT_TMUX_SOCKET);
    expect(DEFAULT_TMUX_SOCKET).not.toBe(SHARED_TMUX_SOCKET);
    expect(SHARED_TMUX_SOCKET).toBe('default');
  });

  it('refuses a socket name that would escape tmux’s socket directory', () => {
    // A socket name is a filename appended to `<tmpdir>/tmux-<uid>/`.
    for (const bad of ['', 'a/b', '../elsewhere', '.', 'has space', 'a:b']) {
      expect(() => new TmuxBackend({ socket: bad })).toThrow(/invalid tmux socket name/);
    }
  });

  it(
    'puts EVERY tmux invocation on the socket — not most of them',
    async () => {
      // The failure mode this guards is worse than having no socket at all: one
      // unprefixed call addresses a different server, so a live worker reads as
      // dead, `kill()` reaps nothing and `list()` finds no orphans — three
      // symptoms that look like three unrelated bugs. Reading the file is not
      // proof; this is.
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const cwd = await tempDir();

      await backend.available();
      const ep = await backend.launch({ name: 'everything', cwd, argv: sink('out.txt') });
      await backend.sendText(ep.target, 'hello');
      await backend.sendKey(ep.target, 'Enter');
      await backend.alive(ep.target);
      await backend.describeEndpoint(ep.target);
      await backend.list();
      // A second launch BEFORE the kill, so the `new-window` branch is covered —
      // it is a different argv from `new-session` and could miss the flag alone,
      // and it only happens while a session already exists.
      await backend.launch({ name: 'second', cwd, argv: ['sleep', '600'] });
      await backend.kill(ep.target);
      // A diagnosis of the window just killed, which is the path that widens the
      // question to `list-sessions` — the one command that names no target and
      // would therefore go to whatever server it was pointed at.
      await backend.describeEndpoint(ep.target);
      await backend.list();

      expect(calls.length).toBeGreaterThan(8);
      const subcommands = new Set<string>();
      for (const call of calls) {
        expect(call.slice(0, 2), `unsocketed tmux call: ${call.join(' ')}`).toEqual(['-L', socket]);
        subcommands.add(subcommand(call)[0] ?? '');
      }
      // And the coverage is real: every subcommand this backend knows how to
      // issue appeared in the run above.
      expect([...subcommands].sort()).toEqual(
        [
          '-V',
          'has-session',
          'kill-window',
          'list-panes',
          'list-sessions',
          'list-windows',
          'new-session',
          'new-window',
          'send-keys',
        ].sort(),
      );
    },
    SLOW,
  );

  it(
    'is invisible on the shared socket, which is the whole point',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      await backend.launch({ name: 'hidden', cwd: await tempDir(), argv: ['sleep', '600'] });

      // Present here…
      expect(await backend.list()).toEqual([`${session}:hidden`]);
      // …and not on the socket a bare `tmux` command talks to.
      expect(await sharedSessionNames()).not.toContain(session);
    },
    SLOW,
  );

  it(
    'survives a kill-server aimed at somebody else’s tmux',
    async () => {
      // THE INCIDENT. `tmux kill-server` takes down a whole server and every
      // session on it, and it is one keystroke away from anybody debugging on
      // the same machine. Staged faithfully but safely: the bystander server is
      // a second private socket rather than the developer's real `default` one,
      // because the property under test is that kill-server is scoped to the
      // socket it is pointed at — which is exactly why the fleet now has one.
      const fleet = names();
      const backend = new TmuxBackend(fleet);
      const cwd = await tempDir();
      const ep = await backend.launch({ name: 'survivor', cwd, argv: sink('survivor.txt') });

      const bystander = socketName();
      await tmux(bystander, ['new-session', '-d', '-s', 'someone-else', '--', 'sleep', '600']);

      await tmux(bystander, ['kill-server']);
      await waitFor(
        async () =>
          (await tmuxOrEmpty(bystander, ['list-sessions'])) === '' ? true : undefined,
        'the bystander server to go down',
      );

      // The fleet did not notice.
      expect(await backend.alive(ep.target)).toBe(true);
      expect((await backend.describeEndpoint(ep.target)).state).toBe('running');
      expect(await backend.list()).toEqual([ep.target]);

      // And it is still addressable, not merely listed.
      await backend.sendText(ep.target, 'still-here');
      await backend.sendKey(ep.target, 'Enter');
      expect(await waitForContent(path.join(cwd, 'survivor.txt'), 'survivor.txt')).toBe(
        'still-here\n',
      );
    },
    SLOW,
  );

  it(
    'cannot reach the captain’s sessions when IT tears down',
    async () => {
      // The isolation runs both ways, and this is the half that protects the
      // human: BlueSpace killing its own windows must not touch anything else.
      const backend = new TmuxBackend(names());
      const cwd = await tempDir();
      const a = await backend.launch({ name: 'ours-a', cwd, argv: ['sleep', '600'] });
      const b = await backend.launch({ name: 'ours-b', cwd, argv: ['sleep', '600'] });

      const captain = socketName();
      const captainSession = unique();
      await tmux(captain, ['new-session', '-d', '-s', captainSession, '--', 'sleep', '600']);

      await backend.kill(a.target);
      await backend.kill(b.target);
      expect(await backend.list()).toEqual([]);

      expect((await tmux(captain, ['list-sessions', '-F', '#{session_name}'])).trim()).toBe(
        captainSession,
      );
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

describe('launch', () => {
  it(
    'creates the session on first use and adds windows after, with no caller-visible difference',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const cwd = await tempDir();

      const first = await backend.launch({ name: 'alpha', cwd, argv: ['sleep', '600'] });
      const second = await backend.launch({ name: 'bravo', cwd, argv: ['sleep', '600'] });

      expect(first.target).toBe(`${session}:alpha`);
      expect(second.target).toBe(`${session}:bravo`);
      expect(await backend.alive(first.target)).toBe(true);
      expect(await backend.alive(second.target)).toBe(true);

      // One session, two windows.
      const named = (await tmux(socket, ['list-sessions', '-F', '#{session_name}'])).split('\n');
      expect(named.filter((n) => n === session)).toHaveLength(1);
      expect(await backend.list()).toEqual([`${session}:alpha`, `${session}:bravo`]);
    },
    SLOW,
  );

  it(
    'launches in the requested cwd',
    async () => {
      const backend = new TmuxBackend(names());
      const cwd = await tempDir();
      // The sink redirects to a RELATIVE path, so the file can only land in the
      // process's actual working directory.
      const ep = await backend.launch({ name: 'worker', cwd, argv: sink('out.txt') });
      await backend.sendText(ep.target, 'in-the-worktree');
      await backend.sendKey(ep.target, 'Enter');

      expect(await waitForContent(path.join(cwd, 'out.txt'), 'out.txt')).toBe('in-the-worktree\n');
      expect(await pathExists(path.join(process.cwd(), 'out.txt'))).toBe(false);
    },
    SLOW,
  );

  it(
    'passes extra environment through to the launched process',
    async () => {
      const backend = new TmuxBackend(names());
      const cwd = await tempDir();
      await backend.launch({
        name: 'envtest',
        cwd,
        argv: ['sh', '-c', 'printf %s "$BLUE_TEST_VAR" > env.txt'],
        env: { BLUE_TEST_VAR: 'from-the-orchestrator', BLUE_TEST_UNSET: undefined },
      });
      expect(await waitForContent(path.join(cwd, 'env.txt'), 'env.txt')).toBe(
        'from-the-orchestrator',
      );
    },
    SLOW,
  );

  it(
    'sizes new sessions at 200x50, not tmux’s cramped 80x24 default',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const ep = await backend.launch({ name: 'big', cwd: await tempDir(), argv: ['sleep', '600'] });
      const size = (
        await tmux(socket, [
          'list-windows',
          '-t',
          `=${session}`,
          '-F',
          '#{window_width}x#{window_height}',
        ])
      ).trim();
      expect(size).toBe('200x50');
      expect(ep.target).toBe(`${session}:big`);
    },
    SLOW,
  );

  it(
    'honours a configured size, and later windows inherit it',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket, cols: 120, rows: 40 });
      await backend.launch({ name: 'one', cwd: await tempDir(), argv: ['sleep', '600'] });
      await backend.launch({ name: 'two', cwd: await tempDir(), argv: ['sleep', '600'] });
      const sizes = (
        await tmux(socket, [
          'list-windows',
          '-t',
          `=${session}`,
          '-F',
          '#{window_width}x#{window_height}',
        ])
      )
        .trim()
        .split('\n');
      expect(sizes).toEqual(['120x40', '120x40']);
    },
    SLOW,
  );

  it(
    'gives concurrent launches with the same name distinct, individually addressable windows',
    async () => {
      const backend = new TmuxBackend(names());
      const cwd = await tempDir();

      const [a, b, c] = await Promise.all([
        backend.launch({ name: 'crew: fix parser', cwd, argv: sink('a.txt') }),
        backend.launch({ name: 'crew: fix parser', cwd, argv: sink('b.txt') }),
        backend.launch({ name: 'crew: fix parser', cwd, argv: sink('c.txt') }),
      ]);

      const targets = [a.target, b.target, c.target];
      expect(new Set(targets).size).toBe(3);
      expect((await backend.list()).sort()).toEqual(targets.sort());

      // And the disambiguation is real addressing, not just distinct strings.
      await backend.sendText(b.target, 'only-b');
      await backend.sendKey(b.target, 'Enter');
      expect(await waitForContent(path.join(cwd, 'b.txt'), 'b.txt')).toBe('only-b\n');
      expect(await readFileOrEmpty(path.join(cwd, 'a.txt'))).toBe('');
      expect(await readFileOrEmpty(path.join(cwd, 'c.txt'))).toBe('');
    },
    SLOW,
  );

  it('rejects an empty argv rather than launching a bare shell', async () => {
    const backend = new TmuxBackend(names());
    await expect(backend.launch({ name: 'x', cwd: os.tmpdir(), argv: [] })).rejects.toThrow(
      /non-empty argv/,
    );
  });

  it('reports a missing tmux as unavailability, not as a mystery failure', async () => {
    const backend = new TmuxBackend({
      ...names(),
      tmuxPath: path.join(os.tmpdir(), `no-such-tmux-${randomUUID()}`),
    });
    await expect(
      backend.launch({ name: 'x', cwd: os.tmpdir(), argv: ['sleep', '600'] }),
    ).rejects.toBeInstanceOf(SessionBackendUnavailableError);
    await expect(
      backend.launch({ name: 'x', cwd: os.tmpdir(), argv: ['sleep', '600'] }),
    ).rejects.toThrow(/brew install tmux/);
  });

  it('refuses a session name that is itself a target separator hazard', () => {
    for (const bad of ['a:b', 'a.b', '', 'has space']) {
      expect(() => new TmuxBackend({ session: bad })).toThrow(/invalid tmux session name/);
    }
  });
});

// ---------------------------------------------------------------------------
// Addressing — the load-bearing part
// ---------------------------------------------------------------------------

describe('addressing', () => {
  it(
    'a name that sanitises to digits still addresses OUR window, not the window at that index',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const cwd = await tempDir();

      // Stage the hazard: something must already occupy window index 1.
      const alpha = await backend.launch({ name: 'alpha', cwd, argv: sink('alpha.txt') });
      const beta = await backend.launch({ name: 'beta', cwd, argv: sink('beta.txt') });
      const numeric = await backend.launch({ name: '1', cwd, argv: sink('numeric.txt') });

      // Unsanitised, the target would have been `<session>:1` — a window INDEX.
      expect(numeric.target).not.toBe(`${session}:1`);

      await backend.sendText(numeric.target, 'to-the-numeric-window');
      await backend.sendKey(numeric.target, 'Enter');

      expect(await waitForContent(path.join(cwd, 'numeric.txt'), 'numeric.txt')).toBe(
        'to-the-numeric-window\n',
      );
      expect(await readFileOrEmpty(path.join(cwd, 'alpha.txt'))).toBe('');
      expect(await readFileOrEmpty(path.join(cwd, 'beta.txt'))).toBe('');
      expect(alpha.target).not.toBe(beta.target);
    },
    SLOW,
  );

  it(
    'a dead window reads as gone, never as the live window whose name it prefixes',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const cwd = await tempDir();

      const long = await backend.launch({ name: 'abcdef', cwd, argv: sink('abcdef.txt') });
      const short = await backend.launch({ name: 'abc', cwd, argv: sink('abc.txt') });
      expect(short.target).toBe(`${session}:abc`);

      await backend.kill(short.target);
      await waitFor(
        async () => ((await backend.alive(short.target)) ? undefined : true),
        'abc to die',
      );

      // Without an exact-match target, tmux would resolve `abc` to `abcdef`.
      expect(await backend.alive(short.target)).toBe(false);
      await expect(backend.sendText(short.target, 'MISDELIVERED')).rejects.toBeInstanceOf(TmuxError);

      expect(await backend.alive(long.target)).toBe(true);
      expect(await readFileOrEmpty(path.join(cwd, 'abcdef.txt'))).toBe('');
    },
    SLOW,
  );

  it(
    'attachCommand is a real command that selects THAT worker’s window',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const cwd = await tempDir();

      const first = await backend.launch({ name: 'first', cwd, argv: ['sleep', '600'] });
      const wanted = await backend.launch({ name: 'wanted', cwd, argv: ['sleep', '600'] });

      // `-L` before the subcommand: it is a client flag, and a paste without it
      // goes to the shared server and reports a live worker missing.
      expect(wanted.attachCommand).toBe(`tmux -L ${socket} attach -t ${session}:=wanted`);

      // Make some OTHER window current, so "it was already selected" cannot
      // explain a pass.
      await tmux(socket, ['select-window', '-t', `${session}:=first`]);
      expect(await activeWindow(socket, session)).toBe('first');

      // A tmux client needs a tty. Host one in a pane of a throwaway session —
      // portable, unlike script(1), whose flags differ per platform. That host
      // lives on its OWN socket, so the attach really does have to cross from
      // one server to another, exactly as the captain's terminal does. $TMUX
      // must be unset or tmux refuses to nest.
      const control = socketName();
      await tmux(control, [
        'new-session',
        '-d',
        '-s',
        'host',
        '-n',
        'host',
        '-x',
        '200',
        '-y',
        '50',
        '-c',
        cwd,
        '--',
        'env',
        '-u',
        'TMUX',
        'sh',
        '-c',
        wanted.attachCommand,
      ]);

      const active = await waitFor(
        async () => {
          const name = await activeWindow(socket, session);
          return name === 'wanted' ? name : undefined;
        },
        'attachCommand to select the wanted window',
      );
      expect(active).toBe('wanted');
      expect(first.target).toBe(`${session}:first`);
    },
    SLOW,
  );

  it(
    'the same command WITHOUT the socket finds nothing — which is why the flag is in it',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const ep = await backend.launch({
        name: 'elsewhere',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });

      // Strip the `-L <socket>` out of the advertised command and it addresses
      // the shared server, where this session does not exist. Run as argv, and
      // only ever `has-session`: an attach without a tty would hang.
      const bare = ep.attachCommand.split(' ').filter((w) => w !== '-L' && w !== socket);
      expect(bare).toEqual(['tmux', 'attach', '-t', `${session}:=elsewhere`]);
      expect(await sharedSessionNames()).not.toContain(session);
      // The worker it would have failed to find is running the whole time.
      expect(await backend.alive(ep.target)).toBe(true);
    },
    SLOW,
  );

  it(
    'quotes a tmux path that would otherwise break the pasted command',
    async () => {
      const { session, socket } = names();
      // Real tmux does the work; only the *advertised* path has the space in it.
      const backend = new TmuxBackend({
        session,
        socket,
        tmuxPath: '/opt/my tmux/bin/tmux',
        runner: createTmuxRunner('tmux'),
      });
      const ep = await backend.launch({
        name: 'spaced',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });
      expect(ep.attachCommand).toBe(
        `'/opt/my tmux/bin/tmux' -L ${socket} attach -t ${session}:=spaced`,
      );
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// Liveness and teardown
// ---------------------------------------------------------------------------

describe('alive', () => {
  it(
    'is true for a running process and false once its window is gone',
    async () => {
      const backend = new TmuxBackend(names());
      const ep = await backend.launch({
        name: 'transient',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });
      expect(await backend.alive(ep.target)).toBe(true);

      await backend.kill(ep.target);
      expect(
        await waitFor(async () => ((await backend.alive(ep.target)) ? undefined : true), 'death'),
      ).toBe(true);
    },
    SLOW,
  );

  it(
    'is false for a window that still exists but holds a DEAD pane',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const ep = await backend.launch({
        name: 'zombie',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });

      // remain-on-exit keeps the window listed after its process ends — the
      // shape a user's own tmux.conf can hand us.
      await tmux(socket, ['set-window-option', '-t', `${session}:=zombie`, 'remain-on-exit', 'on']);
      await tmux(socket, ['respawn-window', '-k', '-t', `${session}:=zombie`, '--', 'true']);

      await waitFor(
        async () =>
          (
            await tmuxOrEmpty(socket, ['list-panes', '-t', `${session}:=zombie`, '-F', '#{pane_dead}'])
          ).trim() === '1'
            ? true
            : undefined,
        'the pane to die',
      );

      // The window is still listed…
      expect(await backend.list()).toContain(ep.target);
      // …but nothing is running in it.
      expect(await backend.alive(ep.target)).toBe(false);
    },
    SLOW,
  );

  it('is false, not an exception, for a session that never existed', async () => {
    const backend = new TmuxBackend(names());
    await expect(backend.alive(`${backend.session}:nobody`)).resolves.toBe(false);
  });

  it('is false, not an exception, when tmux itself is missing', async () => {
    const backend = new TmuxBackend({
      ...names(),
      tmuxPath: path.join(os.tmpdir(), `no-such-tmux-${randomUUID()}`),
    });
    await expect(backend.alive('whatever:window')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// describeEndpoint — the same death, with the reason kept
// ---------------------------------------------------------------------------

describe('describeEndpoint', () => {
  it(
    'says running, and costs exactly one tmux call to say it',
    async () => {
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const ep = await backend.launch({
        name: 'busy',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });

      calls.length = 0;
      const status = await backend.describeEndpoint(ep.target);
      expect(status.state).toBe('running');
      // The happy path is what polls every few seconds; it must not have grown a
      // second tmux spawn to carry a diagnosis nobody needs yet.
      expect(calls.map((c) => subcommand(c)[0])).toEqual(['list-panes']);
    },
    SLOW,
  );

  it(
    'tells a process that exited apart from a window that was closed',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const cwd = await tempDir();
      const exited = await backend.launch({ name: 'exited', cwd, argv: ['sleep', '600'] });
      const closed = await backend.launch({ name: 'closed', cwd, argv: ['sleep', '600'] });
      // A survivor, so killing `closed` cannot take the session with it.
      await backend.launch({ name: 'survivor', cwd, argv: ['sleep', '600'] });

      await tmux(socket, ['set-window-option', '-t', `${session}:=exited`, 'remain-on-exit', 'on']);
      await tmux(socket, ['respawn-window', '-k', '-t', `${session}:=exited`, '--', 'true']);
      await waitFor(
        async () => ((await backend.alive(exited.target)) ? undefined : true),
        'the pane to die',
      );
      await backend.kill(closed.target);

      const dead = await backend.describeEndpoint(exited.target);
      expect(dead.state).toBe('exited');
      expect(dead.reason).toContain(exited.target);

      const gone = await backend.describeEndpoint(closed.target);
      expect(gone.state).toBe('window-gone');
      expect(gone.reason).toContain(session);
      // The distinction is the point: these must not read the same to a human.
      expect(gone.reason).not.toBe(dead.reason);
    },
    SLOW,
  );

  it(
    'says session-gone when the whole session went but the server did not',
    async () => {
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const ep = await backend.launch({
        name: 'doomed',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });
      // Another session on the same socket keeps the server alive after ours
      // goes, which is what separates this case from the next one.
      await tmux(socket, ['new-session', '-d', '-s', 'bystander', '--', 'sleep', '600']);

      await tmux(socket, ['kill-session', '-t', `=${session}`]);

      const status = await backend.describeEndpoint(ep.target);
      expect(status.state).toBe('session-gone');
      expect(status.reason).toContain(session);
      expect(await backend.alive(ep.target)).toBe(false);
    },
    SLOW,
  );

  it(
    'says server-gone — the diagnosis a killed fleet never got',
    async () => {
      // The reported failure was `session ended before the Stop hook fired`,
      // which is what a crashed worker looks like too. This is the sentence that
      // would have named the cause instead.
      const { session, socket } = names();
      const backend = new TmuxBackend({ session, socket });
      const ep = await backend.launch({
        name: 'victim',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });

      await tmux(socket, ['kill-server']);

      const status = await backend.describeEndpoint(ep.target);
      expect(status.state).toBe('server-gone');
      // It has to name the socket, or the captain cannot go look.
      expect(status.reason).toContain(socket);
      expect(status.reason).toContain('kill-server');
      // And it must not overclaim: an empty server exits on its own, so
      // "somebody killed it" is a possibility, not a finding.
      expect(status.reason).toContain('last window');
      expect(await backend.alive(ep.target)).toBe(false);
    },
    SLOW,
  );

  it('says unavailable — which is evidence about tmux, not about the worker', async () => {
    const backend = new TmuxBackend({
      ...names(),
      tmuxPath: path.join(os.tmpdir(), `no-such-tmux-${randomUUID()}`),
    });
    const status = await backend.describeEndpoint('whatever:window');
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('brew install tmux');
  });

  it(
    'names the session in the TARGET, not the one this backend was configured with',
    async () => {
      // A target is a handle a caller kept, possibly from another backend. A
      // diagnosis naming the wrong session sends the captain to the wrong place.
      const backend = new TmuxBackend(names());
      await backend.launch({ name: 'anchor', cwd: await tempDir(), argv: ['sleep', '600'] });
      const status = await backend.describeEndpoint('some-other-session:win');
      expect(status.state).toBe('session-gone');
      expect(status.reason).toContain('some-other-session');
      expect(status.reason).not.toContain(backend.session);
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// The upgrade: a fleet already flying on the shared socket
// ---------------------------------------------------------------------------

describe('strandedOnSharedSocket', () => {
  it('is undefined when there is nothing over there', async () => {
    // The normal case, on every run but the first after an upgrade.
    await expect(new TmuxBackend(names()).strandedOnSharedSocket()).resolves.toBeUndefined();
  });

  it(
    'finds the workers a pre-socket build left running, and does not touch them',
    async () => {
      // What shipping this without a probe would do: these keep running, keep
      // spending the captain's quota, and are invisible to `list()` — so the
      // orphan reap never sees them and their tasks fail while the processes
      // behind them are alive.
      const session = unique();
      sharedSessions.push(session);
      const backend = new TmuxBackend({ session, socket: socketName() });
      const cwd = await tempDir();
      await sharedTmuxOrEmpty([
        'new-session', '-d', '-s', session, '-n', 'old-crew', '-c', cwd, '--', 'sleep', '600',
      ]);
      await sharedTmuxOrEmpty(['new-window', '-t', `${session}:`, '-n', 'old-sentinel', '-c', cwd, '--', 'sleep', '600']);

      // Invisible through the normal surface…
      expect(await backend.list()).toEqual([]);
      // …and named by the probe.
      const stranded = await backend.strandedOnSharedSocket();
      expect(stranded?.socket).toBe(SHARED_TMUX_SOCKET);
      expect(stranded?.session).toBe(session);
      expect([...(stranded?.windows ?? [])].sort()).toEqual(['old-crew', 'old-sentinel']);

      // The commands go to the shared socket, so they must carry NO `-L`.
      expect(stranded?.attachCommand).toBe(`tmux attach -t ${session}:`);
      expect(stranded?.killCommand).toBe(`tmux kill-session -t =${session}`);
      expect(stranded?.attachCommand).not.toContain('-L');

      // And nothing was killed. Reporting is the whole contract: on the shared
      // socket a session with this name is not provably BlueSpace's, and killing
      // tmux you do not own is the failure being fixed, not the fix.
      expect(await sharedSessionNames()).toContain(session);
      expect(
        (await sharedTmuxOrEmpty(['list-windows', '-t', `=${session}`, '-F', '#{window_name}']))
          .trim()
          .split('\n')
          .sort(),
      ).toEqual(['old-crew', 'old-sentinel']);
    },
    SLOW,
  );

  it('has nothing to say when the backend is itself on the shared socket', async () => {
    const backend = new TmuxBackend({ session: unique(), socket: SHARED_TMUX_SOCKET });
    await expect(backend.strandedOnSharedSocket()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('kill', () => {
  it(
    'is idempotent',
    async () => {
      const backend = new TmuxBackend(names());
      const ep = await backend.launch({
        name: 'doomed',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });

      await expect(backend.kill(ep.target)).resolves.toBeUndefined();
      await expect(backend.kill(ep.target)).resolves.toBeUndefined();
      await expect(backend.kill(`${backend.session}:never-existed`)).resolves.toBeUndefined();
      expect(await backend.alive(ep.target)).toBe(false);
    },
    SLOW,
  );

  it(
    'kills only the target window',
    async () => {
      const backend = new TmuxBackend(names());
      const cwd = await tempDir();
      const keep = await backend.launch({ name: 'keep', cwd, argv: ['sleep', '600'] });
      const drop = await backend.launch({ name: 'drop', cwd, argv: ['sleep', '600'] });

      await backend.kill(drop.target);

      expect(await backend.list()).toEqual([keep.target]);
      expect(await backend.alive(keep.target)).toBe(true);
    },
    SLOW,
  );
});

describe('list', () => {
  it('is empty when the session does not exist, rather than throwing', async () => {
    await expect(new TmuxBackend(names()).list()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No shell, ever
// ---------------------------------------------------------------------------

describe('hostile input never reaches a shell', () => {
  // Backticks, command substitution, expansion, quotes, a leading dash (which
  // tmux's own getopt would eat without `--`), and a newline.
  const HOSTILE =
    '-l -t evil `touch pwned1` $(touch pwned2) ${HOME} "dq" \'sq\' a|b&c>d <e *? ;rm -rf /\n' +
    'second line & still literal';

  it(
    'types a hostile brief literally, byte for byte, and executes none of it',
    async () => {
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const cwd = await tempDir();

      const ep = await backend.launch({ name: 'crew: hostile brief', cwd, argv: sink('typed.txt') });
      await backend.sendText(ep.target, HOSTILE);
      await backend.sendKey(ep.target, 'Enter');

      const typed = await waitFor(async () => {
        const body = await readFileOrEmpty(path.join(cwd, 'typed.txt'));
        return body.endsWith('literal\n') ? body : undefined;
      }, 'the hostile text to arrive');

      // 1. It arrived exactly as typed — nothing expanded, nothing stripped.
      expect(typed).toBe(`${HOSTILE}\n`);

      // 2. Nothing ran it. A single shell anywhere on the path creates these.
      expect(await pathExists(path.join(cwd, 'pwned1'))).toBe(false);
      expect(await pathExists(path.join(cwd, 'pwned2'))).toBe(false);
      expect(await fs.readdir(cwd)).toEqual(['typed.txt']);

      // 3. The endpoint is unharmed: `;rm -rf /` was data, not a command.
      expect(await backend.alive(ep.target)).toBe(true);

      // 4. The seam: the payload travelled as ONE argv element, fenced by `--`,
      //    on the fleet's own socket.
      const send = calls.find((c) => subcommand(c)[0] === 'send-keys' && c.includes('-l'));
      expect(send).toEqual([
        '-L',
        socket,
        'send-keys',
        '-t',
        `${session}:=crew-hostile-brief`,
        '-l',
        '--',
        HOSTILE,
      ]);
    },
    SLOW,
  );

  it(
    'passes a hostile argv element to the program as one argument',
    async () => {
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const cwd = await tempDir();

      // $1 is written out verbatim; if anything shelled it, this file differs.
      const payload = '`touch argv-pwned`; $(touch argv-pwned2) "x" \'y\' & | > <';
      await backend.launch({
        name: 'argv',
        cwd,
        argv: ['sh', '-c', 'printf %s "$1" > argv.txt', 'sh', payload],
      });

      expect(await waitForContent(path.join(cwd, 'argv.txt'), 'argv.txt')).toBe(payload);
      expect(await pathExists(path.join(cwd, 'argv-pwned'))).toBe(false);
      expect(await pathExists(path.join(cwd, 'argv-pwned2'))).toBe(false);

      const create = calls
        .map(subcommand)
        .find((c) => c[0] === 'new-session' || c[0] === 'new-window');
      expect(create).toBeDefined();
      expect(create).toContain(payload);
      // `--` must precede the payload, or tmux would parse a leading dash itself.
      const fence = create?.indexOf('--') ?? -1;
      expect(fence).toBeGreaterThan(-1);
      expect(create?.indexOf(payload)).toBeGreaterThan(fence);
    },
    SLOW,
  );

  it(
    'sends a plain key as a key NAME, never as literal text',
    async () => {
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const cwd = await tempDir();
      const ep = await backend.launch({ name: 'keys', cwd, argv: sink('keys.txt') });

      await backend.sendText(ep.target, 'Escape');
      await backend.sendKey(ep.target, 'Enter');

      // The word "Escape" was typed; the Enter was a keypress that submitted it.
      expect(await waitForContent(path.join(cwd, 'keys.txt'), 'keys.txt')).toBe('Escape\n');
      expect(calls).toContainEqual(['-L', socket, 'send-keys', '-t', `${session}:=keys`, 'Enter']);
    },
    SLOW,
  );

  it('never spawns a shell: every recorded argv is the socket plus a tmux subcommand', async () => {
    const { backend, calls } = recording(names());
    await backend.available();
    await backend.list();
    await backend.alive('x:y');
    await backend.kill('x:y');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toBe('-L');
      expect(subcommand(call)[0]).toMatch(
        /^(-V|has-session|list-sessions|list-windows|list-panes|kill-window|send-keys)$/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The command-length ceiling
// ---------------------------------------------------------------------------

describe('chunkByBytes', () => {
  it('measures in BYTES, because that is what tmux counts', () => {
    // The trap this exists for: `String.length` says 4, tmux charges 12. A
    // Chinese brief budgeted by character count is three times over the wall.
    expect(chunkByBytes('舰长舰长', 6)).toEqual(['舰长', '舰长']);
    expect(chunkByBytes('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });

  it('never cuts a character in half, however the budget falls', () => {
    // Half a UTF-8 sequence reaches the pane as a replacement character. It
    // would corrupt exactly the briefs least likely to be read by whoever ends
    // up debugging it, and it would do so silently.
    const text = 'a舰b长c指d挥e';
    for (let budget = 1; budget <= 40; budget++) {
      // A 3-byte character cannot be carried by a 1- or 2-byte budget at all;
      // below the widest character there is no correct answer to give.
      if (budget < 3) continue;
      const pieces = chunkByBytes(text, budget);
      expect(pieces.join(''), `budget ${budget} lost or reordered text`).toBe(text);
      for (const piece of pieces) {
        expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(budget);
        expect(piece, `budget ${budget} split a character`).not.toContain('�');
      }
    }
  });

  it('does not chunk what already fits, and has nothing to say about empty', () => {
    expect(chunkByBytes('short', 1_000)).toEqual(['short']);
    expect(chunkByBytes('', 1_000)).toEqual([]);
  });
});

describe('the tmux command ceiling', () => {
  it(
    'is still where TMUX_MAX_COMMAND_BYTES says it is, and the socket flag does not move it',
    async () => {
      // THE RE-MEASUREMENT. The constant is an empirical fact about a tmux
      // build, and this is what turns a tmux upgrade that moves it into a failing
      // test rather than a fleet that stops launching. Deliberately run against
      // the RAW runner, not the backend: the backend refuses before tmux is
      // asked, which is the whole point of it and would hide the wall.
      //
      // Run BOTH with and without `-L`, because `#assertFits` measures the
      // subcommand only and that is only correct if the flag is free. It is:
      // `-L` is consumed by the client to find a socket and never reaches the
      // message the server is sent.
      const { session, socket } = names();
      const cwd = await tempDir();
      const run = createTmuxRunner('tmux');

      const command = (payloadBytes: number): string[] => [
        'new-session', '-d', '-s', session, '-n', 'w', '-c', cwd,
        '-P', '-F', '#{window_name}', '--', '/bin/echo', 'x'.repeat(payloadBytes),
      ];
      /** Pad the payload so the whole command weighs exactly `total` bytes. */
      const atExactly = (total: number): string[] => {
        const overhead = tmuxCommandBytes(command(0));
        return command(total - overhead);
      };

      expect(tmuxCommandBytes(atExactly(TMUX_MAX_COMMAND_BYTES))).toBe(TMUX_MAX_COMMAND_BYTES);

      const atLimit = await run(['-L', socket, ...atExactly(TMUX_MAX_COMMAND_BYTES)]);
      expect(atLimit.exitCode, 'tmux refused a command the constant says it accepts').toBe(0);
      await tmuxOrEmpty(socket, ['kill-session', '-t', `=${session}`]);

      const overLimit = await run(['-L', socket, ...atExactly(TMUX_MAX_COMMAND_BYTES + 1)]);
      expect(overLimit.exitCode, 'tmux accepted a command the constant says it refuses').not.toBe(0);

      // The prefix is free: a 60-character socket name buys no less room. This
      // is what licenses `#assertFits` to ignore it.
      const long = unique().padEnd(60, 'x').slice(0, 60);
      sockets.push(long);
      const wide = await run(['-L', long, ...atExactly(TMUX_MAX_COMMAND_BYTES)]);
      expect(wide.exitCode, 'a long socket name ate into the command ceiling').toBe(0);

      // And this is the diagnosis being replaced: whatever tmux says here, it
      // names no argument and no size. Recorded so the comparison is visible.
      expect(overLimit.stderr.trim().length).toBeGreaterThan(0);
      expect(overLimit.stderr).not.toMatch(/\d{4}/);
    },
    SLOW,
  );

  it('keeps a margin under the wall rather than launching right up to it', () => {
    expect(TMUX_COMMAND_BUDGET_BYTES).toBeLessThan(TMUX_MAX_COMMAND_BYTES);
    expect(new TmuxBackend({ session: 'x' }).maxCommandBytes).toBe(TMUX_COMMAND_BUDGET_BYTES);
  });

  it(
    'refuses an oversized launch itself, and never asks tmux',
    async () => {
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const cwd = await tempDir();

      const err = await backend
        .launch({ name: 'huge', cwd, argv: ['/bin/echo', 'x'.repeat(TMUX_MAX_COMMAND_BYTES)] })
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );

      expect(err).toBeInstanceOf(TmuxCommandTooLongError);
      // Position and size — the two things `command too long` withholds.
      expect(err?.message).toMatch(/argv\[\d+\]/);
      expect(err?.message).toMatch(/16,364/);
      // And the diagnosis that must not come back: this is tmux's ceiling, not
      // the kernel's. ARG_MAX is 1 MiB and was never what refused anything here.
      expect(err?.message).toMatch(/ARG_MAX/);

      // Nothing was created, and tmux was never asked to try.
      expect(
        calls.map(subcommand).some((c) => c[0] === 'new-session' || c[0] === 'new-window'),
      ).toBe(false);
      expect(await backend.list()).toEqual([]);
    },
    SLOW,
  );

  it(
    'delivers a message far larger than one tmux command can carry',
    async () => {
      // The rework path. A verdict's `reasoning` and `unmet` are model output and
      // are quoted back into a live session, so this used to die on exactly the
      // same wall the launch did — with the same useless `command too long`.
      const { session, socket } = names();
      const { backend, calls } = recording({ session, socket });
      const cwd = await tempDir();

      // A RAW-MODE reader, not `cat`. Measured: a pane's tty in canonical mode
      // silently discards a line past MAX_CANON, so a `cat` sink would report
      // this feature broken when it works, or working when it does not.
      const reader = path.join(cwd, 'reader.mjs');
      const sinkFile = path.join(cwd, 'typed.txt');
      const readyFile = path.join(cwd, 'reader-ready');
      await fs.writeFile(
        reader,
        `import { appendFileSync, writeFileSync } from 'node:fs';\n` +
          `process.stdin.setRawMode(true);\n` +
          `process.stdin.on('data', (b) => appendFileSync(${JSON.stringify(sinkFile)}, b));\n` +
          // Announced only once stdin is actually being read. Typing before that
          // races the pty's own buffer, and the bytes that lose the race are
          // simply gone — which would make this test flaky in the one direction
          // that matters, reporting a delivery bug that is not there.
          `writeFileSync(${JSON.stringify(readyFile)}, 'ok');\n` +
          `setInterval(() => {}, 1 << 30);\n`,
      );

      const ep = await backend.launch({
        name: 'chunked',
        cwd,
        argv: [process.execPath, reader],
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      });
      await waitFor(
        async () => ((await pathExists(readyFile)) ? true : undefined),
        'the raw-mode reader to start',
      );

      // Mixed script on purpose: a byte ceiling and a character count disagree
      // most where a brief is not English.
      const unit = 'REWORK 舰长 requirement not met — ';
      const message = unit.repeat(3_000);
      expect(Buffer.byteLength(message, 'utf8')).toBeGreaterThan(TMUX_MAX_COMMAND_BYTES * 5);

      await backend.sendText(ep.target, message);

      const typed = await waitFor(async () => {
        const body = await readFileOrEmpty(sinkFile);
        return Buffer.byteLength(body, 'utf8') >= Buffer.byteLength(message, 'utf8')
          ? body
          : undefined;
      }, 'the chunked message to arrive');

      // BYTE FOR BYTE. A dropped or reordered chunk is a Crew acting on half an
      // instruction, which is worse than the failure this replaces.
      expect(typed).toBe(message);

      // It really was split, and every piece really was under the ceiling — the
      // subcommand, which is what tmux packs; the socket prefix is the client's.
      const sends = calls.map(subcommand).filter((c) => c[0] === 'send-keys' && c.includes('-l'));
      expect(sends.length).toBeGreaterThan(1);
      for (const send of sends) {
        expect(tmuxCommandBytes(send)).toBeLessThanOrEqual(TMUX_COMMAND_BUDGET_BYTES);
      }
      // Nothing was submitted along the way: a stray Enter between chunks would
      // send the first fragment as a whole turn.
      expect(calls.map(subcommand).some((c) => c[0] === 'send-keys' && c.includes('Enter'))).toBe(
        false,
      );
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// The one rule
// ---------------------------------------------------------------------------

describe('the one rule', () => {
  it('the implementation contains no way to read what a worker rendered', async () => {
    const source = await fs.readFile(
      new URL('../src/session/tmux.ts', import.meta.url),
      'utf8',
    );
    // Deliberately unstripped, prose included: the header describes the rule
    // without ever naming a capture subcommand, so any occurrence at all — in a
    // comment as much as in a call — means someone is contemplating one.
    for (const forbidden of ['capture-pane', 'capturep', 'pipe-pane', 'save-buffer']) {
      expect(source.includes(`'${forbidden}'`)).toBe(false);
      expect(source.includes(`"${forbidden}"`)).toBe(false);
    }
    expect(source).not.toContain('capture-pane');
  });
});

// ---------------------------------------------------------------------------

async function activeWindow(socket: string, session: string): Promise<string> {
  const out = await tmux(socket, [
    'list-windows',
    '-t',
    `=${session}`,
    '-F',
    '#{window_active} #{window_name}',
  ]);
  for (const line of out.split('\n')) {
    if (line.startsWith('1 ')) return line.slice(2).trim();
  }
  return '';
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
