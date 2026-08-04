/**
 * The project registry — `<dataDir>/projects.json`.
 *
 * BlueSpace references repos IN PLACE, by absolute path. It never clones,
 * copies, or "imports" a project into its own directory, and it never asks the
 * captain to move their work somewhere else to be managed. Your repo stays
 * exactly where it is; BlueSpace just remembers where that is, what it's for,
 * and how work should be delivered back (PR or local branch).
 *
 * The registry also owns `resolve(hint)`, which is what lets the captain say
 * "fix the login test" instead of "run task X against project
 * bluespace-7f2a1c". Helm calls it, ranks the candidates, and asks the captain
 * only when the answer is genuinely ambiguous. The scoring is therefore tiered
 * and fully deterministic — same registry plus same hint always yields the same
 * order, because a disambiguation prompt that reshuffles between runs is worse
 * than no prompt at all.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { DeliveryMode, PermissionMode, Project, ProjectId } from '../types/domain.js';
import { PERMISSION_MODES, errText, readJsonObject, writeJsonAtomic } from './config.js';

export const PROJECTS_FILE = 'projects.json';

/** Thrown for every rejected `add()`: missing path, not a repo, duplicate. */
export class ProjectRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRegistryError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warn(message: string): void {
  console.warn(`[bluespace:projects] ${message}`);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** lowercase, alphanumerics and dashes only, no leading/trailing dash. */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug === '' ? 'project' : slug;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 6);
}

/**
 * Turn one stored entry into a Project, or undefined if it is too broken to
 * use. Missing optional fields are filled in rather than rejected, so a file
 * written by an older BlueSpace still loads.
 */
function parseProject(value: unknown): Project | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '') return undefined;
  if (typeof r.path !== 'string' || r.path === '') return undefined;

  const project: Project = {
    id: r.id,
    name: typeof r.name === 'string' && r.name !== '' ? r.name : path.basename(r.path),
    path: r.path,
    description: typeof r.description === 'string' ? r.description : '',
    delivery: r.delivery === 'local' ? 'local' : 'pr',
    addedAt: typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) ? r.addedAt : 0,
  };
  if (
    typeof r.permissionMode === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(r.permissionMode)
  ) {
    project.permissionMode = r.permissionMode as PermissionMode;
  }
  if (typeof r.defaultBranch === 'string' && r.defaultBranch !== '') {
    project.defaultBranch = r.defaultBranch;
  }
  return project;
}

// ---------------------------------------------------------------------------
// resolve() scoring
// ---------------------------------------------------------------------------

/**
 * Tiers are 100 apart and token bonuses are capped below 100, so a better tier
 * always beats any amount of incidental token overlap.
 */
const TIER = {
  exactId: 1000,
  exactName: 900,
  idPrefix: 800,
  /** hint is contained in the name — "blue" matching "bluespace" */
  hintInName: 700,
  /** name is contained in the hint — "login" inside "fix the login test" */
  nameInHint: 650,
  hintInDescription: 500,
  basename: 300,
} as const;

const TOKEN_BONUS_CAP = 99;

