/**
 * Public surface of the MCP module — BlueSpace's front door.
 *
 * `server.ts` is the transport: newline-delimited JSON-RPC 2.0 over a pair of
 * pipes, hand-written because the three methods in use do not justify a
 * dependency. `run.ts` is the `blue mcp` entry point that hands it Helm's nine
 * tools and turns the orchestrator's crank while the client is connected.
 *
 * Nothing above this module knows it exists except the CLI command that starts
 * it, and nothing inside it knows what a task is — it calls `ToolDef` handlers.
 */

export {
  FrameReader,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  McpDispatcher,
  SUPPORTED_PROTOCOL_VERSIONS,
  parseFrame,
  serveMcp,
} from './server.js';
export type { McpDispatcherOptions, McpServeOptions, McpServerHandle } from './server.js';

export { registerHelmWindow, runMcp } from './run.js';
export type { RunMcpOptions } from './run.js';
