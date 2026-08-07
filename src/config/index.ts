/**
 * Public surface of the config module.
 *
 * Two things live here: the global BlueConfig (defaults + `<dataDir>/config.json`)
 * and the ProjectRegistry (`<dataDir>/projects.json`), which remembers where the
 * captain's repos are without ever moving them.
 */

export type { BlueConfig, CaptainVoice, ConfigPatch } from './config.js';
export {
  DEFAULT_ADDRESS,
  DEFAULT_HELM_POSTURE,
  DEFAULT_MAX_TOKENS_PER_TASK,
  EFFORT_LEVELS,
  LOCALE_ENV_VARS,
  MIRROR_VOICE,
  PERMISSION_MODES,
  addressTerm,
  canonicalLanguageTag,
  configPath,
  dataDir,
  defaultConfig,
  detectLanguage,
  ensureDataDir,
  loadConfig,
  localeVarInEffect,
  normalizeLanguage,
  resolveCaptainVoice,
  resolveHelmPosture,
  saveConfig,
} from './config.js';

export type { ProjectMatch } from './projects.js';
export { PROJECTS_FILE, ProjectRegistry, ProjectRegistryError, slugify } from './projects.js';

export type {
  RegisterDeps,
  RegisterInput,
  RegisterOutcome,
  RegisterRefusal,
} from './register.js';
export {
  findRepositories,
  isRepositoryRoot,
  registerProject,
  registerProjects,
} from './register.js';
