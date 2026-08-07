/**
 * ClaudeCliAdapter tests.
 *
 * These drive a REAL tmux server, because the thing under test is a protocol
 * between three processes — an adapter, a multiplexer, and a CLI — and a mocked
 * multiplexer would only ever confirm my reading of the manual (same reasoning
 * as tests/session-tmux.test.ts).
 *
 * WHAT IS NEVER LAUNCHED IS `claude`. It costs real money and it is not what
 * these tests are about. In its place is `fake-claude.mjs`, written to a temp
 * dir by `setup()` below: it records the argv it was given, runs the SessionStart
 * and Stop hook commands out of the inline `--settings` JSON exactly as the real
 * CLI would, treats each line arriving on its stdin as a submitted turn, and
 * writes transcript JSONL where the reader will look for it. Every claim these
 * tests make about the real CLI is claimed instead by docs/compliance.md and
 * tests/compliance-smoke.ts, which is where empirical verification belongs.
 *
 * Nothing here reads rendered terminal content. Where a test needs to prove that
 * text arrived, the launched program writes it to a FILE and the test reads that.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ClaudeCliAdapter,
  LaunchTooLargeError,
  SessionNotReadyError,
  assertLaunchFits,
  buildLaunchArgv,
  buildRunSettings,
  launchArgvBytes,
  promptPointer,
  structuredOutputInstruction,
  validateAgainstSchema,
  SUBMIT_SETTLE_MS,
} from '../src/adapters/claude-cli.js';
import { UnsupportedCapabilityError, type AdapterEvent } from '../src/adapters/types.js';
import { TMUX_COMMAND_BUDGET_BYTES, TmuxBackend, TmuxError } from '../src/session/tmux.js';
import { VERDICT_SCHEMA, type DispatchProfile } from '../src/types/domain.js';

const execFileAsync = promisify(execFile);

/** These start processes and poll for their side effects. */
const SLOW = 60_000;

// ---------------------------------------------------------------------------
// The stand-in for `claude`
// ---------------------------------------------------------------------------

/**
 * A `claude` that costs nothing.
 *
 * It emulates exactly the four behaviours the adapter depends on, and no others:
 * the positional prompt lands in argv, a submit is a line on stdin, the hooks in
 * the `--settings` FILE are commands run through a shell, and the session
 * survives its own Stop hook so a follow-up turn is possible.
 *
 * It reads `--settings` and `--append-system-prompt-file` from disk because that
 * is what the real CLI does with them, and because the whole point of passing
 * them as paths is that they are too big for a command line. A fake that still
 * accepted them inline would keep passing after a regression put them back.
 *
 * ONE DELIBERATE DIVERGENCE FROM THE REAL CLI: the fake starts turn one on the
 * Enter rather than on the positional prompt, which 2.1.222 submits by itself
 * (docs/compliance.md, "Verified against"). The fake keeps the old shape because
 * it makes the launch observable — the assertions below can prove the Enter
 * arrived AFTER SessionStart, which is the ordering the adapter must hold. The
 * turn count is identical either way; only the instant turn one begins differs.
 * Do NOT read this file as evidence about when the real CLI submits.
 *
 * Env knobs let one script cover every scenario:
 *   BLUE_ARGV_OUT        where to write the argv it was launched with
 *   BLUE_INPUT_OUT       append-log of timestamped lifecycle records
 *   BLUE_TRANSCRIPT_DIR  where to write `<session-id>.jsonl`
 *   BLUE_READY_DELAY_MS  how long to sit before firing SessionStart
 *   BLUE_NO_READY        never fire SessionStart at all
 *   BLUE_TURN_MS         how long a turn takes before Stop fires
 *   BLUE_VERDICT_<n>     what to write to the structured-output path on turn n
 *   BLUE_SUBAGENTS       delegate on every turn, into the sibling subagents dir
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const env = process.env;
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const log = (record) => appendFileSync(env.BLUE_INPUT_OUT, JSON.stringify({ t: Date.now(), ...record }) + '\\n');

writeFileSync(env.BLUE_ARGV_OUT, JSON.stringify(argv));
log({ event: 'start' });

// Both of these are PATHS now, and the real CLI reads them off disk. Reading
// them the same way is what keeps this fake honest about the change.
const readMaybe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const settings = JSON.parse(readMaybe(flag('--settings')) || '{}');
const appended = readMaybe(flag('--append-system-prompt-file'));

const runHook = (kind, payload) => {
  const command = settings?.hooks?.[kind]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== 'string') return;
  const child = execFile('/bin/sh', ['-c', command], () => {});
  if (payload !== undefined) child.stdin.write(payload);
  child.stdin.end();
};

if (env.BLUE_NO_READY !== '1') {
  setTimeout(() => { log({ event: 'ready' }); runHook('SessionStart'); }, Number(env.BLUE_READY_DELAY_MS ?? '0'));
}

const sessionId = flag('--session-id');
// Specifically the verdict file: the appended prompt can now name a prompt file
// too, and a looser pattern would pick whichever came first.
const outputPath = (appended.match(/\\/\\S+output\\.json/) ?? [])[0];

function transcript(turn) {
  if (turn > 1) {
    return JSON.stringify({
      type: 'assistant',
      sessionId,
      message: { id: 'msg_t' + turn, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'retried' }], usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'end_turn' },
    }) + '\\n';
  }
  return [
    { type: 'assistant', sessionId, message: { id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/x' } }], usage: { input_tokens: 1000, output_tokens: 500 }, stop_reason: 'tool_use' } },
    { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }] } },
    { type: 'assistant', sessionId, message: { id: 'msg_2', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 2000, output_tokens: 100 }, stop_reason: 'end_turn' } },
  ].map((r) => JSON.stringify(r)).join('\\n') + '\\n';
}

function tick(n) {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    message: { id: 'tick_' + n, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'tick ' + n }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use' },
  }) + '\\n';
}

function append(text) {
  if (!env.BLUE_TRANSCRIPT_DIR) return;
  mkdirSync(env.BLUE_TRANSCRIPT_DIR, { recursive: true });
  appendFileSync(join(env.BLUE_TRANSCRIPT_DIR, sessionId + '.jsonl'), text);
}

// Delegation, written where 2.1.222 writes it: a sibling directory named for
// the session, NOT inline in the session transcript.
function delegate(agent, outputTokens) {
  if (!env.BLUE_TRANSCRIPT_DIR) return;
  const dir = join(env.BLUE_TRANSCRIPT_DIR, sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'agent-' + agent + '.jsonl'), JSON.stringify({
    type: 'assistant',
    sessionId,
    isSidechain: true,
    message: { id: 'sub_' + agent + '_' + turn, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'delegated work' }], usage: { input_tokens: 0, output_tokens: outputTokens }, stop_reason: 'end_turn' },
  }) + '\\n');
}

let turn = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  turn += 1;
  log({ event: 'submit', turn, line });
  append(transcript(turn));
  if (env.BLUE_SUBAGENTS === '1') { delegate('a', 1000); delegate('b', 2000); }
  const verdict = env['BLUE_VERDICT_' + turn];
  if (verdict !== undefined && outputPath !== undefined) writeFileSync(outputPath, verdict);

  if (env.BLUE_NOTIFY_AFTER_MS) {
    setTimeout(() => {
      log({ event: 'notify' });
      runHook('Notification', JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: env.BLUE_NOTIFY_TYPE ?? 'permission_prompt',
        message: 'Claude needs your permission',
      }));
    }, Number(env.BLUE_NOTIFY_AFTER_MS));
  }
  const ticks = Number(env.BLUE_TICKS ?? '0');
  for (let i = 1; i <= ticks; i++) setTimeout(() => append(tick(i)), i * Number(env.BLUE_TICK_MS ?? '150'));

  setTimeout(() => { log({ event: 'stop', turn }); runHook('Stop'); }, Number(env.BLUE_TURN_MS ?? '200'));
});

// Never exits on its own: a real session outlives its Stop hook, which is what
// makes Session.send() a follow-up turn rather than a new run.
setInterval(() => {}, 1 << 30);
`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Sockets, not sessions. The backend puts the fleet on its own tmux server
 * (`tmux -L <name>`, see src/session/tmux.ts), so a `kill-session` on the shared
 * socket reaps nothing and every test here would leak a live worker onto the
 * REAL `bluespace` socket. Each test gets its own socket and afterEach takes the
 * whole server, which is only safe because the socket is this suite's own — the
 * same argument the backend itself makes.
 */
