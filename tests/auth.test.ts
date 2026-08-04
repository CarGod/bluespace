/**
 * The credential boundary.
 *
 * BlueSpace is a third-party agent built on the Claude Agent SDK, and Anthropic's
 * SDK documentation asks those to authenticate with an API key rather than a
 * claude.ai login. Left to itself the SDK resolves whatever credential it can
 * find, so the default here has to be a refusal — a silent fallback would put a
 * captain's account on the wrong side of that line without ever telling them.
 *
 * These tests exist because the failure mode is invisible: everything WORKS on a
 * subscription login. Nothing crashes, nothing warns. Only the terms say no. So
 * the guard is the only thing standing between a fork of this repo and someone
 * else's account, and a guard nobody tests is a guard that quietly stops working.
 */

import { describe, expect, it } from 'vitest';

import {
  INHERIT_AUTH_ENV,
  MissingApiKeyError,
  assertApiKeyAuth,
  resolveAuth,
} from '../src/adapters/claude.js';

/** A clean environment — the suite's global setup deliberately populates the real one. */
const bare = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

describe('resolveAuth — the default is an explicit API key', () => {
  it('accepts an API key and hands it back for pinning', () => {
    const auth = resolveAuth(bare({ ANTHROPIC_API_KEY: 'sk-ant-abc' }));
    expect(auth).toEqual({ kind: 'api-key', key: 'sk-ant-abc' });
  });

  it('trims surrounding whitespace, which a copy-paste from a dashboard often carries', () => {
    const auth = resolveAuth(bare({ ANTHROPIC_API_KEY: '  sk-ant-abc \n' }));
    expect(auth).toEqual({ kind: 'api-key', key: 'sk-ant-abc' });
  });

  it('REFUSES when nothing is configured, rather than letting the SDK pick', () => {
    expect(() => resolveAuth(bare())).toThrow(MissingApiKeyError);
  });

  it('treats an empty or whitespace-only key as absent', () => {
    expect(() => resolveAuth(bare({ ANTHROPIC_API_KEY: '' }))).toThrow(MissingApiKeyError);
    expect(() => resolveAuth(bare({ ANTHROPIC_API_KEY: '   ' }))).toThrow(MissingApiKeyError);
  });

  it('explains itself: the refusal names the variable, the reason, and both ways out', () => {
    let message = '';
    try {
      resolveAuth(bare());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('Claude Agent SDK');
    expect(message).toContain('console.anthropic.com');
    expect(message).toContain(INHERIT_AUTH_ENV);
  });
});

describe('resolveAuth — the opt-out is deliberate and narrow', () => {
  it('hands credential resolution back to the SDK when explicitly told to', () => {
    expect(resolveAuth(bare({ [INHERIT_AUTH_ENV]: '1' }))).toEqual({ kind: 'inherited' });
    expect(resolveAuth(bare({ [INHERIT_AUTH_ENV]: 'true' }))).toEqual({ kind: 'inherited' });
    expect(resolveAuth(bare({ [INHERIT_AUTH_ENV]: 'TRUE' }))).toEqual({ kind: 'inherited' });
  });

  it('ignores values that merely look enabled — opting out has to be unambiguous', () => {
    for (const v of ['0', 'false', 'yes', 'on', 'maybe', '']) {
      expect(() => resolveAuth(bare({ [INHERIT_AUTH_ENV]: v }))).toThrow(MissingApiKeyError);
    }
  });

  it('prefers a real API key over the opt-out when both are present', () => {
    const auth = resolveAuth(bare({ ANTHROPIC_API_KEY: 'sk-ant-abc', [INHERIT_AUTH_ENV]: '1' }));
    expect(auth).toEqual({ kind: 'api-key', key: 'sk-ant-abc' });
  });
});

describe('assertApiKeyAuth — for callers that need the key itself', () => {
  it('returns the key when one is set', () => {
    expect(assertApiKeyAuth(bare({ ANTHROPIC_API_KEY: 'sk-ant-abc' }))).toBe('sk-ant-abc');
  });

  it('throws under the opt-out, because there is no key to return', () => {
    expect(() => assertApiKeyAuth(bare({ [INHERIT_AUTH_ENV]: '1' }))).toThrow(MissingApiKeyError);
  });
});
