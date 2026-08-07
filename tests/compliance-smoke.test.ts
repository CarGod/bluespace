/**
 * Compliance smoke test.
 *
 * BlueSpace runs its workers as interactive Claude Code sessions rather than
 * through a vendor SDK, and `docs/compliance.md` explains why that distinction
 * is load-bearing rather than stylistic. This file is the part of that argument
 * that can fail.
 *
 * None of the behaviour BlueSpace depends on here is a documented, versioned
 * API contract. It is observed behaviour of a product that ships continuously.
 * The failure mode of a regression is not an exception — it is silence: a
 * worker parked on an unsubmitted prompt, or on a dialog nobody is there to
 * answer. So the checks are split by cost:
 *
 *   FLAG SURFACE — free, always runs. Asserts the options BlueSpace passes
 *   still exist. A renamed or removed flag is the most likely regression and
 *   the cheapest to catch, and catching it here means catching it in CI rather
 *   than in a worktree at 3am.
 *
 *   LIVE LOOP — spends real tokens, opt-in via BLUESPACE_LIVE_SMOKE=1. Drives
 *   an actual session end to end. This is the only check that can prove the
 *   composer/submit split and the permission modes still behave.
 *
 * When you re-verify after a Claude Code upgrade, update the version table in
 * docs/compliance.md.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

const LIVE = process.env['BLUESPACE_LIVE_SMOKE'] === '1';

/** Resolve the captain's own claude, the same way the adapter does. */
async function claudePath(): Promise<string | undefined> {
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['claude']);
    return stdout.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function help(): Promise<string> {
  const bin = await claudePath();
  if (bin === undefined) return '';
  // `claude --help` exits 0 and prints to stdout; tolerate either stream so a
  // future change in where it writes does not read as a missing flag.
  const { stdout, stderr } = await run(bin, ['--help'], { maxBuffer: 4 * 1024 * 1024 });
  return `${stdout}\n${stderr}`;
}

describe('flag surface (free)', () => {
  it('exposes every option BlueSpace passes when launching a worker', async () => {
    const text = await help();
    if (text === '') {
      // No claude on PATH is a legitimate state for a machine that only reads
      // the Blackbox. Not a failure of this assertion.
      return;
    }

    // Each of these is load-bearing. The comment is why, so that a future
    // reader deleting one knows what breaks.
    const required: Array<[flag: string, why: string]> = [
      ['--session-id', 'fixes the transcript path before launch; without it the path is unknowable until after the run'],
      ['--settings', 'carries the per-run Stop hook inline, so completion never requires touching ~/.claude/settings.json'],
      ['--setting-sources', 'scopes which on-disk config a worker inherits; see SpawnRequest.settingScopes'],
      ['--append-system-prompt', 'attaches CREW_SYSTEM_PROMPT without replacing the harness prompt'],
      ['--permission-mode', 'selects auto; see the permission-mode assertions below'],
      ['--effort', 'per-task reasoning effort from the dispatch profile'],
      ['--model', 'per-project model override'],
      ['--add-dir', 'grants a worker paths outside its worktree when a project needs it'],
    ];

    for (const [flag, why] of required) {
      expect(text, `${flag} is gone — ${why}`).toContain(flag);
    }
  });

  it('still offers the permission mode BlueSpace relies on, and the one it must avoid', async () => {
    const text = await help();
    if (text === '') return;

    // `auto` is the mode that performs real edits with no dialog and no
    // persisted global state. If it disappears, dispatch has no safe default
    // and the fallback (--dangerously-skip-permissions) reintroduces a modal
    // that only a human can dismiss.
    expect(text, 'permission mode "auto" is gone — see docs/compliance.md, Rejected alternatives').toMatch(
      /--permission-mode[\s\S]{0,400}?"auto"/,
    );

    // Documented here so nobody "fixes" a worker by switching to it: dontAsk
    // DENIES Edit and Write rather than proceeding without prompting.
    expect(text).toMatch(/--permission-mode[\s\S]{0,400}?"dontAsk"/);
  });

  it('does not depend on the Agent SDK', async () => {
    // The dependency is not merely unused — its presence would move BlueSpace
    // from "ordinary use of Claude Code" into the bucket Anthropic's docs
    // direct to API keys. See docs/compliance.md.
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all)).not.toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('still offers every option the `bluespace` launcher opens a Helm window with', async () => {
    const text = await help();
    if (text === '') return;

    // Losing any of these does not break a Crew — it breaks the front door, and
    // it breaks it into the exact shape BlueSpace deleted the old `claude mcp
    // add` instruction to avoid: a window with some of Helm in it.
    const required: Array<[flag: string, why: string]> = [
      ['--mcp-config', "Helm's tools, inline, per invocation — the alternative is a global install"],
      ['--strict-mcp-config', 'BLUESPACE_STRICT_MCP=1 isolates the window from the captain’s own servers'],
      ['--append-system-prompt', 'carries CLAUDE.md, without which the tools are not Helm'],
      ['--add-dir', 'lets the window read skills/bluespace/SKILL.md from the install root'],
      // Losing this one is quieter than losing the others and worse than most:
      // the window still opens, still calls itself Helm, and can now do the
      // captain's work itself with nothing behind it. See src/cli/bluespace.ts.
      ['--disallowedTools', 'keeps Helm on the dispatching side of the line'],
    ];
    for (const [flag, why] of required) {
      expect(text, `${flag} is gone — ${why}`).toContain(flag);
    }
  });

  it('still takes a positional prompt, which is how the wake sweep opens', async () => {
    const text = await help();
    if (text === '') return;
    // A bare `bluespace` passes one. If the CLI stops accepting a positional
    // prompt, the window opens on an argument it treats as something else —
    // measured on 2.1.223, `--mcp-config` and `--add-dir` both read a stray
    // positional as one of their own values. See docs/compliance.md.
    expect(text).toMatch(/Usage: claude \[options\][\s\S]{0,80}\[prompt\]/);
  });
});