const sockets: string[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    // Asked while a server is still there to answer; tmux's own default when
    // the test already took it down. kill-server does not unlink the socket.
    const shown = await execFileAsync('tmux', ['-L', s, 'display-message', '-p', '#{socket_path}'])
      .then((r) => r.stdout.trim())
      .catch(() => '');
    await execFileAsync('tmux', ['-L', s, 'kill-server']).catch(() => undefined);
    const socketPath =
      shown !== '' ? shown : path.join(process.env['TMUX_TMPDIR'] ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, s);
    await fs.rm(socketPath, { force: true });
  }
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

interface Harness {
  adapter: ClaudeCliAdapter;
  backend: TmuxBackend;
  root: string;
  markerDir: string;
  transcriptRoot: string;
  transcriptDir: string;
  argvOut: string;
  inputOut: string;
  /** Everything the fake logged, oldest first. */
  log(): Promise<Array<Record<string, unknown>>>;
  argv(): Promise<string[]>;
  /** Run directories the adapter has created and not yet cleaned up. */
  runDirs(): Promise<string[]>;
  /** The value of a flag in the launch argv, asserted present exactly once. */
  flag(name: string): Promise<string>;
  /** Contents of the file a path-valued flag points at. */
  fileArg(name: string): Promise<string>;
}

async function setup(opts: {
  env?: Record<string, string>;
  readyTimeoutMs?: number;
  turnTimeoutMs?: number;
  blockedGraceMs?: number;
  structuredRetries?: number;
} = {}): Promise<Harness> {
  // realpath because macOS hands out /var/folders/... which is a symlink to
  // /private/var/...: the fake touches one spelling and we would stat the other.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-cli-')));
  tmpDirs.push(root);

  const fake = path.join(root, 'fake-claude.mjs');
  await fs.writeFile(fake, FAKE_CLAUDE, { mode: 0o755 });

  const markerDir = path.join(root, 'markers');
  const transcriptRoot = path.join(root, 'projects');
  const transcriptDir = path.join(transcriptRoot, 'proj-fake');
  await fs.mkdir(markerDir, { recursive: true });
  await fs.mkdir(transcriptRoot, { recursive: true });

  const argvOut = path.join(root, 'argv.json');
  const inputOut = path.join(root, 'input.log');
  await fs.writeFile(inputOut, '');

  const session = `bluetest-cli-${process.pid}-${randomUUID().slice(0, 8)}`;
  const socket = `bluetest-cli-${process.pid}-${randomUUID().slice(0, 8)}`;
  sockets.push(socket);
  const backend = new TmuxBackend({ session, socket });

  const adapter = new ClaudeCliAdapter({
    backend,
    claudePath: fake,
    markerDir,
    transcriptRoot,
    // The tmux server's environment is not this process's, so anything the fake
    // needs has to be named here — including PATH, for its `env node` shebang.
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      BLUE_ARGV_OUT: argvOut,
      BLUE_INPUT_OUT: inputOut,
      BLUE_TRANSCRIPT_DIR: transcriptDir,
      ...opts.env,
    },
    pollIntervalMs: 50,
    settleMs: 400,
    readyTimeoutMs: opts.readyTimeoutMs ?? 20_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? 30_000,
    transcriptTimeoutMs: 20_000,
    blockedGraceMs: opts.blockedGraceMs ?? 60_000,
    ...(opts.structuredRetries === undefined ? {} : { structuredRetries: opts.structuredRetries }),
  });

  return {
    adapter,
    backend,
    root,
    markerDir,
    transcriptRoot,
    transcriptDir,
    argvOut,
    inputOut,
    async log() {
      const body = await fs.readFile(inputOut, 'utf8').catch(() => '');
      return body
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    async argv() {
      return JSON.parse(await fs.readFile(argvOut, 'utf8')) as string[];
    },
    async runDirs() {
      return (await fs.readdir(markerDir).catch(() => [])).filter((n) => n.startsWith('blue-run-'));
    },
    async flag(name: string) {
      const argv = JSON.parse(await fs.readFile(argvOut, 'utf8')) as string[];
      const at = argv.indexOf(name);
      expect(at, `${name} missing from ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0);
      expect(argv.lastIndexOf(name), `${name} appears twice`).toBe(at);
      const value = argv[at + 1];
      expect(value, `${name} has no value`).toBeDefined();
      return value as string;
    },
    async fileArg(name: string) {
      const argv = JSON.parse(await fs.readFile(argvOut, 'utf8')) as string[];
      const at = argv.indexOf(name);
      expect(at, `${name} missing from ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0);
      return fs.readFile(argv[at + 1] as string, 'utf8');
    },
  };
}

