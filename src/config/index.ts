/**
 * Public surface of the config module.
 *
 * Two things live here: the global BlueConfig (defaults + `<dataDir>/config.json`)
 * and the ProjectRegistry (`<dataDir>/projects.json`), which remembers where the
 * captain's repos are without ever moving them.
 */

export type { BlueConfig } from './config.js';
export {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  configPath,
  dataDir,
  defaultConfig,
  ensureDataDir,
  loadConfig,
  saveConfig,
} from './config.js';

export type { ProjectMatch } from './projects.js';
export { PROJECTS_FILE, ProjectRegistry, ProjectRegistryError, slugify } from './projects.js';
