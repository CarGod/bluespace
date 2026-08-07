/**
 * `blue ps`'s horizon — the one place BlueSpace deliberately leaves something
 * true off the screen.
 *
 * The rule it replaces: sort terminal tasks last and show them for ever. That is
 * not a status view, it is an archive with a status view at the top of it, and
 * the captain's complaint was exactly that — two dead tasks he could not get out
 * of his way, with no command to end anything either.
 *
 * What must stay true whatever the horizon is: nothing in flight is ever hidden,
 * the count of what was hidden is available to print, and `--all` is the whole
 * log. Nothing is deleted anywhere; the Blackbox is append-only.
 */

import { describe, expect, it } from 'vitest';

import { PS_HORIZON_MS, psView } from '../src/cli/ps.js';
import { noTokenUsage } from '../src/types/domain.js';
import type { Task, TaskState } from '../src/types/domain.js';

const NOW = 1_800_000_000_000;

function task(state: TaskState, finishedAgoMs: number): Task {
  return {
    id: `t-${state}-${finishedAgoMs}`,
    kind: 'mission',
    projectId: 'proj-1',
    title: `${state} task`,
    brief: 'brief',
    state,
    dependsOn: [],
    createdAt: NOW - finishedAgoMs - 60_000,
    updatedAt: NOW - finishedAgoMs,
    tokens: noTokenUsage(),
    metered: false,
    listPriceUsd: 0,
    reworkCount: 0,
  };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe('psView', () => {
  it('keeps what is in flight and drops what finished long ago', () => {
    const tasks = [
      task('working', 0),
      task('landed', 10 * MINUTE),
      task('failed', 3 * DAY),
      task('cancelled', 3 * DAY),
    ];

    const view = psView(tasks, { now: NOW });

    expect(view.shown.map((t) => t.state)).toEqual(['working', 'landed']);
    expect(view.elided).toBe(2);
  });

  it('never elides a task that is still in flight, however old it is', () => {
    // A task stuck for a week is the single most important row on the screen.
    // A horizon that hid it would turn a status view into a recency view.
    const ancient = [
      task('queued', 30 * DAY),
      task('working', 30 * DAY),
      task('awaiting_decision', 30 * DAY),
      task('needs_rework', 30 * DAY),
      task('verifying', 30 * DAY),
      task('ready', 30 * DAY),
    ];

    const view = psView(ancient, { now: NOW });

    expect(view.shown).toHaveLength(ancient.length);
    expect(view.elided).toBe(0);
  });

  it('measures the horizon from when the task finished, not when it was asked for', () => {
    // A month-long mission that landed an hour ago is news; `createdAt` would
    // have called it history.
    const long = task('landed', MINUTE);
    long.createdAt = NOW - 30 * DAY;

    expect(psView([long], { now: NOW }).shown).toHaveLength(1);
  });

  it('draws the line at exactly one horizon', () => {
    const justInside = task('landed', PS_HORIZON_MS - MINUTE);
    const justOutside = task('landed', PS_HORIZON_MS + MINUTE);

    const view = psView([justInside, justOutside], { now: NOW });

    expect(view.shown).toEqual([justInside]);
    expect(view.elided).toBe(1);
  });

  it('shows the whole log on --all, and reports nothing as elided', () => {
    const tasks = [task('working', 0), task('failed', 90 * DAY)];

    const view = psView(tasks, { all: true, now: NOW });

    expect(view.shown).toHaveLength(2);
    // The caller prints "… and N older" from this; claiming an elision that did
    // not happen would be as wrong as hiding one silently.
    expect(view.elided).toBe(0);
  });

  it('can elide everything, which is what a quiet fleet with a history looks like', () => {
    // The case the CLI has to word carefully: no rows is the right answer, and
    // "nothing in flight" plus the count is what it says instead of a blank.
    const view = psView([task('landed', 5 * DAY), task('landed', 6 * DAY)], { now: NOW });

    expect(view.shown).toEqual([]);
    expect(view.elided).toBe(2);
  });
});
