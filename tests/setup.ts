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
// Same reason, third variable: it relocates `.claude.json`, and the workspace
// trust check reads that file. A developer who has it set would otherwise be
// asking a different question from the one CI asks.
delete process.env['CLAUDE_CONFIG_DIR'];
