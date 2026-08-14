/**
 * The page is a single file with no build step, so nothing type-checks it. These
 * are the assertions that would otherwise be a comment asking the next person to
 * be careful.
 *
 * The one that matters: the Starmap board draws a column for EVERY task state,
 * empty or not, because an absent column reads as "this cannot happen here" and
 * the empty columns are how a captain learns that `needs_rework` and
 * `awaiting_decision` exist before one of them is holding up their work. That
 * only stays true if the page's list and the domain's list are the same list.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TASK_STATES } from '../src/types/domain.js';

const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
const page = await fs.readFile(pagePath, 'utf8');

/** The literal array or object-key list the page declares for `name`. */
function declared(name: string): string[] {
  const arr = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(page);
  if (arr) return [...arr[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  const obj = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(page);
  expect(obj, `${name} not found in web/index.html`).not.toBeNull();
  // Keys only where a key can start — after `{`, after a comma, or at the start
  // of a line. The page puts several on one line, and a value is allowed to
  // contain a colon.
  return [...obj![1]!.matchAll(/(?:^|[{,])\s*([a-z_]+):/gm)].map((m) => m[1]!);
}

/** The string values a dictionary-shaped `const` declares. */
function declaredValues(name: string): string[] {
  const obj = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(page);
  expect(obj, `${name} not found in web/index.html`).not.toBeNull();
  return [...obj![1]!.matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
}

describe('the Starmap page and the domain agree about states', () => {
  it('draws a column for every state the domain can produce', () => {
    expect([...declared('STATES')].sort()).toEqual([...TASK_STATES].sort());
  });

  it('gives every state a label', () => {
    expect(declared('STATE_LABEL').sort()).toEqual([...TASK_STATES].sort());
  });

  it('explains every state in one line, including the ones usually empty', () => {
    // The help text is the whole reason an empty column earns its space.
    expect(declared('STATE_HELP').sort()).toEqual([...TASK_STATES].sort());
  });

  it('gives every state a colour', () => {
    expect(declared('STATE_VAR').sort()).toEqual([...TASK_STATES].sort());
  });

  it('translates every state name and every explanation', () => {
    // The page falls back to English for a missing translation rather than
    // rendering a blank — but a captain who picked 中文 and gets half a screen
    // of English has been told the toggle works when it does not.
    const zh = new Set([...page.matchAll(/^  '((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]!));
    const needed = [
      ...declaredValues('STATE_LABEL'),
      ...declaredValues('STATE_HELP'),
      ...[...page.matchAll(/tr\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!),
    ];
    expect(needed.filter((k) => !zh.has(k))).toEqual([]);
  });

  it('never drops a state group for being empty', () => {
    // The old board did `if (!list.length) return ''`. That is the line this
    // test exists to stop coming back.
    expect(page).not.toMatch(/if \(!list\.length\) return '';/);
    expect(page).toContain('slot-empty');
  });
});
