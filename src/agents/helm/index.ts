/**
 * Helm — the one agent the captain talks to.
 *
 * This module owns Helm's levers, and nothing else:
 *   tools.ts   — the nine `ToolDef`s Helm uses to drive the fleet, described in
 *                JSON Schema so no harness SDK reaches this far up.
 *
 * Helm's *identity* is not here. It used to be: a `HELM_SYSTEM_PROMPT` constant
 * that `blue`'s REPL handed to `adapter.converse()`. Helm now runs inside the
 * captain's own Claude Code window, whose system prompt BlueSpace does not
 * write, so that constant had no consumer left — it was deleted rather than kept
 * as a second, unread copy of the persona that would drift out of agreement with
 * the copies that are read: `CLAUDE.md` and `skills/bluespace/SKILL.md`. Change
 * Helm's behaviour there.
 *
 * Helm decides *what* should be built. The orchestrator decides *when*, *in what
 * order*, and *what to do when it breaks*. Nothing in here dispatches or retries.
 */

export { helmTools } from './tools.js';
