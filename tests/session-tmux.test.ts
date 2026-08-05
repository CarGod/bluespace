/**
 * tmux session backend tests.
 *
 * These drive a REAL tmux server — no mocks, no fake runner. The properties
 * this backend claims are all about what tmux actually does with a target
 * string, and tmux is the only authority on that; a mock would only ever
 * confirm my reading of the manual.
 *
 * Two conventions keep the suite from wedging a developer's machine:
 *   - every backend gets a session name unique to this process, so a failing
 *     test can never collide with (or reap) another test's session;
 *   - `afterEach` kills every session any test touched, including the control
 *     sessions used to host a tmux client.
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
  TMUX_INSTALL_HINT,
  TmuxBackend,
  TmuxError,
  createTmuxRunner,
  sanitizeWindowName,
  type TmuxRunner,
} from '../src/session/tmux.js';

const execFileAsync = promisify(execFile);

/** Generous: these tests start processes and poll for their side effects. */
const SLOW = 30_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Sessions to reap in afterEach, whoever created them. */
let sessions: string[] = [];
let tmpDirs: string[] = [];

function sessionName(): string {
  const name = `bluetest-${process.pid}-${randomUUID().slice(0, 8)}`;
  sessions.push(name);
  return name;
}

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-tmux-')));
  tmpDirs.push(dir);
  return dir;
}

/** Direct tmux, bypassing the backend — used to observe and to stage hazards. */
async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function tmuxOrEmpty(args: string[]): Promise<string> {
  try {
    return await tmux(args);
  } catch {
    return '';
  }
}

