/**
 * Registering repositories — one, or ninety.
 *
 * `ProjectRegistry.add` is metadata only: it never runs git. But registration is
 * not metadata only — a project cannot hold work until `blue/dev` exists in it,
 * and a repository with a branch named plain `blue` can never hold one at all.
 * That two-step (make the branch, then record the project) used to be written
 * out at both call sites, `blue projects add` and Helm's `add_project`, which is
 * how they drifted: only one of them had the `DevBranchConflictError` advice.
 * This module is that step, once.
 *
 * WHY BULK IS A FIRST-CLASS OPERATION AND NOT A LOOP AT THE CALL SITE.
 * Measured, from a real session: "把 ~/aulp 目录下所有的项目都加入管理" cost the
 * captain five `Glob` calls, ten `Read`s and eight separate `add_project`s —
 * about ninety seconds of watching a progress spinner to record eight lines of
 * JSON. Every one of those round trips was a model turn, and the model was the
 * slow part; the git work is milliseconds. A list in, a list out, one turn.
 *
 * PARTIAL SUCCESS IS THE NORMAL CASE, so nothing here throws for a bad entry.
 * Eight paths where the third is already registered and the sixth is not a repo
 * must register the other six and say precisely what happened to those two. An
 * exception would take the whole batch down for one directory the captain
 * probably knew was not a project.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DeliveryMode, Project } from '../types/domain.js';
import {
  DevBranchConflictError,
  INTEGRATION_BRANCH,
  ensureIntegrationBranch,
  type WorktreeManager,
} from '../worktree/index.js';
import type { ProjectRegistry } from './projects.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterDeps {
  registry: ProjectRegistry;
  /** The same per-project managers the orchestrator dispatches with. */
  worktreeFor(projectPath: string): WorktreeManager;
}

export interface RegisterInput {
  /** Absolute or `~`-relative path to a repository root. */
  path: string;
  /** Defaults to the directory name. */
  name?: string | undefined;
  /**
   * OPTIONAL, AND THAT IS THE POINT — see `registerProjects`. A description is
   * what `resolve_project` routes ambiguous requests by, so it is worth having;
   * it is not worth making the captain wait for.
   */
  description?: string | undefined;
  delivery?: DeliveryMode | undefined;
}

/** Why a path did not become a project. Each maps to advice the captain can act on. */
export type RegisterRefusal =
  /** The same repository is already in the registry. */
  | 'already_registered'
  /** No `.git` at that path — a directory, but not a repository root. */
  | 'not_a_repo'
  /** A branch named plain `blue` blocks `blue/dev`; the captain has to rename it. */
  | 'branch_conflict'
  /** Anything else: git failed, the path vanished, the registry would not write. */
  | 'failed';

export type RegisterOutcome =
  | {
      ok: true;
      path: string;
      project: Project;
      /** `blue/dev`, and whether this call created it or found it already there. */
      devBranch: string;
      devBranchCreated: boolean;
      /** The branch `blue/dev` was cut from. Absent when it already existed. */
      base?: string;
    }
  | {
      ok: false;
      path: string;
      reason: RegisterRefusal;
      message: string;
      /** Set on `already_registered`, so the caller can name the existing entry. */
      existing?: Project;
    };

// ---------------------------------------------------------------------------
// One repository
// ---------------------------------------------------------------------------

/**
 * Register one repository in place, creating `blue/dev` first.
 *
 * THE BRANCH IS MADE BEFORE THE REGISTRY ENTRY, and a repository that cannot
 * hold it is never registered at all. The other order leaves a project in the
 * registry that nothing can ever land, and surfaces the refusal inside a merge
 * weeks later instead of here.
 *
 * No prompt for the branch: `blue/dev` is namespaced with the task branches
 * (`blue/<taskId>`) precisely so it cannot collide with a branch a human already
 * has, which is what makes create-or-adopt safe to do silently.
 */