const PROFILE: DispatchProfile = { permissionMode: 'auto' };

function collect(events: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  return (async () => {
    const out: AdapterEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  })();
}

async function waitFor(probe: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function exitOf(events: AdapterEvent[]): Extract<AdapterEvent, { type: 'exit' }> {
  const exits = events.filter((e): e is Extract<AdapterEvent, { type: 'exit' }> => e.type === 'exit');
  expect(exits, 'a session must produce exactly one exit event').toHaveLength(1);
  return exits[0] as Extract<AdapterEvent, { type: 'exit' }>;
}

// ---------------------------------------------------------------------------
// argv — the protocol, asserted element by element
// ---------------------------------------------------------------------------

describe('buildLaunchArgv', () => {
  it('produces the exact launch protocol, in order', () => {
    expect(
      buildLaunchArgv({
        claudePath: '/usr/local/bin/claude',
        sessionId: '11111111-2222-3333-4444-555555555555',
        profile: { permissionMode: 'auto', effort: 'high', model: 'claude-opus-5' },
        settingScopes: ['project', 'local'],
        systemPromptFile: '/run/system-prompt.md',
        settingsFile: '/run/settings.json',
        prompt: 'do the thing',
      }),
    ).toEqual([
      '/usr/local/bin/claude',
      '--session-id',
      '11111111-2222-3333-4444-555555555555',
      '--permission-mode',
      'auto',
      '--setting-sources',
      'project,local',
      // PATHS, not text. Both of these are unbounded inputs and the command line
      // is 16,364 bytes; see TMUX_MAX_COMMAND_BYTES.
      '--append-system-prompt-file',
      '/run/system-prompt.md',
      '--effort',
      'high',
      '--model',
      'claude-opus-5',
      '--settings',
      '/run/settings.json',
      'do the thing',
    ]);
  });

  it('never puts an unbounded input on the line, however big the inputs get', () => {
    // The regression, stated as a property rather than as a golden argv: the
    // system prompt and the settings are the two inputs that grow with a task
    // (a JSON Schema lives in the first, hooks in the second), and neither may
    // appear as text. A 112,680-byte prompt on this line is what killed a task.
    const argv = buildLaunchArgv({
      claudePath: 'claude',
      sessionId: 'id',
      profile: { permissionMode: 'auto' },
      settingScopes: [],
      systemPromptFile: '/run/system-prompt.md',
      settingsFile: '/run/settings.json',
      prompt: 'p',
    });
    expect(argv, 'the system prompt must travel as a file').not.toContain('--append-system-prompt');
    expect(argv).toContain('--append-system-prompt-file');
    // `--settings` takes "a file or a JSON string"; only the file form is bounded.
    expect(argv[argv.indexOf('--settings') + 1]).toBe('/run/settings.json');
  });

  it('passes --setting-sources with an EMPTY value for an empty scope list', () => {
    const argv = buildLaunchArgv({
      claudePath: 'claude',
      sessionId: 'id',
      profile: { permissionMode: 'auto' },
      settingScopes: [],
      systemPromptFile: '/run/system-prompt.md',
      settingsFile: '/run/settings.json',
      prompt: 'p',
    });

    // Verified on Claude Code 2.1.222: OMITTING the flag loads user+project+local,
    // so "no scopes" and "no flag" are opposites. A project-scoped SessionStart
    // hook fired with the flag absent and did not fire with an empty value. If
    // this ever becomes an omission, every Sentinel silently starts inheriting
    // the captain's CLAUDE.md — which is exactly the isolation it exists for.
    const at = argv.indexOf('--setting-sources');
    expect(at, '--setting-sources must always be passed').toBeGreaterThanOrEqual(0);
    expect(argv[at + 1]).toBe('');
  });

  it('omits --effort and --model unless the profile states them', () => {
    const argv = buildLaunchArgv({
      claudePath: 'claude',
      sessionId: 'id',
      profile: { permissionMode: 'plan' },
      settingScopes: ['user'],
      systemPromptFile: '/run/system-prompt.md',
      settingsFile: '/run/settings.json',
      prompt: 'p',
    });
    expect(argv).not.toContain('--effort');
    expect(argv).not.toContain('--model');
    expect(argv.at(-1)).toBe('p');
  });
});

// ---------------------------------------------------------------------------
// The line budget — BlueSpace's own diagnosis, in place of tmux's
// ---------------------------------------------------------------------------

describe('the launch line budget', () => {
  it('sizes an argv in BYTES, counting each element’s terminator', () => {
    // tmux packs argv NUL-terminated, so the unit is bytes and every element
    // costs one more than its own length. Measuring in `String.length` would
    // under-count a Chinese brief by a factor of three and pass a command tmux
    // then refuses.
    expect(launchArgvBytes(['ab', 'c'])).toBe(3 + 2);
    expect(launchArgvBytes(['舰长'])).toBe(6 + 1);
    expect(launchArgvBytes([])).toBe(0);
  });

  it('names WHICH input is oversized and how big it is, which tmux never does', () => {
    // The whole point. tmux answers `command too long` — no argument, no size,
    // nothing to act on — and a captain reading that learns only that BlueSpace
    // is broken.
    const err = (() => {
      try {
        assertLaunchFits(['claude', 'x'.repeat(50_000)], 15_340, [
          { label: 'the opening prompt', bytes: 50_000 },
          { label: 'the working directory', bytes: 40 },
        ]);
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(err, 'an oversized launch must be refused').toBeInstanceOf(LaunchTooLargeError);
    expect(err?.message).toContain('the opening prompt');
    expect(err?.message).toContain('50,000');
    expect(err?.message).toContain('15,340');
    // And it must not repeat the diagnosis that sent the last fix the wrong way.
    expect(err?.message).toMatch(/NOT the kernel's ARG_MAX/);
  });

  it('says nothing at all when the line fits', () => {
    expect(() => assertLaunchFits(['claude', 'small'], 15_340, [])).not.toThrow();
  });
});

describe('buildRunSettings', () => {
  it('scopes every hook to this run and quotes the marker paths', () => {
    const settings = JSON.parse(
      buildRunSettings({
        ready: "/tmp/it's here/ready",
        stop: '/tmp/x/stop',
        notify: '/tmp/x/notify.json',
      }),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };

    // A hook command is shell text by definition, so the one string this module
    // builds for a shell has to survive a quote in the path.
    expect(settings.hooks['SessionStart']?.[0]?.hooks[0]?.command).toBe(
      `touch '/tmp/it'\\''s here/ready'`,
    );
    expect(settings.hooks['Stop']?.[0]?.hooks[0]?.command).toBe(`touch '/tmp/x/stop'`);
    // `cat`, not `touch`: the payload carries notification_type, which is what
    // tells a permission prompt from an idle nudge.
    expect(settings.hooks['Notification']?.[0]?.hooks[0]?.command).toBe(
      `cat > '/tmp/x/notify.json'`,
    );
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('declares what an interactive session can and cannot do', () => {
    const adapter = new ClaudeCliAdapter({ claudePath: '/bin/true' });
    expect(adapter.capabilities).toEqual({
      interrupt: true,
      fork: false,
      cost: true,
      toolEvents: true,
      structuredOutput: true,
      steer: true,
      conversation: false,
    });
  });

  it('refuses to host a conversation instead of hosting a worse one', async () => {
    const adapter = new ClaudeCliAdapter({ claudePath: '/bin/true' });
    await expect(
      adapter.converse({
        systemPrompt: 'x',
        tools: [],
        profile: PROFILE,
        settingScopes: [],
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('refuses a resume rather than pretending to fork', async () => {
    const adapter = new ClaudeCliAdapter({ claudePath: '/bin/true' });
    await expect(
      adapter.spawn({
        cwd: os.tmpdir(),
        prompt: 'x',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
        resume: { sessionId: 'abc' },
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('rejects an empty prompt, which would submit an empty composer forever', async () => {
    const adapter = new ClaudeCliAdapter({ claudePath: '/bin/true' });
    await expect(
      adapter.spawn({
        cwd: os.tmpdir(),
        prompt: '   ',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      }),
    ).rejects.toThrow(/non-empty prompt/);
  });
});

// ---------------------------------------------------------------------------
// The launch, over real tmux
// ---------------------------------------------------------------------------

describe('spawn', () => {
  it(
    'launches with the protocol argv, fills the composer, and submits separately',
    async () => {
      const h = await setup({ env: { BLUE_READY_DELAY_MS: '900' } });

      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'fix the parser',
        profile: { permissionMode: 'auto', effort: 'low', model: 'claude-sonnet-5' },
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      const argv = await h.argv();
      const runDirs = await h.runDirs();
      expect(runDirs).toHaveLength(1);
      const runDir = path.join(h.markerDir, runDirs[0] as string);

      expect(argv.slice(0, 8)).toEqual([
        '--session-id',
        session.id,
        '--permission-mode',
        'auto',
        '--setting-sources',
        '',
        '--append-system-prompt-file',
        path.join(runDir, 'system-prompt.md'),
      ]);
      expect(argv.slice(8, 12)).toEqual(['--effort', 'low', '--model', 'claude-sonnet-5']);
      expect(argv[12]).toBe('--settings');
      expect(argv[13]).toBe(path.join(runDir, 'settings.json'));
      // THE COMPOSER: a brief this size still travels as the last positional and
      // nothing else. The file indirection is for prompts that do not fit, and
      // this one does — see the >100KB test below for the other half.
      expect(argv.at(-1)).toBe('fix the parser');
      // The appended system prompt is a file the CLI reads, and it holds what
      // used to sit on the line.
      expect(await h.fileArg('--append-system-prompt-file')).toBe('SYS');

      const settings = JSON.parse(await h.fileArg('--settings')) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(settings.hooks['SessionStart']?.[0]?.hooks[0]?.command).toContain(
        path.join(runDir, 'ready'),
      );
      expect(settings.hooks['Stop']?.[0]?.hooks[0]?.command).toContain('stop');

      // THE SUBMIT: one bare Enter, delivered as a keypress, AFTER the
      // SessionStart hook fired — never before. On the real CLI it is a no-op on
      // an already-submitted prompt; the ordering is what is asserted, and the
      // 900ms readiness delay is what makes it observable.
      await waitFor(async () => (await h.log()).some((r) => r['event'] === 'submit'), 'submit');
      const log = await h.log();
      const started = log.find((r) => r['event'] === 'start');
      const ready = log.find((r) => r['event'] === 'ready');
      const submit = log.find((r) => r['event'] === 'submit');
      expect(Number(ready?.['t']) - Number(started?.['t'])).toBeGreaterThanOrEqual(800);
      expect(Number(submit?.['t'])).toBeGreaterThanOrEqual(Number(ready?.['t']));
      // Empty, because the text was already in the composer.
      expect(submit?.['line']).toBe('');

      await session.close();
    },
    SLOW,
  );

  it(
    'never lets a hostile brief reach a shell',
    async () => {
      const h = await setup();
      const canary = path.join(h.root, 'pwned');
      const hostile = [
        `'; touch ${canary}; echo '`,
        '`touch ' + canary + '`',
        '$(touch ' + canary + ')',
        '$(echo nope) && rm -rf / #',
      ].join('\n');

      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: hostile,
        profile: PROFILE,
        settingScopes: ['project'],
        systemPromptAppend: 'SYS',
      });

      // One argv element, byte for byte, newlines and all. Nothing parsed it.
      const argv = await h.argv();
      expect(argv.at(-1)).toBe(hostile);
      expect(await fs.stat(canary).catch(() => undefined), 'a shell ran the brief').toBeUndefined();

      await session.close();
    },
    SLOW,
  );

  it(
    'launches a SENTINEL-SIZED prompt — the exact case that used to lose the task',
    async () => {
      // THE REGRESSION. A Sentinel's prompt is a brief plus an entire diff; the
      // one that died measured 112,680 bytes, against a tmux command ceiling of
      // 16,364. It failed with tmux's `command too long`, the rework respawn hit
      // the same wall, and 2.4M tokens produced nothing verified.
      const h = await setup();
      const diff = Array.from(
        { length: 2_000 },
        (_, i) => `+  const line${i} = doSomething(${i}); // 舰长 padding to make this a real size`,
      ).join('\n');
      const prompt = `Verify the work below.\n\n--- BEGIN DIFF ---\n${diff}\n--- END DIFF ---`;
      expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(100_000);

      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt,
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      // 1. It launched, and it ran a real turn. Building the argv is not the
      //    claim; reaching Stop through tmux is.
      const exit = exitOf(await collect(session.events()));
      expect(exit).toMatchObject({ ok: true });

      // 2. The line stayed small. This is the property, not the byte count: no
      //    element of it grows with the prompt.
      const argv = await h.argv();
      const runDir = path.join(h.markerDir, (await h.runDirs())[0] as string);
      expect(launchArgvBytes(argv)).toBeLessThan(TMUX_COMMAND_BUDGET_BYTES);

      // 3. The prompt is intact on disk — truncating it silently would be worse
      //    than the failure this replaces.
      const promptFile = path.join(runDir, 'prompt.md');
      expect(await fs.readFile(promptFile, 'utf8')).toBe(prompt);

      // 4. The positional points at it and carries no task of its own, so there
      //    is nothing for a worker to act on INSTEAD of reading the file.
      expect(argv.at(-1)).toBe(promptPointer(promptFile));
      expect(argv.at(-1)).toContain(promptFile);
      expect(argv.at(-1)).not.toContain('BEGIN DIFF');

      // 5. The SECOND CHANNEL. The system prompt is loaded by the CLI itself, so
      //    a worker that ignores the composer has still been told where its
      //    instructions are. This is what makes the file survivable.
      const appended = await h.fileArg('--append-system-prompt-file');
      expect(appended.startsWith('SYS')).toBe(true);
      expect(appended, 'a worker ignoring the positional must still be told').toContain(promptFile);

      // 6. And it can actually read it: the file is outside the worktree.
      expect(argv[argv.indexOf('--add-dir') + 1]).toBe(runDir);

      await session.close();
    },
    SLOW,
  );

  it(
    'refuses an oversized launch with ITS OWN diagnosis, never tmux’s',
    async () => {
      // `command too long` names no input, no size and no next move. The whole
      // value of budgeting before launch is the sentence that replaces it.
      const h = await setup();
      // The prompt can no longer overflow (it becomes a file), so this is the
      // other way the line grows: everything else on it at once.
      const absurdCwd = path.join(h.root, 'x'.repeat(TMUX_COMMAND_BUDGET_BYTES));

      const err = await h.adapter
        .spawn({
          cwd: absurdCwd,
          prompt: 'fix the parser',
          profile: PROFILE,
          settingScopes: [],
          systemPromptAppend: 'SYS',
        })
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );

      expect(err, 'an unlaunchable command must be refused').toBeInstanceOf(LaunchTooLargeError);
      // BlueSpace's words, naming a BlueSpace input and its size.
      expect(err?.message).toContain('the working directory');
      expect(err?.message).toMatch(/\d{2},\d{3} bytes/);
      // Not tmux's. If this ever reads `command too long`, the check has moved
      // back behind the launch and the diagnosis is gone again.
      expect(err?.message).not.toMatch(/command too long/i);
      expect(err).not.toBeInstanceOf(TmuxError);

      // And nothing was left behind: no window for the reaper, no run directory.
      expect(await h.backend.list()).toEqual([]);
      expect(await h.runDirs()).toEqual([]);
    },
    SLOW,
  );

  it(
    'surfaces a SessionStart hook that never fires as an error, not a hang',
    async () => {
      const h = await setup({ env: { BLUE_NO_READY: '1' }, readyTimeoutMs: 1_500 });

      const started = Date.now();
      await expect(
        h.adapter.spawn({
          cwd: h.root,
          prompt: 'never gets going',
          profile: PROFILE,
          settingScopes: [],
          systemPromptAppend: 'SYS',
        }),
      ).rejects.toBeInstanceOf(SessionNotReadyError);
      expect(Date.now() - started).toBeLessThan(15_000);

      // The failure names its likeliest cause. A bare timeout here reads as a
      // BlueSpace bug when it is almost always an unanswered trust prompt.
      await expect(
        h.adapter.spawn({
          cwd: h.root,
          prompt: 'never gets going',
          profile: PROFILE,
          settingScopes: [],
          systemPromptAppend: 'SYS',
        }),
      ).rejects.toThrow(/trust/i);

      // And it leaves nothing behind: no window for the reaper to puzzle over,
      // no marker directory nobody owns.
      expect(await h.backend.list()).toEqual([]);
      expect(await h.runDirs()).toEqual([]);
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

describe('events', () => {
  it(
    'maps the transcript, prices it, and ends on the Stop marker',
    async () => {
      const h = await setup();
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'fix the parser',
        profile: PROFILE,
        settingScopes: ['project'],
        systemPromptAppend: 'SYS',
      });

      // `-L <socket>` and all: the fleet is on its own tmux server, so a paste
      // without the flag goes to the shared one and reports a live worker gone.
      expect(session.attachCommand, 'blue ps has nothing to print without this').toMatch(
        /^tmux -L bluetest-cli-\S+ attach -t bluetest-cli-.*:=blue-/,
      );

      const events = await collect(session.events());
      const kinds = events.map((e) => e.type);

      expect(kinds[0]).toBe('session');
      expect(events[0]).toMatchObject({ type: 'session', sessionId: session.id });
      expect(kinds.filter((k) => k === 'session'), 'exactly one session event').toHaveLength(1);
      expect(events).toContainEqual({ type: 'text', text: 'working on it' });
      expect(events).toContainEqual({
        type: 'tool_use',
        toolUseId: 'tu_1',
        name: 'Read',
        input: { file_path: '/x' },
      });
      expect(events).toContainEqual({
        type: 'tool_result',
        toolUseId: 'tu_1',
        ok: true,
        result: 'file contents',
      });

      // THE ABORT CONTRACT. The reader holds a message's usage until something
      // proves it complete and flushes it on the way out — so the LAST message's
      // usage only survives if the consumer aborts instead of breaking. Two usage
      // events, not one, is the assertion that this adapter does that.
      const usage = events.filter((e) => e.type === 'usage');
      expect(usage, 'the final message usage was dropped — that is a dropped bill').toHaveLength(2);
      const total = usage.reduce((sum, e) => sum + (e.type === 'usage' ? e.costUsd : 0), 0);
      // claude-sonnet-5: $3/MTok in, $15/MTok out. 3000 in + 600 out.
      expect(total).toBeCloseTo(0.018, 6);
      expect(usage[0]).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 1000 });

      const exit = exitOf(events);
      expect(exit).toMatchObject({ type: 'exit', ok: true });
      expect(exit.structured, 'no schema was asked for').toBeUndefined();
      expect(kinds.at(-1)).toBe('exit');

      // THE SESSION IS STILL ALIVE. That is the upgrade over a one-shot run:
      // rework is a real conversational turn, not a replayed context.
      expect(await h.backend.alive((await h.backend.list())[0] as string)).toBe(true);
      await session.send('now also update the README\nand the changelog');
      await waitFor(
        async () => (await h.log()).filter((r) => r['event'] === 'submit').length === 2,
        'the follow-up turn',
      );
      const submits = (await h.log()).filter((r) => r['event'] === 'submit');
      // Collapsed to one line on purpose: a submit key inside the text would
      // otherwise send the first half as a whole turn. See Session.send().
      expect(submits[1]?.['line']).toBe('now also update the README and the changelog');

      await session.close();
    },
    SLOW,
  );

  it(
    'ends the stream when the run is interrupted',
    async () => {
      const h = await setup({ env: { BLUE_TURN_MS: '600000' } });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'a turn that never finishes',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      const pending = collect(session.events());
      await waitFor(async () => (await h.log()).some((r) => r['event'] === 'submit'), 'submit');
      await session.interrupt();

      const exit = exitOf(await pending);
      expect(exit).toMatchObject({ ok: false, interrupted: true, reason: 'interrupted' });
      await session.close();
    },
    SLOW,
  );

  it(
    'ends a run parked on a permission prompt, and says where to go and answer it',
    async () => {
      // Not hypothetical: verified on 2.1.222 that `--permission-mode auto` can
      // still open an edit dialog, which unattended is a worker frozen until the
      // turn timeout. See the file header.
      const h = await setup({
        env: { BLUE_NOTIFY_AFTER_MS: '200', BLUE_TURN_MS: '600000' },
        blockedGraceMs: 700,
      });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'edit something that needs confirming',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      const started = Date.now();
      const exit = exitOf(await collect(session.events()));
      expect(exit.ok).toBe(false);
      expect(exit.reason).toMatch(/blocked on a prompt/);
      expect(exit.reason).toContain('Claude needs your permission');
      expect(exit.reason, 'a captain can only rescue this if told where').toContain(
        session.attachCommand as string,
      );
      expect(Date.now() - started).toBeLessThan(20_000);

      await session.close();
    },
    SLOW,
  );

  it(
    'does not call a prompt that was answered a stall',
    async () => {
      // The same notification, but the transcript keeps growing afterwards —
      // somebody answered, or it resolved itself. Killing the run here would
      // throw away work over a dialog that is no longer on the screen.
      const h = await setup({
        env: {
          BLUE_NOTIFY_AFTER_MS: '150',
          BLUE_TICKS: '10',
          BLUE_TICK_MS: '150',
          BLUE_TURN_MS: '2000',
        },
        blockedGraceMs: 600,
      });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'work through a prompt and keep going',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      const events = await collect(session.events());
      expect(exitOf(events)).toMatchObject({ ok: true });
      expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(5);

      await session.close();
    },
    SLOW,
  );

  it(
    'refuses a second CONCURRENT consumer of the same stream',
    async () => {
      const h = await setup();
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'one consumer only',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      // Two loops over one transcript would bill every record twice. A LATER
      // call, once this stream has ended, is a different thing entirely — the
      // next turn. See the multi-turn test below.
      const first = collect(session.events());
      expect(() => session.events()).toThrow(/already being consumed/);
      await session.close();
      await first;
    },
    SLOW,
  );

  it(
    'gives each turn its own stream, and bills the earlier turns only once',
    async () => {
      // This is the shape the orchestrator's rework loop needs: a failing verdict
      // steers the SAME session and then watches the next turn. Without it, every
      // rework and every answered decision would end as a task stuck in `working`
      // with nobody reading it.
      const h = await setup();
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'first attempt',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      const first = await collect(session.events());
      expect(exitOf(first)).toMatchObject({ ok: true });
      expect(first).toContainEqual({ type: 'text', text: 'working on it' });
      expect(first.filter((e) => e.type === 'usage')).toHaveLength(2);

      await session.send('rework: the tests are missing');
      const second = await collect(session.events());

      expect(exitOf(second)).toMatchObject({ ok: true });
      expect(second).toContainEqual({ type: 'text', text: 'retried' });
      // THE POINT: turn two reads from where turn one stopped. Starting over
      // would replay turn one's records and bill its 3,600 tokens again.
      expect(second).not.toContainEqual({ type: 'text', text: 'working on it' });
      const billed = second.filter((e) => e.type === 'usage');
      expect(billed, 'turn one was billed a second time').toHaveLength(1);
      expect(billed[0]).toMatchObject({ inputTokens: 10, outputTokens: 10 });

      await session.close();
    },
    SLOW,
  );

  it(
    'bills the subagents a delegating worker paid for',
    async () => {
      // Verified on 2.1.222: a delegate's records are NOT in the session
      // transcript, they are in `<session-uuid>/subagents/agent-<id>.jsonl`.
      // Unread, that spend is money the per-task budget ceiling cannot see, so a
      // task stops at a number that is not what it cost.
      const h = await setup({ env: { BLUE_SUBAGENTS: '1' } });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'delegate some of this',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      const events = await collect(session.events());
      const usage = events.filter(
        (e): e is Extract<AdapterEvent, { type: 'usage' }> => e.type === 'usage',
      );

      // Two from the main transcript, one from each delegate.
      expect(usage).toHaveLength(4);
      const delegated = usage.filter((e) => e.inputTokens === 0);
      expect(delegated.map((e) => e.outputTokens).sort((a, b) => a - b)).toEqual([1000, 2000]);
      // claude-sonnet-5 output is $15/MTok: 3,000 delegated output tokens.
      expect(delegated.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(0.045, 6);

      // Before the exit, never after — `exit` ends the stream for every consumer,
      // and the orchestrator decides on the budget from what it saw before it.
      expect(events.at(-1)?.type).toBe('exit');
      const lastDelegated = events.findLastIndex((e) => e.type === 'usage' && e.inputTokens === 0);
      expect(lastDelegated).toBeLessThan(events.length - 1);

      // A delegate's words are not the Crew's: forwarding them would file them in
      // the Crew's log, and an escalation marker inside one would open a decision
      // no Crew asked for.
      expect(events).not.toContainEqual({ type: 'text', text: 'delegated work' });

      await session.close();
    },
    SLOW,
  );

  it(
    'bills a second turn only for what that turn delegated',
    async () => {
      const h = await setup({ env: { BLUE_SUBAGENTS: '1' } });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'delegate some of this',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      await collect(session.events());
      await session.send('again please');
      const second = await collect(session.events());

      const delegated = second.filter(
        (e): e is Extract<AdapterEvent, { type: 'usage' }> => e.type === 'usage' && e.inputTokens === 0,
      );
      // Each subagent transcript is appended to, so an offset-free re-read would
      // charge turn one's delegation a second time.
      expect(delegated).toHaveLength(2);
      expect(delegated.reduce((sum, e) => sum + e.costUsd, 0)).toBeCloseTo(0.045, 6);

      await session.close();
    },
    SLOW,
  );

  it(
    'waits for the composer to settle before pressing Enter on a follow-up turn',
    async () => {
      // The regression: `sendText` + `sendKey('Enter')` back to back. A message
      // of any size arrives at the TUI as a paste, and an Enter inside the paste
      // window is swallowed as one more character of it — so the rework sat in
      // the composer unsent, the task stayed `working`, and the only thing that
      // ever moved it was a human pressing Enter by hand. Measured on 2.1.224:
      // no gap did not submit; 150ms and up did.
      const h = await setup({});
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'first turn',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });
      await collect(session.events());

      const started = Date.now();
      await session.send('a follow-up turn');
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(SUBMIT_SETTLE_MS);
      // It still submits: one line reached the stand-in for each turn.
      const submits = (await h.log()).filter((r) => r['event'] === 'submit');
      expect(submits).toHaveLength(2);

      await session.close();
    },
    SLOW,
  );
});

// ---------------------------------------------------------------------------
// Structured output — the constraint that moved to the application layer
// ---------------------------------------------------------------------------

describe('structured output', () => {
  const verdict = { pass: true, reasoning: 'every requirement is met', unmet: [] };

  it(
    'tells the worker where to write, then reads and returns it',
    async () => {
      const h = await setup({ env: { BLUE_VERDICT_1: JSON.stringify(verdict) } });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'verify this diff',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
        outputSchema: VERDICT_SCHEMA,
      });

      const argv = await h.argv();
      const appended = await h.fileArg('--append-system-prompt-file');
      expect(appended.startsWith('SYS')).toBe(true);
      expect(appended).toContain('output.json');
      expect(appended).toContain('"pass"');
      // The output file lives outside the worktree, so the worker has to be
      // granted the directory or `auto` mode will not write there.
      const runDirs = await h.runDirs();
      expect(argv).toContain('--add-dir');
      expect(argv[argv.indexOf('--add-dir') + 1]).toBe(path.join(h.markerDir, runDirs[0] as string));

      const events = await collect(session.events());
      const exit = exitOf(events);
      expect(exit.ok).toBe(true);
      expect(exit.structured).toEqual(verdict);

      await session.close();
    },
    SLOW,
  );

  it(
    'types a bounded correction into the live session when validation fails',
    async () => {
      const h = await setup({
        env: {
          BLUE_VERDICT_1: 'Sure! Here is the verdict:\n```json\n{"pass": true}\n```',
          BLUE_VERDICT_2: JSON.stringify(verdict),
        },
      });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'verify this diff',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
        outputSchema: VERDICT_SCHEMA,
      });

      const events = await collect(session.events());
      const exit = exitOf(events);
      expect(exit.ok).toBe(true);
      expect(exit.structured).toEqual(verdict);

      const submits = (await h.log()).filter((r) => r['event'] === 'submit');
      expect(submits, 'the correction is a second real turn').toHaveLength(2);
      expect(String(submits[1]?.['line'])).toMatch(/not accepted/);
      expect(String(submits[1]?.['line'])).toContain('output.json');

      // The retry turn's transcript was still being read, so its cost is billed.
      expect(events.filter((e) => e.type === 'usage').length).toBeGreaterThanOrEqual(3);

      await session.close();
    },
    SLOW,
  );

  it(
    'gives up after the retry budget and fails the run rather than inventing a result',
    async () => {
      const h = await setup({
        env: { BLUE_VERDICT_1: 'not json', BLUE_VERDICT_2: 'still not json' },
        structuredRetries: 1,
      });
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'verify this diff',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
        outputSchema: VERDICT_SCHEMA,
      });

      const exit = exitOf(await collect(session.events()));
      expect(exit.ok).toBe(false);
      expect(exit.reason).toMatch(/structured_output_invalid/);
      expect(exit.structured).toBeUndefined();
      expect((await h.log()).filter((r) => r['event'] === 'submit')).toHaveLength(2);

      await session.close();
    },
    SLOW,
  );

  it('validates the subset it claims to, and stays quiet about the rest', () => {
    expect(validateAgainstSchema({ pass: true, reasoning: 'r', unmet: [] }, VERDICT_SCHEMA)).toEqual(
      [],
    );
    expect(validateAgainstSchema({ pass: true, reasoning: 'r' }, VERDICT_SCHEMA)).toEqual([
      'missing property "unmet"',
    ]);
    expect(validateAgainstSchema({ pass: 'yes', reasoning: 'r', unmet: [] }, VERDICT_SCHEMA)).toEqual(
      ['pass: a nested value must be a boolean'],
    );
    expect(validateAgainstSchema({ pass: true, reasoning: 'r', unmet: [1] }, VERDICT_SCHEMA)).toEqual(
      ['unmet: [0]: a nested value must be a string'],
    );
    expect(validateAgainstSchema('prose', VERDICT_SCHEMA)).toEqual(['the value must be a JSON object']);
    // Constructs it does not model are not failures: an over-strict check would
    // reject a perfectly good verdict.
    expect(validateAgainstSchema({ a: 1 }, { anyOf: [] })).toEqual([]);
    // A self-referential schema terminates on the depth bound rather than
    // recursing until the stack gives out.
    const cyclic: Record<string, unknown> = { type: 'array' };
    cyclic['items'] = cyclic;
    let deep: unknown[] = [];
    for (let i = 0; i < 200; i++) deep = [deep];
    expect(validateAgainstSchema(deep, cyclic)).toEqual([]);
  });

  it('names the file and forbids answering in chat instead', () => {
    const text = structuredOutputInstruction('/tmp/run/output.json', VERDICT_SCHEMA);
    expect(text).toContain('/tmp/run/output.json');
    expect(text).toMatch(/Write tool/);
    expect(text).toMatch(/instead of writing the file/);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('close', () => {
  it(
    'kills the endpoint and removes the run directory',
    async () => {
      const h = await setup();
      const session = await h.adapter.spawn({
        cwd: h.root,
        prompt: 'finish and be reaped',
        profile: PROFILE,
        settingScopes: [],
        systemPromptAppend: 'SYS',
      });

      await collect(session.events());
      expect(await h.backend.list()).toHaveLength(1);
      expect(await h.runDirs()).toHaveLength(1);

      await session.close();

      // `list()` is the reaper's input, so a finished crew that leaves a window
      // behind makes every later reap ambiguous.
      expect(await h.backend.list()).toEqual([]);
      expect(await h.runDirs()).toEqual([]);

      // Idempotent, and a closed session refuses to be steered.
      await session.close();
      await expect(session.send('anything')).rejects.toThrow(/closed/);
    },
    SLOW,
  );
});