describe.skipIf(!LIVE)('live loop (spends tokens — BLUESPACE_LIVE_SMOKE=1)', () => {
  const dirs: string[] = [];
  const sessions: string[] = [];

  afterAll(async () => {
    for (const s of sessions) {
      await run('tmux', ['kill-session', '-t', s]).catch(() => undefined);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function launchAndSubmit(mode: string, prompt: string) {
    const bin = await claudePath();
    expect(bin, 'claude must be on PATH for the live smoke test').toBeDefined();

    const dir = await mkdtemp(join(tmpdir(), 'blue-smoke-'));
    dirs.push(dir);
    await writeFile(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n');

    const session = `blue-smoke-${randomUUID().slice(0, 8)}`;
    sessions.push(session);
    const marker = join(dir, 'STOPPED');
    const ready = join(dir, 'READY');
    // Both signals inline, so the run never touches ~/.claude/settings.json:
    // SessionStart says "the composer is up", Stop says "the turn is over".
    const settings = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `touch ${ready}` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }],
      },
    });

    await run('tmux', [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50', '-c', dir, '--',
      bin as string,
      '--session-id', randomUUID(),
      '--permission-mode', mode,
      '--effort', 'low',
      '--settings', settings,
      prompt,
    ]);

    // Readiness comes from a hook-written marker, never from reading the
    // screen. If SessionStart does not fire, fall through on a timeout rather
    // than hanging — the submit is harmless if the composer is not up yet and
    // the Stop assertion below is what actually decides the test.
    for (let i = 0; i < 40 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 500));

    await run('tmux', ['send-keys', '-t', session, 'Enter']);

    for (let i = 0; i < 90 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 1000));
    return { dir, stopped: existsSync(marker) };
  }

  it('SessionStart fires, the turn runs, and auto mode really edits', async () => {
    // NOTE ON TRUST: this launches in a fresh temp directory, and a fresh
    // directory is exactly what Claude Code asks about before it will do
    // anything — no hook fires, including SessionStart, until it is trusted.
    // Trust is inherited from an ancestor, so this passes on a machine where
    // the temp root has been trusted once and hangs to its timeout on one
    // where it has not. That is the same trap every Crew worktree hits; the
    // adapter turns it into SessionNotReadyError with the command to fix it.
    // If this test times out on a clean machine, that is the reason.
    const { dir, stopped } = await launchAndSubmit(
      'auto',
      'calc.py has a bug: add() uses minus. Change it to plus. Then stop; ask nothing.',
    );

    expect(stopped, 'Stop hook never fired — the turn never started, or the directory is untrusted').toBe(
      true,
    );
    const after = await readFile(join(dir, 'calc.py'), 'utf8');
    // `auto` is a classifier rather than a switch: it did not prompt in three
    // of three measured runs on this shape of task, and a second machine saw it
    // prompt. A failure here is a signal to re-read docs/compliance.md, not
    // automatically a regression.
    expect(after, 'auto mode did not perform the edit — did it stop to ask?').toContain('a + b');
  }, 180_000);

  it('dontAsk refuses writes, which is why it is not the dispatch default', async () => {
    const { dir, stopped } = await launchAndSubmit(
      'dontAsk',
      'calc.py has a bug: add() uses minus. Change it to plus. Then stop; ask nothing.',
    );

    expect(stopped).toBe(true);
    const after = await readFile(join(dir, 'calc.py'), 'utf8');
    // The point of asserting the NEGATIVE: if a future release makes dontAsk
    // permissive, this test fails and someone re-reads docs/compliance.md
    // rather than discovering the change through a behaviour shift in prod.
    expect(after, 'dontAsk now permits writes — re-evaluate the dispatch default').toContain('a - b');
  }, 180_000);
});