export async function registerProject(
  deps: RegisterDeps,
  input: RegisterInput,
): Promise<RegisterOutcome> {
  const given = input.path.trim();
  if (given === '') {
    return { ok: false, path: input.path, reason: 'failed', message: 'project path is required' };
  }

  // CANONICALISED FIRST, and everything below uses the result. The registry
  // stores realpaths so that a symlink, a relative path and `/tmp` vs
  // `/private/tmp` cannot register one repository twice; a duplicate check
  // against the spelling the captain typed would miss exactly those, hand the
  // collision to `registry.add`, and report it as a generic failure instead of
  // "you already have this one". It also keeps `worktreeFor` keyed on one string
  // per repository rather than one per spelling.
  const requested = safe(() => fs.realpathSync(path.resolve(expandHome(given))))
    ?? path.resolve(expandHome(given));

  // Checked here as well as inside `registry.add`, because the two failures want
  // different words: the registry's message is written for a caller, and
  // `already_registered` is not an error the captain needs to see as one.
  const existing = safe(() => deps.registry.getByPath(requested));
  if (existing !== undefined) {
    return {
      ok: false,
      path: requested,
      reason: 'already_registered',
      message: `already registered as "${existing.name}" (${existing.id})`,
      existing,
    };
  }

  if (!isRepositoryRoot(requested)) {
    // Split, because the two are different mistakes: a typo'd path and a
    // directory that is not a repository want different next moves, and "not a
    // git repository root: ~/coed/api" sends the captain looking for a .git that
    // was never the problem.
    return {
      ok: false,
      path: requested,
      reason: 'not_a_repo',
      message: isDirectory(requested)
        ? 'not a git repository root — BlueSpace works on repos in place, so point it at the directory containing .git'
        : 'no such directory',
    };
  }

  let branch: string;
  let created: boolean;
  let base: string;
  try {
    const setup = await ensureIntegrationBranch(deps.worktreeFor(requested), INTEGRATION_BRANCH);
    branch = setup.branch;
    created = setup.created;
    base = setup.base;
  } catch (err) {
    return {
      ok: false,
      path: requested,
      reason: err instanceof DevBranchConflictError ? 'branch_conflict' : 'failed',
      message: errorText(err),
    };
  }

  const named = input.name?.trim() ?? '';
  try {
    const project = deps.registry.add({
      // The registry insists on a name; the directory is the one the captain
      // would have used anyway, and they can rename it later.
      name: named !== '' ? named : path.basename(requested),
      path: requested,
      description: input.description ?? '',
      ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
      devBranch: branch,
    });
    return {
      ok: true,
      path: requested,
      project,
      devBranch: branch,
      devBranchCreated: created,
      ...(created ? { base } : {}),
    };
  } catch (err) {
    // `blue/dev` now exists in a repository that did not get registered. That is
    // a branch ref off the default branch with no commits on it, which is what
    // `add_project` was always allowed to write — and leaving it is better than
    // deleting a branch on a failure path we do not understand.
    return { ok: false, path: requested, reason: 'failed', message: errorText(err) };
  }
}

// ---------------------------------------------------------------------------
// Many repositories
// ---------------------------------------------------------------------------

/**
 * Register a batch, in order, reporting every path separately.
 *
 * Sequential rather than concurrent: each entry runs `git` in a different
 * repository, so there is nothing to contend on, but a deterministic order means
 * the report reads the same way twice and a half-finished batch is a prefix
 * rather than a scatter.
 *
 * DESCRIPTIONS ARE NOT A PRECONDITION. `add_project` used to insist on one, and
 * insisting is what turned "register these eight repos" into ten `Read` calls
 * before the first line of JSON was written — about fifty seconds of the ninety
 * the captain waited. A description is enrichment: it improves routing later, it
 * changes nothing about whether the project can hold work now. Register first,
 * describe after (`ProjectRegistry.update`, or Helm's `describe_project`).
 */
export async function registerProjects(
  deps: RegisterDeps,
  inputs: readonly RegisterInput[],
): Promise<RegisterOutcome[]> {
  const outcomes: RegisterOutcome[] = [];
  for (const input of inputs) {
    outcomes.push(await registerProject(deps, input));
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Finding repositories to register
// ---------------------------------------------------------------------------

/**
 * The repositories directly inside `dir` — the captain's `~/code`, `~/aulp`.
 *
 * ONE LEVEL, NOT A RECURSIVE WALK, and that is a deliberate refusal rather than
 * a shortcut. Descending finds vendored checkouts, `node_modules` with a stray
 * `.git`, submodule working copies and the odd backup, and registering those is
 * not what "把这个目录下所有的项目加入管理" meant — it is a registry the captain
 * then has to prune. One level is what a captain means by "the projects in this
 * directory"; anything else they can name by hand, and the array form of
 * `registerProjects` takes any list of paths at all.
 *
 * `dir` itself counts when it is a repository root, so pointing the scan at one
 * repo does the obvious thing instead of returning nothing.
 *
 * Sorted, because a scan whose order comes from the filesystem produces a
 * different report on every machine. Dot-directories are skipped: `.git`,
 * `.Trash`, `.cache` and friends are never what was meant.
 *
 * Returns [] for a path that is not a readable directory — the caller reports
 * that, and an exception here would take a whole batch down for one typo.
 */
export function findRepositories(dir: string): string[] {
  const root = path.resolve(expandHome(dir.trim()));

  if (isRepositoryRoot(root)) return [root];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // `Dirent.isDirectory()` is false for a symlink to one, so the check below
    // is on a stat that follows it: a captain who keeps
    // `~/code/api -> /Volumes/work/api` means that repository. The registry
    // realpaths it, so no repo can be added twice under two spellings.
    const child = path.join(root, entry.name);
    if (!isDirectory(child)) continue;
    if (isRepositoryRoot(child)) found.push(child);
  }
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The same rule `ProjectRegistry` applies, so a `~` path resolves identically. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Follows symlinks — a captain whose `~/code/api` points at a volume means that repo. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(path.resolve(expandHome(p))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A repository root is a directory holding a `.git` entry — a directory for a
 * normal clone, a FILE for a worktree or submodule checkout. The same rule
 * `ProjectRegistry.add` enforces, applied early so a scan never offers a path
 * the registry will refuse.
 */
export function isRepositoryRoot(p: string): boolean {
  const root = path.resolve(expandHome(p));
  if (!isDirectory(root)) return false;
  return fs.existsSync(path.join(root, '.git'));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
