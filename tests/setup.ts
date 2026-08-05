/**
 * Test bootstrap — keep the suite hermetic.
 *
 * A couple of variables are read straight from the ambient environment (the CLI
 * path override, and the API key `resolveAuth` reports on). A developer who
 * happens to have either one set should not get different test results from CI,
 * so both are cleared here. Tests that care about them pass an explicit env
 * object instead of mutating the real one.
 */

delete process.env['ANTHROPIC_API_KEY'];
delete process.env['CLAUDE_CLI_PATH'];
