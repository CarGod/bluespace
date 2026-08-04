/**
 * Test bootstrap — keep the suite hermetic.
 *
 * The adapter reads a couple of variables straight from the ambient environment
 * (the CLI path override, and any API key the SDK would prefer). A developer who
 * happens to have either one set should not get different test results from CI,
 * so both are cleared here. Tests that care about them pass an explicit env
 * object instead of mutating the real one.
 */

delete process.env['ANTHROPIC_API_KEY'];
delete process.env['CLAUDE_CLI_PATH'];
