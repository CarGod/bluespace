/**
 * The push that exists because Helm cannot make it.
 *
 * An interactive Claude Code session speaks only when it is spoken to, so "the
 * task you dispatched twenty minutes ago just landed" has no turn to be said in.
 * The orchestrator is running at the moment the task settles, so it is what
 * tells the captain — and these are the two halves of that: WHICH outcomes are
 * worth interrupting someone for, and a shell-safety property that matters
 * because task titles are written by whoever wrote the brief.
 */

import { describe, expect, it } from 'vitest';

import { appleScriptFor, desktopNotifier } from '../src/notify/index.js';

describe('desktopNotifier', () => {
  it('exists on the platforms that can show one, and says why when it does not', () => {
    expect(desktopNotifier({ platform: 'darwin', env: {} })).toHaveProperty('notify');
    expect(desktopNotifier({ platform: 'linux', env: {} })).toHaveProperty('notify');
    expect(desktopNotifier({ platform: 'win32', env: {} })).toEqual({
      unavailable: 'unsupported-platform',
    });
  });

  it('is silenced by the config and by one shell’s environment', () => {
    expect(desktopNotifier({ enabled: false, platform: 'darwin', env: {} })).toEqual({
      unavailable: 'disabled-by-config',
    });
    expect(desktopNotifier({ platform: 'darwin', env: { BLUESPACE_NO_NOTIFY: '1' } })).toEqual({
      unavailable: 'disabled-by-env',
    });
    // `0`, empty and `false` are not a request for silence — a variable set to
    // "off" by a wrapper script must not read as "on" or vice versa.
    expect(desktopNotifier({ platform: 'darwin', env: { BLUESPACE_NO_NOTIFY: '0' } })).toHaveProperty('notify');
    expect(desktopNotifier({ platform: 'darwin', env: { BLUESPACE_NO_NOTIFY: '' } })).toHaveProperty('notify');
    expect(desktopNotifier({ platform: 'darwin', env: { BLUESPACE_NO_NOTIFY: 'false' } })).toHaveProperty('notify');
  });

  it('never throws, whatever the notifier binary does', async () => {
    // It runs inside the dispatch loop. A machine with no `osascript` must cost
    // the notification and nothing else.
    const made = desktopNotifier({ platform: 'linux', env: {} });
    expect('notify' in made).toBe(true);
    if (!('notify' in made)) return;
    expect(() => made.notify({ title: 'x', body: 'y' })).not.toThrow();
    // The child is spawned detached and its `error` is handled; give the event
    // loop a tick to prove an ENOENT does not surface as an uncaught exception.
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('the AppleScript a task title becomes', () => {
  // `osascript -e` takes SOURCE, so a title is code the moment it is
  // interpolated — and task titles are written by whoever wrote the brief.
  const script = (title: string) => appleScriptFor({ title: 'T', body: title });

  it('escapes a quote so the title cannot end the string it is in', () => {
    const out = script('fix the "parser" bug');
    expect(out).toContain('\\"parser\\"');
    // Two delimiters for the body, two for the title, and no stray fifth.
    expect(out.match(/(?<!\\)"/g) ?? []).toHaveLength(4);
  });

  it('escapes a backslash before the quotes, not after', () => {
    // The other order double-escapes and leaves the quote bare.
    expect(script('path C:\\temp "x"')).toContain('C:\\\\temp \\"x\\"');
  });

  it('flattens a newline, which would otherwise end the statement', () => {
    const out = script('line one\nline two');
    expect(out).not.toContain('\n');
    expect(out).toContain('line one line two');
  });

  it('leaves ordinary text — including Chinese — exactly as it is', () => {
    expect(script('评论功能 · 前端 C')).toContain('评论功能 · 前端 C');
  });
});
