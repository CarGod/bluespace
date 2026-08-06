/**
 * How a run authenticates, and the startup check that makes failure legible.
 *
 * BlueSpace launches the captain's own `claude` with the login they already have,
 * so the happy path needs no configuration at all. What actually breaks is the
 * CLI being absent, mis-pathed, or unresponsive — and because a worker is a
 * terminal session rather than a call this process makes, that would otherwise
 * surface as a window that dies partway through a task, after a worktree exists
 * and the captain has been told work started.
 *
 * These tests pin the two things that keep that from happening: the auth mode is
 * reported honestly, and the startup check fails with a sentence a human can act
 * on rather than a spawn error.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLI_PATH_ENV,
  ClaudeCliUnavailableError,
  assertClaudeCliAvailable,
  createClaudeCliAdapter,
  resolveAuth,
} from '../src/adapters/claude-cli.js';

/** An explicit environment, so an ambient key on a developer machine cannot leak in. */
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bluespace-auth-'));
  temps.push(d);
  return d;
}

describe('resolveAuth', () => {
  it('defaults to the captain’s own Claude CLI login — no key, no configuration', () => {
    expect(resolveAuth(env())).toEqual({ kind: 'cli-login' });
  });

  it('uses an API key when the environment has one, which is how CI runs without a login', () => {
    expect(resolveAuth(env({ ANTHROPIC_API_KEY: 'sk-ant-abc' }))).toEqual({
      kind: 'api-key',
      key: 'sk-ant-abc',
    });
  });

  it('trims a pasted key, and treats a blank one as absent rather than as a key', () => {
    expect(resolveAuth(env({ ANTHROPIC_API_KEY: '  sk-ant-abc \n' }))).toEqual({
      kind: 'api-key',
      key: 'sk-ant-abc',
    });
    expect(resolveAuth(env({ ANTHROPIC_API_KEY: '   ' }))).toEqual({ kind: 'cli-login' });
    expect(resolveAuth(env({ ANTHROPIC_API_KEY: '' }))).toEqual({ kind: 'cli-login' });
  });

  it('never throws — reporting the mode is its only job', () => {
    expect(() => resolveAuth(env())).not.toThrow();
  });
});

describe('adapter metering', () => {
  // Whether a run is metered is what decides if a dollar figure may ever be
  // shown as spend. It is answered by the adapter, from the environment its
  // WORKERS get — not by whatever shell reads the log afterwards.
  it('is metered when a key reaches the workers', () => {
    expect(createClaudeCliAdapter({ env: { ANTHROPIC_API_KEY: 'sk-ant-abc' } }).metered).toBe(true);
  });

  it('is NOT metered on a subscription login, so its dollars are only an equivalence', () => {
    // An empty string overrides an ambient key on a developer machine, and
    // `resolveAuth` reads blank as absent — the same as no key at all.
    expect(createClaudeCliAdapter({ env: { ANTHROPIC_API_KEY: '' } }).metered).toBe(false);
  });
});

describe('assertClaudeCliAvailable', () => {
  it('accepts a CLI that answers --version, and reports what it found', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });

    const info = assertClaudeCliAvailable(env({ [CLI_PATH_ENV]: bin }));
    expect(info.path).toBe(bin);
    expect(info.version).toBe('9.9.9 (Claude Code)');
  });

  it('keeps only the first line, since a CLI may print notices after the version', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\necho "1.2.3"\necho "update available"\n', { mode: 0o755 });

    expect(assertClaudeCliAvailable(env({ [CLI_PATH_ENV]: bin })).version).toBe('1.2.3');
  });

  it('fails with actionable guidance when the CLI is not installed', () => {
    const missing = path.join(tempDir(), 'definitely-not-here');
    let message = '';
    expect(() => {
      try {
        assertClaudeCliAvailable(env({ [CLI_PATH_ENV]: missing }));
      } catch (e) {
        message = (e as Error).message;
        throw e;
      }
    }).toThrow(ClaudeCliUnavailableError);

    // The message has to carry the captain from "broken" to "fixed" on its own.
    expect(message).toContain('not found');
    expect(message).toContain('claude.com/claude-code');
    expect(message).toContain('sign in');
    expect(message).toContain(CLI_PATH_ENV);
  });

  it('fails when the CLI runs but prints no version, rather than accepting silence', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(() => assertClaudeCliAvailable(env({ [CLI_PATH_ENV]: bin }))).toThrow(
      ClaudeCliUnavailableError,
    );
  });

  it('fails when the CLI exits non-zero — a signed-out or broken install is not usable', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n', { mode: 0o755 });

    expect(() => assertClaudeCliAvailable(env({ [CLI_PATH_ENV]: bin }))).toThrow(
      ClaudeCliUnavailableError,
    );
  });

  it('resolves PATH to an absolute binary, so the CLI we verify is the CLI that runs', () => {
    // Whether a CLI is installed is a property of the machine, not of the code,
    // so both outcomes are legal. What must hold in each: a found CLI reports an
    // ABSOLUTE path — a bare `claude` is resolved against the environment of a
    // long-lived tmux server, which is not this process's PATH, so the binary
    // verified here would not necessarily be the binary that runs — and an
    // absent CLI still produces the typed, actionable error rather than a raw
    // spawn failure.
    try {
      const info = assertClaudeCliAvailable(env());
      expect(path.isAbsolute(info.path)).toBe(true);
      expect(info.version.length).toBeGreaterThan(0);
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeCliUnavailableError);
    }
  });

  it('prefers an explicit override over anything on PATH', () => {
    const dir = tempDir();
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\necho "0.0.1-override"\n', { mode: 0o755 });

    const info = assertClaudeCliAvailable(env({ [CLI_PATH_ENV]: bin }));
    expect(info.path).toBe(bin);
    expect(info.version).toBe('0.0.1-override');
  });
});
