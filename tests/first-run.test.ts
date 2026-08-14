/**
 * The one question, and the three things it must never do.
 *
 * It must never be asked twice — a captain who answered on Monday is not asked
 * again on Tuesday, and neither is one who declined. It must never fire where
 * nobody can answer it, because a question written to a pipe is a hang. And
 * declining it must not quietly leave the locale guess in charge, which is the
 * whole failure it was written for: the menu names `en-AU` out loud, so a
 * captain who says no to it has said no to `en-AU`.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  askLanguage,
  languageOptions,
  languagePrompt,
  parseLanguageAnswer,
  shouldAskLanguage,
} from '../src/cli/first-run.js';
import { setColourEnabled } from '../src/cli/format.js';
import {
  type BlueConfig,
  captainVoice,
  defaultConfig,
  loadConfig,
  resolveCaptainVoice,
} from '../src/config/index.js';

// The question writes to a stream a test reads back; escape codes would make
// every assertion a regex.
setColourEnabled(false);

const tmpDirs: string[] = [];
const originalHome = process.env['BLUESPACE_HOME'];

beforeEach(async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-firstrun-')));
  tmpDirs.push(home);
  process.env['BLUESPACE_HOME'] = home;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env['BLUESPACE_HOME'];
  else process.env['BLUESPACE_HOME'] = originalHome;
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

/** A terminal that types `lines` and records everything printed at it. */
function terminal(lines: readonly string[]): {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  printed(): string;
} {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  // One stream carrying every line, so the second question reads what the first
  // one did not — the way a real terminal behaves.
  const input = Readable.from(lines.map((l) => `${l}\n`));
  return { input, output, printed: () => chunks.join('') };
}

const AU = { LANG: 'en_AU.UTF-8' } as const;

// ---------------------------------------------------------------------------
// When it is asked at all
// ---------------------------------------------------------------------------

