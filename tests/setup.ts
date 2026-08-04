/**
 * Test bootstrap.
 *
 * The Claude adapter refuses to run without explicit API-key auth, because the
 * SDK would otherwise resolve whatever credential is lying around on a developer
 * machine — usually a claude.ai login, which Anthropic does not permit for
 * SDK-built agents. The suite mocks the SDK and never opens a socket, but it must
 * still travel the same auth path a real run does, so it supplies a fake key here
 * rather than special-casing the guard away.
 *
 * Setting it unconditionally also stops a developer's real key from leaking into a
 * test run.
 */
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-not-a-real-key';

/** Never let a machine-level opt-out change what the suite is actually testing. */
delete process.env['BLUESPACE_INHERIT_AUTH'];
