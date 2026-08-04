/**
 * Helm — the one agent the captain talks to.
 *
 * This module owns Helm's identity and its levers, and nothing else:
 *   prompt.ts  — HELM_SYSTEM_PROMPT, the intake-and-judgement voice.
 *   tools.ts   — the nine `ToolDef`s Helm uses to drive the fleet, described in
 *                JSON Schema so no harness SDK reaches this far up.
 *
 * Helm decides *what* should be built. The orchestrator decides *when*, *in what
 * order*, and *what to do when it breaks*. Nothing in here dispatches, retries, or
 * tears anything down.
 */

export { HELM_SYSTEM_PROMPT } from './prompt.js';
export { helmTools } from './tools.js';