describe('shouldAskLanguage', () => {
  it('asks a captain nobody has asked, in a terminal', () => {
    expect(shouldAskLanguage({}, true)).toBe(true);
  });

  it('never asks where there is nobody to answer', () => {
    // A launcher in a pipe, a cron job, a CI run. The question would be written
    // into a log and then waited on forever.
    expect(shouldAskLanguage({}, false)).toBe(false);
  });

  it('never asks a captain who already pinned a language', () => {
    expect(shouldAskLanguage({ language: 'zh-CN' }, true)).toBe(false);
  });

  it('never asks a captain who was asked and declined', () => {
    // The decline is the answer. This is the assertion that stops the feature
    // becoming the "ask every session" design that was already rejected.
    expect(shouldAskLanguage({ languageAsked: true }, true)).toBe(false);
  });

  it('asks again once the captain puts the question back', () => {
    expect(shouldAskLanguage({ languageAsked: false }, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

describe('languageOptions', () => {
  it('leads with what this shell says, named out loud', () => {
    const rows = languageOptions(AU);
    expect(rows[0]).toMatchObject({ key: '1', language: 'en-AU' });
    expect(rows[0]?.note).toContain('LANG');
    // Naming it is what makes declining it a decision rather than a shrug.
    expect(languagePrompt(rows)).toContain('en-AU');
  });

  it('offers the same language once, and says the shell agrees', () => {
    const rows = languageOptions({ LANG: 'zh_CN.UTF-8' });
    expect(rows.map((r) => r.language)).toEqual(['zh-CN', 'en']);
    expect(rows[0]?.note).toContain('detected from LANG');
  });

  it('falls back to what we actually know when the shell says nothing', () => {
    // Not a list of eight plausible languages: 中文 has a checked address term
    // and English is what the contract is written in. Everything else is typed.
    expect(languageOptions({}).map((r) => r.language)).toEqual(['zh-CN', 'en']);
    expect(languageOptions({ LC_ALL: 'C' }).map((r) => r.language)).toEqual(['zh-CN', 'en']);
  });

  it('always offers a way out that is not a language', () => {
    expect(languagePrompt(languageOptions(AU))).toMatch(/Enter\s+skip/);
  });
});

describe('parseLanguageAnswer', () => {
  const rows = languageOptions(AU);

  it('takes a number off the menu', () => {
    expect(parseLanguageAnswer('2', rows)).toEqual({ kind: 'pick', language: 'zh-CN' });
  });

  it('takes a language typed in any spelling the setting would take', () => {
    expect(parseLanguageAnswer('ja', rows)).toEqual({ kind: 'pick', language: 'ja' });
    expect(parseLanguageAnswer(' 中文 ', rows)).toEqual({ kind: 'pick', language: '中文' });
    expect(parseLanguageAnswer('Simplified Chinese', rows)).toEqual({
      kind: 'pick',
      language: 'Simplified Chinese',
    });
  });

  it('reads Enter, and whitespace, as declining', () => {
    expect(parseLanguageAnswer('', rows)).toEqual({ kind: 'decline' });
    expect(parseLanguageAnswer('   ', rows)).toEqual({ kind: 'decline' });
  });

  it('refuses a number that is not on the menu instead of pinning a digit', () => {
    expect(parseLanguageAnswer('9', rows)).toEqual({ kind: 'unreadable', typed: '9' });
  });

  it('refuses the locales that name no language', () => {
    // Same rule as `blue config set language`: `C` is not English.
    expect(parseLanguageAnswer('C', rows)).toEqual({ kind: 'unreadable', typed: 'C' });
    expect(parseLanguageAnswer('POSIX', rows)).toEqual({ kind: 'unreadable', typed: 'POSIX' });
  });
});

// ---------------------------------------------------------------------------
// Asking, answering, and what lands on disk
// ---------------------------------------------------------------------------

describe('askLanguage', () => {
  const base = (): BlueConfig => defaultConfig();

  it('pins what the captain picked, and says so', async () => {
    const t = terminal(['2']);
    const after = await askLanguage(base(), { ...t, interactive: true }, AU);

    expect(after.language).toBe('zh-CN');
    expect(after.languageAsked).toBe(true);
    // Persisted, not just returned: the whole point is that the next launch
    // does not ask.
    expect(loadConfig().language).toBe('zh-CN');
    expect(t.printed()).toContain('zh-CN');
  });

  it('takes a language typed instead of chosen', async () => {
    const after = await askLanguage(base(), { ...terminal(['日本語']), interactive: true }, AU);
    expect(after.language).toBe('日本語');
    expect(loadConfig().language).toBe('日本語');
  });

  it('records a decline as an answer, and pins nothing', async () => {
    const t = terminal(['']);
    const after = await askLanguage(base(), { ...t, interactive: true }, AU);

    expect(after.language).toBeUndefined();
    expect(after.languageAsked).toBe(true);
    expect(loadConfig().languageAsked).toBe(true);
    expect(loadConfig().language).toBeUndefined();
    expect(t.printed()).toContain('follows whatever language you write');
  });

  it('re-asks an unreadable answer, on the same stream', async () => {
    // Two questions, one readline: a fresh interface per attempt would have
    // eaten the second line along with the first.
    const t = terminal(['9', '3']);
    const after = await askLanguage(base(), { ...t, interactive: true }, AU);

    expect(after.language).toBe('en');
    expect(t.printed()).toContain('names no language on this menu');
  });

  it('gives up after three tries rather than standing in the captain’s way', async () => {
    const t = terminal(['9', 'C', 'POSIX', '2']);
    const after = await askLanguage(base(), { ...t, interactive: true }, AU);

    // The fourth line is never read: three strikes is a decline, and the window
    // opens. A prompt that will not take no for an answer is worse than a wrong
    // guess.
    expect(after.language).toBeUndefined();
    expect(after.languageAsked).toBe(true);
  });

  it('does not spend the question on a terminal that went away', async () => {
    // An empty stream closes immediately: no answer, no hang — and nothing
    // recorded, because nobody said anything. The one question this feature
    // gets survives for a launch where somebody is there to answer it.
    const after = await askLanguage(base(), { ...terminal([]), interactive: true }, AU);
    expect(after.languageAsked).toBeUndefined();
    expect(after.language).toBeUndefined();
    expect(loadConfig().languageAsked).toBeUndefined();
  });

  it('asks nothing, and prints nothing, where nobody can answer', async () => {
    const t = terminal(['2']);
    const after = await askLanguage(base(), { ...t, interactive: false }, AU);

    expect(t.printed()).toBe('');
    expect(after.languageAsked).toBeUndefined();
    // Nothing was written either — a non-interactive launch leaves no trace.
    expect(loadConfig().languageAsked).toBeUndefined();
  });

  it('asks nothing when it has been asked before', async () => {
    const t = terminal(['2']);
    const before: BlueConfig = { ...base(), languageAsked: true };
    const after = await askLanguage(before, { ...t, interactive: true }, AU);

    expect(t.printed()).toBe('');
    expect(after).toBe(before);
  });

  it('keeps the rest of the config the caller assembled', async () => {
    // `saveConfig` merges over what is on DISK and returns that, so returning
    // its result would drop everything the caller had in hand.
    const before: BlueConfig = { ...base(), maxRework: 9, helmUltracode: false };
    const after = await askLanguage(before, { ...terminal(['3']), interactive: true }, AU);

    expect(after.maxRework).toBe(9);
    expect(after.helmUltracode).toBe(false);
    expect(after.language).toBe('en');
  });

  it('opens the window anyway when the answer cannot be saved', async () => {
    // The captain came here to reach Helm, not to fill in a form.
    const home = process.env['BLUESPACE_HOME'] as string;
    await fs.rm(home, { recursive: true, force: true });
    await fs.writeFile(home, 'not a directory', 'utf8');

    const t = terminal(['2']);
    const after = await askLanguage(base(), { ...t, interactive: true }, AU);

    expect(after.language).toBe('zh-CN');
    expect(t.printed()).toContain('Opening anyway');
  });

  it('survives a stream that never ends, because the question is answered', async () => {
    // A real stdin stays open after the captain hits Enter. The interface must
    // resolve on the line, not on the stream closing.
    const input = new PassThrough();
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const pending = askLanguage(base(), { input, output, interactive: true }, AU);
    input.write('2\n');
    expect((await pending).language).toBe('zh-CN');
    input.end();
  });
});

// ---------------------------------------------------------------------------
// What the answer means afterwards
// ---------------------------------------------------------------------------

describe('captainVoice', () => {
  it('follows the shell until somebody has been asked', () => {
    expect(captainVoice({}, AU).language).toBe('en-AU');
  });

  it('stops following the shell once the captain has declined it by name', () => {
    // The failure this whole feature exists for: the menu showed `en-AU`, the
    // captain said no, and the launcher must not go on to use `en-AU` anyway.
    const voice = captainVoice({ languageAsked: true }, AU);
    expect(voice.language).toBeUndefined();
    expect(voice.declined).toBe(true);
    expect(voice.address).toBe('Captain');
  });

  it('lets a pin outrank a decline, whichever order they happened in', () => {
    const voice = captainVoice({ language: 'zh-CN', languageAsked: true }, AU);
    expect(voice.language).toBe('zh-CN');
    expect(voice.pinned).toBe(true);
    expect(voice.address).toBe('舰长');
    expect(voice.declined).toBeUndefined();
  });

  it('leaves resolveCaptainVoice’s two-argument form alone', () => {
    // Every existing caller passes (pinned, env) and must keep the old answer.
    expect(resolveCaptainVoice(undefined, AU).language).toBe('en-AU');
    expect(resolveCaptainVoice('ja', AU)).toMatchObject({ language: 'ja', pinned: true });
  });
});
