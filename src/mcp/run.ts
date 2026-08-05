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
 *  1. The nine `ToolDef`s are served, verbatim. `helmTools(orch, registry)` is
 *     called once and handed straight to the transport — a fork of those
 *     handlers would be a second control surface that drifts from the first.
 *
 *  2. The orchestrator's dispatch loop runs. `create_task` only enqueues; if
 *     nothing is turning the crank, every task the captain asks for sits in
 *     `queued` forever and Helm reports it, correctly and uselessly, as queued.
 *
 * The process owns stdout completely — see `./server.js` — so nothing here
 * prints. Everything a human might need to read goes to stderr, which the client
 * captures into its MCP log.
 */

import { helmTools } from '../agents/helm/index.js';
import type { ProjectRegistry } from '../config/index.js';
import type { Orchestrator } from '../orchestrator/index.js';
import { MCP_SERVER_NAME, serveMcp } from './server.js';

export interface RunMcpOptions {
  orch: Orchestrator;
  registry: ProjectRegistry;
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
}

/**
 * Serve until the client hangs up or the process is asked to stop.
 *
 * Resolves with the exit code. The dispatch loop is stopped on the way out;
 * whatever a Crew was doing survives in the Blackbox, because every state
 * BlueSpace has is a fold over that log rather than something held here.
 */
export async function runMcp(options: RunMcpOptions): Promise<number> {
  const { orch, registry } = options;
  const orchestrate = options.orchestrate !== false;

  if (orchestrate) orch.start();

  const serveOptions: Parameters<typeof serveMcp>[0] = {
    tools: helmTools(orch, registry),
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
