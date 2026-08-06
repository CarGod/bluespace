/**
 * Blackbox — BlueSpace's append-only event log and the projections over it.
 *
 * This is the only module that persists anything. Everything the captain sees
 * (task state, cost, the decision inbox, a crew's transcript) is derived here
 * by folding events, never by reading a mutable row. Import from this file;
 * `store.ts` and `projections.ts` are implementation detail.
 */

export { Blackbox, crewIdOf, taskIdOf } from './store.js';
export type { ReadOptions, Subscriber } from './store.js';

export {
  UNKNOWN_MODEL,
  projectAllDecisions,
  projectCost,
  projectCrewLog,
  projectOpenDecisions,
  projectTask,
  projectTasks,
  projectUsage,
} from './projections.js';
export type { CostProjection, UsageProjection } from './projections.js';
