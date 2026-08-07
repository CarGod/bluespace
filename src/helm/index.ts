/**
 * Helm's own window, as a thing BlueSpace can see.
 *
 * Not to be confused with `src/agents/helm/`, which is Helm's LEVERS — the
 * `ToolDef`s it pulls. This module is the opposite direction: what that window
 * itself costs, read back off the transcript Claude Code writes for it.
 *
 * The split is the point. Nothing in `src/agents/helm/` knows a window exists;
 * nothing here knows what a task is.
 */

export {
  PROJECT_DIR_ENV,
  SESSION_ID_ENV,
  helmWindowFromEnv,
  readHelmWindowActivity,
  readHelmWindows,
} from './window.js';
export type { HelmSubagent, HelmWindowActivity, HelmWindowIdentity } from './window.js';