/** A backend that records every argv it hands to tmux, then really runs it. */
function recording(opts: { session: string; cols?: number; rows?: number }): {
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

afterEach(async () => {
  for (const s of sessions) await tmuxOrEmpty(['kill-session', '-t', `=${s}`]);
  sessions = [];
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
    expect(await new TmuxBackend({ session: sessionName() }).available()).toBe(true);
  });

  it('returns false rather than throwing when tmux is absent', async () => {
    const backend = new TmuxBackend({
      session: sessionName(),
      tmuxPath: path.join(os.tmpdir(), `no-such-tmux-${randomUUID()}`),
    });
    await expect(backend.available()).resolves.toBe(false);
  });

  it('exports an install hint that names the fix', () => {
    expect(TMUX_INSTALL_HINT).toContain('brew install tmux');
  });
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

describe('launch', () => {
  it(
    'creates the session on first use and adds windows after, with no caller-visible difference',
    async () => {
      const session = sessionName();
      const backend = new TmuxBackend({ session });
      const cwd = await tempDir();

      const first = await backend.launch({ name: 'alpha', cwd, argv: ['sleep', '600'] });
      const second = await backend.launch({ name: 'bravo', cwd, argv: ['sleep', '600'] });

      expect(first.target).toBe(`${session}:alpha`);
      expect(second.target).toBe(`${session}:bravo`);
      expect(await backend.alive(first.target)).toBe(true);
      expect(await backend.alive(second.target)).toBe(true);

      // One session, two windows.
      const named = (await tmux(['list-sessions', '-F', '#{session_name}'])).split('\n');
      expect(named.filter((n) => n === session)).toHaveLength(1);
      expect(await backend.list()).toEqual([`${session}:alpha`, `${session}:bravo`]);
    },
    SLOW,
  );

  it(
    'launches in the requested cwd',
    async () => {
      const backend = new TmuxBackend({ session: sessionName() });
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
      const backend = new TmuxBackend({ session: sessionName() });
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
      const session = sessionName();
      const backend = new TmuxBackend({ session });
      const ep = await backend.launch({ name: 'big', cwd: await tempDir(), argv: ['sleep', '600'] });
      const size = (
        await tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_width}x#{window_height}'])
      ).trim();
      expect(size).toBe('200x50');
      expect(ep.target).toBe(`${session}:big`);
    },
    SLOW,
  );

  it(
    'honours a configured size, and later windows inherit it',
    async () => {
      const session = sessionName();
      const backend = new TmuxBackend({ session, cols: 120, rows: 40 });
      await backend.launch({ name: 'one', cwd: await tempDir(), argv: ['sleep', '600'] });
      await backend.launch({ name: 'two', cwd: await tempDir(), argv: ['sleep', '600'] });
      const sizes = (
        await tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_width}x#{window_height}'])
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
      const session = sessionName();
      const backend = new TmuxBackend({ session });
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
    const backend = new TmuxBackend({ session: sessionName() });
    await expect(backend.launch({ name: 'x', cwd: os.tmpdir(), argv: [] })).rejects.toThrow(
      /non-empty argv/,
    );
  });

  it('reports a missing tmux as unavailability, not as a mystery failure', async () => {
    const backend = new TmuxBackend({
      session: sessionName(),
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
      const session = sessionName();
      const backend = new TmuxBackend({ session });
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
      const session = sessionName();
      const backend = new TmuxBackend({ session });
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
      const session = sessionName();
      const backend = new TmuxBackend({ session });
      const cwd = await tempDir();

      const first = await backend.launch({ name: 'first', cwd, argv: ['sleep', '600'] });
      const wanted = await backend.launch({ name: 'wanted', cwd, argv: ['sleep', '600'] });

      expect(wanted.attachCommand).toBe(`tmux attach -t ${session}:=wanted`);

      // Make some OTHER window current, so "it was already selected" cannot
      // explain a pass.
      await tmux(['select-window', '-t', `${session}:=first`]);
      expect(await activeWindow(session)).toBe('first');

      // A tmux client needs a tty. Host one in a pane of a throwaway session —
      // portable, unlike script(1), whose flags differ per platform. $TMUX must
      // be unset or tmux refuses to nest.
      const control = sessionName();
      await tmux([
        'new-session',
        '-d',
        '-s',
        control,
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
          const name = await activeWindow(session);
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
    'quotes a tmux path that would otherwise break the pasted command',
    async () => {
      const session = sessionName();
      // Real tmux does the work; only the *advertised* path has the space in it.
      const backend = new TmuxBackend({
        session,
        tmuxPath: '/opt/my tmux/bin/tmux',
        runner: createTmuxRunner('tmux'),
      });
      const ep = await backend.launch({
        name: 'spaced',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });
      expect(ep.attachCommand).toBe(`'/opt/my tmux/bin/tmux' attach -t ${session}:=spaced`);
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
      const backend = new TmuxBackend({ session: sessionName() });
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
      const session = sessionName();
      const backend = new TmuxBackend({ session });
      const ep = await backend.launch({
        name: 'zombie',
        cwd: await tempDir(),
        argv: ['sleep', '600'],
      });

      // remain-on-exit keeps the window listed after its process ends — the
      // shape a user's own tmux.conf can hand us.
      await tmux(['set-window-option', '-t', `${session}:=zombie`, 'remain-on-exit', 'on']);
      await tmux(['respawn-window', '-k', '-t', `${session}:=zombie`, '--', 'true']);

      await waitFor(
        async () =>
          (await tmuxOrEmpty(['list-panes', '-t', `${session}:=zombie`, '-F', '#{pane_dead}']))
            .trim() === '1'
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
    const backend = new TmuxBackend({ session: sessionName() });
    await expect(backend.alive(`${backend.session}:nobody`)).resolves.toBe(false);
  });

  it('is false, not an exception, when tmux itself is missing', async () => {
    const backend = new TmuxBackend({
      session: sessionName(),
      tmuxPath: path.join(os.tmpdir(), `no-such-tmux-${randomUUID()}`),
    });
    await expect(backend.alive('whatever:window')).resolves.toBe(false);
  });
});

describe('kill', () => {
  it(
    'is idempotent',
    async () => {
      const backend = new TmuxBackend({ session: sessionName() });
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
      const backend = new TmuxBackend({ session: sessionName() });
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
    await expect(new TmuxBackend({ session: sessionName() }).list()).resolves.toEqual([]);
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
      const session = sessionName();
      const { backend, calls } = recording({ session });
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

      // 4. The seam: the payload travelled as ONE argv element, fenced by `--`.
      const send = calls.find((c) => c[0] === 'send-keys' && c.includes('-l'));
      expect(send).toEqual(['send-keys', '-t', `${session}:=crew-hostile-brief`, '-l', '--', HOSTILE]);
    },
    SLOW,
  );

  it(
    'passes a hostile argv element to the program as one argument',
    async () => {
      const session = sessionName();
      const { backend, calls } = recording({ session });
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

      const create = calls.find((c) => c[0] === 'new-session' || c[0] === 'new-window');
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
      const session = sessionName();
      const { backend, calls } = recording({ session });
      const cwd = await tempDir();
      const ep = await backend.launch({ name: 'keys', cwd, argv: sink('keys.txt') });

      await backend.sendText(ep.target, 'Escape');
      await backend.sendKey(ep.target, 'Enter');

      // The word "Escape" was typed; the Enter was a keypress that submitted it.
      expect(await waitForContent(path.join(cwd, 'keys.txt'), 'keys.txt')).toBe('Escape\n');
      expect(calls).toContainEqual(['send-keys', '-t', `${session}:=keys`, 'Enter']);
    },
    SLOW,
  );

  it('never spawns a shell: every recorded argv starts with a tmux subcommand', async () => {
    const { backend, calls } = recording({ session: sessionName() });
    await backend.available();
    await backend.list();
    await backend.alive('x:y');
    await backend.kill('x:y');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[0]).toMatch(/^(-V|has-session|list-windows|list-panes|kill-window|send-keys)$/);
    }
  });
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

async function activeWindow(session: string): Promise<string> {
  const out = await tmux([
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
