/**
 * The one question BlueSpace asks before it opens the first window.
 *
 * WHY THERE IS A QUESTION AT ALL. The launcher guesses the captain's language
 * from the shell's locale, and a guess read off `LANG` is wrong more often than
 * it looks: the measured case was a captain who reads Chinese, on a machine
 * whose macOS locale is `en_US`, opening a terminal whose profile pins
 * `LANG=en_AU.UTF-8` — three answers, none of them the right one, and the one
 * that won was a setting nobody remembers making. Helm then wrote English at
 * them, correctly, forever, because the contract tells it to follow the value it
 * was handed.
 *
 * WHY IT IS ASKED ONCE, HERE. `bluespace.ts` lists the three ways to fix a wrong
 * guess and rejects two of them: writing the captain's config off something they
 * said in passing, and asking every session. This is the fourth — ask once, at
 * the moment they first open the thing, before Claude Code owns the screen, and
 * never again. It costs one keystroke on one morning and it is the only one of
 * the four that ends with the right value in the file rather than with Helm
 * inferring it afresh every session.
 *
 * WHAT IS IN THE MENU IS WHAT WE ACTUALLY KNOW. The detected locale, because it
 * is this shell's answer and is usually right; 中文, because it is the one
 * language whose address term was given to us rather than invented; English,
 * because the contract is written in it. Everything else is typed. A list of
 * eight plausible languages would be a list nobody checked — the same reason
 * `ADDRESS_TERMS` has one row.
 *
 * ENTER IS ALWAYS THE SAFE ANSWER. It declines, which means "follow whatever I
 * write" — never "accept the guess". A captain who holds Enter through a prompt
 * they did not read must not end up pinned to `en-AU`, which is the exact
 * failure this file exists to stop.
 */

import * as readline from 'node:readline';

import { bold, cyan, dim, green, padEnd, visibleWidth } from './format.js';
import { LineReader } from './line-reader.js';
import {
  type BlueConfig,
  detectLanguage,
  localeVarInEffect,
  normalizeLanguage,
  saveConfig,
} from '../config/index.js';

/** Where the question is put, and how it is answered. */
export interface FirstRunIO {
  /** Defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** Defaults to `process.stdout`. */
  output?: NodeJS.WritableStream;
  /**
   * Overrides the terminal test. Nothing is asked without one: a launcher whose
   * stdin is a pipe has nobody to answer, and a question written to a log is a
   * hang.
   */
  interactive?: boolean;
}

/** One line of the menu, and what picking it means. */
export interface LanguageOption {
  /** What the captain types: "1", "2", … */
  key: string;
  /** The language as it goes into the config. */
  language: string;
  /** How the row reads. */
  label: string;
  /** Why this row is on the list — printed dim, after the label. */
  note?: string;
}

/**
 * Has this captain already answered, or is there nobody to ask?
 *
 * Answering includes declining: `languageAsked` records that the question was
 * PUT, which is the whole of what stops it being put twice.
 */
export function shouldAskLanguage(
  config: Pick<BlueConfig, 'language' | 'languageAsked'>,
  interactive: boolean,
): boolean {
  if (!interactive) return false;
  if (config.language !== undefined) return false;
  return config.languageAsked !== true;
}

/**
 * The menu, built from what this machine can actually tell us.
 *
 * The detected locale leads when there is one, because it is the answer most
 * captains will pick and because showing it by name is what makes declining it
 * an informed choice rather than a shrug. It is dropped when it duplicates a row
 * below — a `zh_CN` shell should not be offered Chinese twice.
 */
export function languageOptions(
  env: NodeJS.ProcessEnv = process.env,
): readonly LanguageOption[] {
  const detected = detectLanguage(env);
  const from = `detected from ${localeVarInEffect(env) ?? 'the environment'}`;
  const fixed = [
    { language: 'zh-CN', label: '中文', note: 'zh-CN' },
    { language: 'en', label: 'English', note: 'en' },
  ];

  // The shell's answer is always visible, whether it earned a row of its own or
  // landed on one that was already there. A captain on a `zh_CN` shell should
  // still be able to see that the machine agrees with them.
  const rows: Array<Omit<LanguageOption, 'key'>> = fixed.map((f) =>
    detected !== undefined && sameLanguage(f.language, detected)
      ? { ...f, note: `${f.note} · ${from}` }
      : f,
  );

  if (detected !== undefined && !fixed.some((f) => sameLanguage(f.language, detected))) {
    rows.unshift({ language: detected, label: detected, note: from });
  }

  return rows.map((r, i) => ({ ...r, key: String(i + 1) }));
}

/** `zh` and `zh-CN` are the same offer; `en` and `en-AU` are not. */
function sameLanguage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** What one typed line means. */
export type LanguageAnswer =
  | { kind: 'pick'; language: string }
  | { kind: 'decline' }
  | { kind: 'unreadable'; typed: string };