/** Filler words that would otherwise create noise matches in long hints. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'that',
  'this',
  'please',
  'there',
  'then',
  'them',
  'was',
  'are',
]);

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokens(s: string): string[] {
  return norm(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export interface ProjectMatch {
  project: Project;
  score: number;
}

function scoreProject(project: Project, hint: string, hintTokens: string[]): number {
  const h = norm(hint);
  const id = norm(project.id);
  const name = norm(project.name);
  const description = norm(project.description);
  const base = norm(path.basename(project.path));

  let tier = 0;
  if (h === id) tier = Math.max(tier, TIER.exactId);
  if (h === name && name !== '') tier = Math.max(tier, TIER.exactName);
  if (h.length >= 3 && id.startsWith(h)) tier = Math.max(tier, TIER.idPrefix);
  if (h.length >= 2 && name !== '' && name.includes(h)) tier = Math.max(tier, TIER.hintInName);
  if (name.length >= 3 && h.includes(name)) tier = Math.max(tier, TIER.nameInHint);
  if (h.length >= 3 && description !== '' && description.includes(h)) {
    tier = Math.max(tier, TIER.hintInDescription);
  }
  if (h.length >= 2 && (base.includes(h) || (base.length >= 3 && h.includes(base)))) {
    tier = Math.max(tier, TIER.basename);
  }

  // Token overlap: refines the order inside a tier, and lets a multi-word hint
  // ("fix the login test") reach a project it never literally contains.
  const nameTokens = new Set(tokens(project.name));
  const descTokens = new Set(tokens(project.description));
  const baseTokens = new Set(tokens(path.basename(project.path)));
  let bonus = 0;
  for (const t of hintTokens) {
    if (nameTokens.has(t)) bonus += 30;
    else if (name.includes(t)) bonus += 20;
    else if (descTokens.has(t)) bonus += 10;
    else if (description.includes(t)) bonus += 5;
    else if (baseTokens.has(t)) bonus += 8;
    else if (base.includes(t)) bonus += 3;
  }
  bonus = Math.min(bonus, TOKEN_BONUS_CAP);

  return tier + bonus;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ProjectRegistry {
  readonly dir: string;
  readonly file: string;

  #projects: Project[] = [];
  /** Cheap change detector so a long-lived server sees the CLI's writes. */
  #stamp = '';

  private constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, PROJECTS_FILE);
  }

  /** Open (and read) the registry stored in `dir` — normally the data dir. */
  static open(dir: string): ProjectRegistry {
    const reg = new ProjectRegistry(path.resolve(expandHome(dir)));
    reg.#load();
    return reg;
  }

  // -- reads ---------------------------------------------------------------

  list(): Project[] {
    this.#refresh();
    return this.#projects.map((p) => ({ ...p }));
  }

  get(id: ProjectId): Project | undefined {
    this.#refresh();
    const found = this.#projects.find((p) => p.id === id);
    return found === undefined ? undefined : { ...found };
  }

  /** Look up by absolute path (already-realpath'd), for duplicate checks. */
  getByPath(repoPath: string): Project | undefined {
    this.#refresh();
    const resolved = path.resolve(expandHome(repoPath));
    const found = this.#projects.find((p) => p.path === resolved);
    return found === undefined ? undefined : { ...found };
  }

  /**
   * Fuzzy-match a free-text hint against the registry, best first.
   *
   * Ranking, highest to lowest: exact id, exact name, id prefix, hint inside
   * the name, name inside the hint, hint inside the description, path basename.
   * Ties break on token overlap, then most-recently-added, then id — so the
   * order never depends on filesystem or map iteration order.
   *
   * Returns [] when the hint is empty or nothing scores above zero.
   */
  resolve(hint: string): Project[] {
    this.#refresh();
    const h = norm(hint);
    if (h === '') return [];
    const hintTokens = tokens(hint);
    const scored: ProjectMatch[] = [];
    for (const project of this.#projects) {
      const score = scoreProject(project, h, hintTokens);
      if (score > 0) scored.push({ project, score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.project.addedAt !== a.project.addedAt) return b.project.addedAt - a.project.addedAt;
      return a.project.id < b.project.id ? -1 : a.project.id > b.project.id ? 1 : 0;
    });
    return scored.map((m) => ({ ...m.project }));
  }

  /** Same as `resolve` but keeps the scores — useful for CLI/Helm debugging. */
  resolveScored(hint: string): ProjectMatch[] {
    const h = norm(hint);
    if (h === '') return [];
    const hintTokens = tokens(hint);
    return this.resolve(hint).map((project) => ({
      project,
      score: scoreProject(project, h, hintTokens),
    }));
  }

  // -- writes --------------------------------------------------------------

  /**
   * Register a repo in place. The path must exist and be a git repo root (it
   * must contain a `.git` entry — a directory for a normal clone, a file for a
   * worktree or submodule checkout).
   */
  add(input: { name: string; path: string; description: string; delivery?: DeliveryMode }): Project {
    this.#refresh();

    const name = input.name.trim();
    if (name === '') throw new ProjectRegistryError('project name is required');

    const requested = input.path.trim();
    if (requested === '') throw new ProjectRegistryError('project path is required');

    // Resolve to a canonical absolute path so two spellings of the same repo
    // (symlink, relative path, /tmp vs /private/tmp) cannot both be registered.
    const absolute = path.resolve(expandHome(requested));
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch (err) {
      throw new ProjectRegistryError(`no such directory: ${absolute} (${errText(err)})`);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      throw new ProjectRegistryError(`cannot stat ${real}: ${errText(err)}`);
    }
    if (!stat.isDirectory()) {
      throw new ProjectRegistryError(`not a directory: ${real}`);
    }
    if (!fs.existsSync(path.join(real, '.git'))) {
      throw new ProjectRegistryError(
        `not a git repository root: ${real} — BlueSpace works on repos in place, so point it at the directory containing .git`,
      );
    }

    const duplicate = this.#projects.find((p) => p.path === real);
    if (duplicate !== undefined) {
      throw new ProjectRegistryError(
        `already registered as "${duplicate.name}" (${duplicate.id}): ${real}`,
      );
    }

    const project: Project = {
      id: this.#mintId(name),
      name,
      path: real,
      description: input.description.trim(),
      delivery: input.delivery ?? 'pr',
      addedAt: Date.now(),
    };

    this.#projects.push(project);
    this.#persist();
    return { ...project };
  }

  /** Forget a project. Idempotent: removing an unknown id is a no-op. */
  remove(id: ProjectId): void {
    this.#refresh();
    const next = this.#projects.filter((p) => p.id !== id);
    if (next.length === this.#projects.length) return;
    this.#projects = next;
    this.#persist();
  }

  /** Patch the mutable fields of a registered project. */
  update(
    id: ProjectId,
    patch: Partial<Pick<Project, 'name' | 'description' | 'delivery' | 'permissionMode' | 'defaultBranch'>>,
  ): Project {
    this.#refresh();
    const index = this.#projects.findIndex((p) => p.id === id);
    const current = this.#projects[index];
    if (index < 0 || current === undefined) {
      throw new ProjectRegistryError(`unknown project: ${id}`);
    }
    const next: Project = { ...current };
    if (patch.name !== undefined && patch.name.trim() !== '') next.name = patch.name.trim();
    if (patch.description !== undefined) next.description = patch.description.trim();
    if (patch.delivery !== undefined) next.delivery = patch.delivery;
    if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;
    if (patch.defaultBranch !== undefined) next.defaultBranch = patch.defaultBranch;
    this.#projects[index] = next;
    this.#persist();
    return { ...next };
  }

  // -- internals -----------------------------------------------------------

  #mintId(name: string): string {
    const slug = slugify(name);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${slug}-${shortId()}`;
      if (!this.#projects.some((p) => p.id === candidate)) return candidate;
    }
    return `${slug}-${randomUUID()}`;
  }

  #stampOf(): string {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  }

  /** Reload only when the file on disk changed since we last read it. */
  #refresh(): void {
    if (this.#stampOf() !== this.#stamp) this.#load();
  }

  #load(): void {
    this.#stamp = this.#stampOf();
    const raw = readJsonObject(this.file, 'project registry');
    if (raw === undefined) {
      this.#projects = [];
      return;
    }
    const list = raw.projects;
    if (!Array.isArray(list)) {
      warn(`${this.file} has no "projects" array — starting empty`);
      this.#projects = [];
      return;
    }
    const kept: Project[] = [];
    for (const entry of list) {
      const parsed = parseProject(entry);
      if (parsed === undefined) {
        warn(`dropping malformed project entry in ${this.file}: ${JSON.stringify(entry)}`);
        continue;
      }
      if (kept.some((p) => p.id === parsed.id)) {
        warn(`dropping duplicate project id in ${this.file}: ${parsed.id}`);
        continue;
      }
      kept.push(parsed);
    }
    this.#projects = kept;
  }

  #persist(): void {
    writeJsonAtomic(this.file, { version: 1, projects: this.#projects });
    this.#stamp = this.#stampOf();
  }
}
