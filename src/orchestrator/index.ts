/**
 * Public surface of the orchestrator — the fleet's engine room.
 *
 * Helm decides *what* should happen; everything in here decides *when*, *in
 * what order*, *how many at once*, and *what to do when it breaks*. It is
 * ordinary deterministic code on purpose: the parts of an agent system that
 * must be predictable under failure are exactly the parts that should not be
 * delegated to a model.
 *
 * `orchestrator.ts` is the engine, `statemachine.ts` is the law it obeys.
 */

export {
  ABANDON_OPTION_ID,
  DECISION_MARKER,
  Orchestrator,
  parseDecisionRequest,
  reworkMessage,
} from './orchestrator.js';
export type {
  CreateTaskInput,
  DecisionRequest,
  OrchestratorDeps,
  SentinelRunner,
} from './orchestrator.js';

export {
  IllegalTransitionError,
  TASK_TRANSITIONS,
  assertTransition,
  canTransition,
  legalTargets,
  pathTo,
} from './statemachine.js';