/**
 * Read one answer: a menu number, a language in any spelling `blue config set`
 * would take, or nothing at all.
 *
 * Free text is accepted for the same reason the setting accepts it — the value
 * is read by a model, not by a locale library, so "中文", "Simplified Chinese"
 * and "zh-CN" are all perfectly clear. It means a captain who types `日本語`
 * instead of a number gets what they asked for rather than a scolding.
 */
export function parseLanguageAnswer(
  raw: string,
  options: readonly LanguageOption[],
): LanguageAnswer {
  const typed = raw.trim();
  if (typed === '') return { kind: 'decline' };

  const picked = options.find((o) => o.key === typed);
  if (picked !== undefined) return { kind: 'pick', language: picked.language };

  // A number that is not on the menu is a misread menu, not a language named
  // "7". Saying so beats pinning the captain to a digit.
  if (/^\d+$/.test(typed)) return { kind: 'unreadable', typed };

  const language = normalizeLanguage(typed);
  if (language === undefined) return { kind: 'unreadable', typed };
  return { kind: 'pick', language };
}

/** How the question looks. Pure, so a test can read it without a terminal. */
export function languagePrompt(options: readonly LanguageOption[]): string {
  const L: string[] = [];
  L.push('');
  L.push(`${bold('BlueSpace')} ${dim('— one question, once.')}`);
  L.push('');
  L.push('Which language should Helm write to you in?');
  L.push('');
  const w = Math.max(...options.map((o) => visibleWidth(o.label)));
  for (const o of options) {
    const note = o.note !== undefined ? `  ${dim(o.note)}` : '';
    L.push(`  ${cyan(o.key)}  ${padEnd(o.label, w)}${note}`);
  }
  L.push('');
  L.push(dim('  Enter    skip — Helm follows whatever language you write to it in'));
  L.push(dim('  or type a language: ja, Español, 中文, Simplified Chinese, …'));
  L.push('');
  return L.join('\n');
}

/**
 * Put the question, persist the answer, and hand back the config to launch with.
 *
 * Never throws and never blocks a launch: a config that cannot be written is
 * reported and the window opens anyway. The captain came here to reach Helm, not
 * to fill in a form, and a failed write is a language guess — not a reason to
 * refuse them their fleet.
 */
export async function askLanguage(
  config: BlueConfig,
  io: FirstRunIO = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<BlueConfig> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const interactive =
    io.interactive ?? (input === process.stdin && process.stdin.isTTY === true);

  if (!shouldAskLanguage(config, interactive)) return config;

  const options = languageOptions(env);
  const write = (s: string): void => void output.write(`${s}\n`);
  write(languagePrompt(options));

  // ONE readline interface, read through a queue. `rl.question` registers a
  // one-shot listener, so a stream that flushes several lines in a tick — a
  // pipe, or a test — loses every line after the first, and the retry below
  // then answers itself with an empty string. `LineReader` is the fix `inbox.ts`
  // already had.
  const rl = readline.createInterface({
    input,
    output,
    terminal: interactive && input === process.stdin && process.stdin.isTTY === true,
  });
  const reader = new LineReader(rl);

  // Three tries, then treat it as declined. A prompt that will not take no for
  // an answer is worse than a wrong guess: this one stands between the captain
  // and the window they were opening.
  let answer: LanguageAnswer | undefined;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Not on a closed interface — `rl.prompt()` throws there, and a pipe that
      // flushed everything in one tick is closed while its lines are still
      // queued in front of us.
      if (!reader.ended) {
        rl.setPrompt(`${bold('›')} `);
        rl.prompt();
      }
      const typed = await reader.next();
      // End of input with nothing typed. Nobody answered — the terminal went
      // away, or they pressed Ctrl-D — so nothing is recorded and the question
      // survives for a launch where somebody is actually there. Recording it
      // would spend the one question this feature gets on an answer the captain
      // never gave.
      if (typed === null) break;
      answer = parseLanguageAnswer(typed, options);
      if (answer.kind !== 'unreadable') break;
      write(
        dim(`  "${answer.typed}" names no language on this menu. Try a number, a tag, or Enter to skip.`),
      );
    }
  } finally {
    rl.close();
  }

  if (answer === undefined) return config;

  const patch =
    answer.kind === 'pick'
      ? { language: answer.language, languageAsked: true }
      : { languageAsked: true };

  // The answer is applied to the config in hand and persisted separately, in
  // that order. `saveConfig` merges over what is on DISK and returns that — so
  // returning its result would quietly discard anything the caller had injected,
  // and the window would open with a config nobody assembled.
  const chosen: BlueConfig = { ...config, ...patch };
  try {
    saveConfig(patch);
  } catch (err) {
    write('');
    write(dim(`  Could not save that (${err instanceof Error ? err.message : String(err)}).`));
    write(dim('  Opening anyway — `blue config set language <lang>` when you have a moment.'));
    write('');
    return chosen;
  }

  write('');
  if (chosen.language !== undefined) {
    write(`  ${green('✓')} Helm writes to you in ${bold(chosen.language)}.`);
  } else {
    write(`  ${green('✓')} Helm follows whatever language you write to it in.`);
  }
  write(dim('    Change it any time:  blue config set language <lang>'));
  write('');
  return chosen;
}
