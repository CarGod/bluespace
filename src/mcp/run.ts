/**
 * `blue mcp` — the entry point the captain's Claude Code window launches.
 *
 * Registered once in an MCP config as a stdio server, this process becomes
 * BlueSpace's front door: the window it was launched from is where the captain
 * talks to Helm, and `mcp__bluespace__*` are the levers Helm pulls. There is no
 * REPL to replace it, and there is nothing here that a person types into.
 *
 * Two things happen for as long as the pipe is open:
 *
 *  1. Helm's `ToolDef`s are served, verbatim. `helmTools(...)` is called once
 *     and handed straight to the transport — a fork of those handlers would be
 *     a second control surface that drifts from the first.
 *
 *  2. The orchestrator's dispatch loop runs. `create_task` only enqueues; if
 *     nothing is turning the crank, every task the captain asks for sits in
 *     `queued` forever and Helm reports it, correctly and uselessly, as queued.
 *
 * And one thing happens once, at startup: the window this server was launched
 * from is written into the Blackbox — see `registerHelmWindow`. It is the only
 * process in BlueSpace that knows which session the captain is talking to Helm
 * in, and without that one line Helm's own fan-out is unaccountable.
 *
 * The process owns stdout completely — see `./server.js` — so nothing here
 * prints. Everything a human might need to read goes to stderr, which the client
 * captures into its MCP log.
 */

import { helmTools, type HelmToolDeps } from '../agents/helm/index.js';
import type { Blackbox } from '../blackbox/index.js';
import type { ProjectRegistry } from '../config/index.js';
import { helmWindowFromEnv } from '../helm/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { MCP_SERVER_NAME, serveMcp } from './server.js';

export interface RunMcpOptions {
  orch: Orchestrator;
  registry: ProjectRegistry;
  /**
   * What the delivery tools need: the log to record a merge in, and the git
   * managers to perform it with. Threaded from `blue mcp`, which already has
   * both — see `boot()` in `src/cli/index.ts`.
   */
  deps: HelmToolDeps;
  /**
   * Run the dispatch loop for the lifetime of the connection. Default true;
   * false is for a second `blue mcp` attached to the same data directory, where
   * two loops would race each other over the same queue.
   */
  orchestrate?: boolean;
  /** Overridable so a test can drive this without owning the real pipes. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  diagnostics?: NodeJS.WritableStream;
  /** Where the Helm window's identity is read from. Overridable for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Record which Helm window this server is serving, once, at startup.
 *
 * WHY HERE AND NOWHERE ELSE. Helm's sub-agents are the only consumer of the
 * captain's quota that BlueSpace has never been able to see — Helm runs in their
 * terminal, under no orchestrator, and two sub-agents once spent 282k tokens in
 * two minutes with `blue ps` showing nothing. The fix is not to watch that
 * window (nothing here can) but to write down where its transcript is, so `blue
 * ps` can read it afterwards. This process is the only one that knows: the
 * harness hands its MCP servers the launching window's `CLAUDE_CODE_SESSION_ID`.
 *
 * ONE LINE, AND IT NEVER STOPS THE SERVER. Not being in a Helm window is
 * ordinary (`blue mcp` under another client, or run by hand) and yields nothing
 * to write. A Blackbox that will not accept the event is a data directory
 * problem the tools are about to report anyway, and refusing to serve Helm over
 * a bookkeeping row would trade the whole fleet for its accounting.
 */
export function registerHelmWindow(
  blackbox: Blackbox,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const window = helmWindowFromEnv(env);
  if (window === undefined) return false;
  try {
    blackbox.append({
      type: 'helm.window_opened',
      sessionId: window.sessionId,
      cwd: window.cwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Serve until the client hangs up or the process is asked to stop.
 *
 * Resolves with the exit code. The dispatch loop is stopped on the way out;
 * whatever a Crew was doing survives in the Blackbox, because every state
 * BlueSpace has is a fold over that log rather than something held here.
 */
export async function runMcp(options: RunMcpOptions): Promise<number> {
  const { orch, registry, deps } = options;
  const orchestrate = options.orchestrate !== false;

  // Before the loop and before the transport: the captain can fan out on their
  // very first turn, and a window registered after that turn would have its
  // opening sub-agents attributed to nothing.
  registerHelmWindow(deps.blackbox, options.env);

  if (orchestrate) orch.start();

  const serveOptions: Parameters<typeof serveMcp>[0] = {
    tools: helmTools(orch, registry, deps),
    serverName: MCP_SERVER_NAME,
  };
  if (options.input !== undefined) serveOptions.input = options.input;
  if (options.output !== undefined) serveOptions.output = options.output;
  if (options.diagnostics !== undefined) serveOptions.diagnostics = options.diagnostics;

  const server = serveMcp(serveOptions);

  // A client that goes away kills this process outright as a rule, but a
  // captain who quits their window politely sends a signal first, and a
  // half-dispatched task is worth the two lines it takes to shut down cleanly.
  const stop = (): void => server.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await server.closed;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (orchestrate) {
      try {
        orch.stop();
      } catch {
        /* stopping a loop that never started is not an error */
      }
    }
  }

  return 0;
}
