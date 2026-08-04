/**
 * Crew brief tests.
 *
 * The brief is a wire format as much as it is prose: the orchestrator parses
 * `NEEDS-DECISION:` out of Crew output, and the isolation self-check is a safety
 * control. These tests pin the parts that must not drift, and the ordering the
 * brief depends on to be read correctly.
 */

import { describe, expect, it } from 'vitest';

import { buildBrief, NEEDS_DECISION_MARKER } from '../src/agents/crew/index.js';
import type { Project, Task } from '../src/types/domain.js';
import type { Worktree } from '../src/worktree/index.js';

const WORKTREE: Worktree = {
  path: '/var/blue/wt/task-1',
  branch: 'blue/task-1',
  repoPath: '/Users/captain/code/uploader',
  taskId: 'task-1',
};

const PROJECT: Project = {
  id: 'proj-1',
  name: 'uploader',
  path: '/Users/captain/code/uploader',
  description: 'S3 upload service',
  delivery: 'pr',
  addedAt: 0,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'mission',
    projectId: 'proj-1',
    title: 'Add retry to the uploader',
    brief: 'Retry failed uploads three times with backoff, log each attempt, and add a test.',
    state: 'dispatched',
    dependsOn: [],
    createdAt: 0,
    updatedAt: 0,
    costUsd: 0,
    reworkCount: 0,
    ...overrides,
  };
}

function brief(task: Task = makeTask()): string {
  return buildBrief({ task, project: PROJECT, worktree: WORKTREE, baseBranch: 'main' });
}

describe('NEEDS_DECISION_MARKER', () => {
  it('is exactly the string the orchestrator scans for', () => {
    // Not a style choice — changing this silently breaks escalation.
    expect(NEEDS_DECISION_MARKER).toBe('NEEDS-DECISION:');
  });
});

describe('buildBrief', () => {
  it('states that the worker is autonomous and unobserved', () => {
    const text = brief();
    expect(text).toMatch(/no human watching/i);
    expect(text).toMatch(/disposable git worktree/i);
  });

  it('carries the title and the full brief text', () => {
    const task = makeTask();
    const text = brief(task);
    expect(text).toContain(task.title);
    expect(text).toContain(task.brief);
  });

  it('spells out the isolation self-check with both commands and the expected path', () => {
    const text = brief();
    expect(text).toContain('pwd -P');
    expect(text).toContain('git rev-parse --show-toplevel');
    expect(text).toContain(WORKTREE.path);
    expect(text).toContain(WORKTREE.repoPath);
    expect(text).toMatch(/STOP IMMEDIATELY/);
    expect(text).toMatch(/do not commit/i);
  });

  it('names the branch it is on and the base branch to compare against', () => {
    const text = brief();
    expect(text).toContain(WORKTREE.branch);
    expect(text).toContain('git diff main...HEAD');
  });

  it('orders the sections so the self-check precedes any work', () => {
    const text = brief();
    const at = (heading: string) => text.indexOf(heading);
    const order = ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('reproduces the decision protocol with the exact marker and a stop instruction', () => {
    const text = brief();
    expect(text).toContain(NEEDS_DECISION_MARKER);
    expect(text).toMatch(/STOP and wait/);
    expect(text).toMatch(/destructive or irreversible/i);
    // The example line must itself be a valid marker line.
    const example = text
      .split('\n')
      .find((l) => l.startsWith(NEEDS_DECISION_MARKER) && l.length > NEEDS_DECISION_MARKER.length);
    expect(example).toBeDefined();
    expect(example).toMatch(/Options:/);
  });

  it('asks for sparse, outcome-led reporting', () => {
    const text = brief();
    expect(text).toMatch(/No step-by-step narration/i);
    expect(text).toMatch(/Lead with outcomes/i);
    expect(text).toMatch(/costs the captain attention/i);
  });
});

describe('buildBrief — mission', () => {
  it('says commit and leave it on the branch, and forbids pushing or opening a PR', () => {
    const text = brief();
    expect(text).toMatch(/Do NOT push/);
    expect(text).toMatch(/Do NOT open a pull request/);
    expect(text).toMatch(/Landing is the captain's call/);
    expect(text).toMatch(/no stubs/i);
  });

  it('warns that the Sentinel sees only the diff', () => {
    const text = brief();
    expect(text).toMatch(/never sees your reasoning/i);
    expect(text).toMatch(/Uncommitted work\s+is invisible/i);
  });

  it('does not tell a mission to write REPORT.md', () => {
    expect(brief()).not.toContain('REPORT.md');
  });
});

describe('buildBrief — recon', () => {
  const recon = () => brief(makeTask({ kind: 'recon', brief: 'Find out why uploads stall.' }));

  it('points at a standalone report inside the worktree', () => {
    const text = recon();
    expect(text).toContain('/var/blue/wt/task-1/REPORT.md');
    expect(text).toMatch(/standalone/i);
  });

  it('forbids modifying project code or committing anything but the report', () => {
    const text = recon();
    expect(text).toMatch(/Never modify project code/);
    expect(text).toMatch(/Commit nothing but the report/);
    expect(text).toMatch(/do not open a pull request/i);
  });
});
