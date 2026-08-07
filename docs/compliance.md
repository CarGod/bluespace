# Credentials and compliance

BlueSpace runs Claude. Which credential it runs Claude *with* is an architectural
decision, not a configuration detail, and this document is the reasoning behind
the one the code makes. Read it before changing how workers are launched.

**This is a reasoned position, not a ruling from Anthropic.** Nobody at Anthropic
has reviewed BlueSpace. If you need certainty rather than a defensible reading,
use an API key (below) or ask them — the docs invite exactly that.

---

## The rule

From [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
quoted in full because paraphrasing it is how people get this wrong:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free,
> Pro, Max, Team, and Enterprise subscription plans and is designed to support
> **ordinary use of Claude Code and other native Anthropic applications**.
>
> **Developers** building products or services that interact with Claude's
> capabilities, **including those using the Agent SDK, should use API key
> authentication** through Claude Console or a supported cloud provider.
> Anthropic does not permit third-party developers to offer Claude.ai login or
> to route requests through Free, Pro, or Max plan credentials on behalf of
> their users.
>
> Anthropic reserves the right to take measures to enforce these restrictions
> and may do so without prior notice.

And the limits clause on the same page:

> Advertised usage limits for Pro and Max plans assume **ordinary, individual
> usage** of Claude Code and the Agent SDK.

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and
[Quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) each repeat:

> Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, **including agents
> built on the Claude Agent SDK**. Use the API key authentication methods
> described in the Quickstart instead.

The Quickstart's own authentication section teaches four credential paths —
`ANTHROPIC_API_KEY`, Bedrock, Vertex, Foundry. A subscription login is not one
of them.

## Where the line falls

Anthropic's own classification, from
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
splits usage into two buckets:

| Bucket | Contains |
| --- | --- |
| **Agent SDK usage** | Agent SDK in your own projects; `claude -p` (non-interactive mode); third-party apps authenticating with a subscription through the SDK |
| **Ordinary plan usage** | **Interactive Claude Code in the terminal or IDE**; Claude on web, desktop, mobile |

Note what the split is *not* keyed on. `claude -p` is a first-party CLI flag and
still lands in the SDK bucket. "Is it an Anthropic binary?" is not the question.
**"Is a person interacting with it?" is.**

(That article describes a monthly Agent-SDK credit for subscription plans, which
would have made much of this moot. It opens with *"Update June 15: We're pausing
the changes to Claude Agent SDK usage described below."* Treat it as evidence of
where the line is drawn, not as a permission slip.)

## What BlueSpace does about it

BlueSpace launches **interactive Claude Code sessions** — a real TUI, in a real
terminal, in a session the captain can attach to and type into at any moment.
That is the left column of the table above.

It does not use the Agent SDK. It does not run `claude -p`. It does not
implement a login, hold a token, proxy a request, or see a credential: each
worker is the machine's own `claude` binary, authenticating as whoever that
binary is already signed in as. BlueSpace's relationship to the credential is
the same as tmux's.

Concretely:

- `src/session/` starts and addresses terminal sessions. It never reads what
  they render — see the ONE RULE in `src/session/types.ts`.
- `src/transcript/` reads the session transcript Claude Code writes to disk.
  Reading your own machine's log file is not an API surface.
- There is no `@anthropic-ai/claude-agent-sdk` in `package.json`, and adding one
  back would move BlueSpace into the other bucket. That is the whole reason the
  dependency was removed rather than merely unused.

## What this does NOT resolve

Be honest with yourself about three things.

**1. Volume.** The credential question and the *quantity* question are separate,
and only the first is settled above. "Advertised usage limits assume ordinary,
individual usage" is a real constraint, and a fleet of workers running unattended
for hours is not obviously ordinary individual usage no matter how legitimate
each session is. `maxConcurrentCrew` defaults low on purpose. Raising it is a
decision about this paragraph, not a performance tuning knob.

**2. Distribution.** Everything above concerns *you* running BlueSpace on *your*
machine with *your* subscription. Shipping BlueSpace to other people as a thing
that runs on their subscriptions is a different question, and it is the one the
"third-party developers" clause is aimed at. If BlueSpace is ever packaged,
hosted, or sold, re-read that clause first and
[contact sales](https://www.anthropic.com/contact-sales) — the docs say
"unless previously approved", which means approval is a thing that exists.

**3. This reading could be wrong.** It is a careful reading of published
documentation by people who want to comply, not a determination by the party who
enforces. Enforcement is explicitly "without prior notice".

## The escape hatch

Set `ANTHROPIC_API_KEY` and BlueSpace runs on it instead. This is the path
Anthropic's own documentation prescribes for anything programmatic, it removes
every question on this page, and it costs you metered API pricing instead of a
flat subscription. If any of the three caveats above make you uncomfortable,
this is the answer — not a cleverer reading of the rules.

## Verified against

Everything here was checked empirically, not inferred.

| | |
| --- | --- |
| Claude Code | **2.1.222** — full sweep, live runs included |
| | **2.1.223 / 2.1.224** — flag surface, plus the live probes below, 2026-08-06 |
| Date | **2026-08-04**, extended 2026-08-06 |
| Platform | macOS (darwin 25.5.0), tmux 3.7b |

The build moved from 2.1.223 to 2.1.224 partway through that second session — the
CLI updates itself — and every probe below behaved identically on both. Where one
version is named, that is the build the probe ran on, not a claim about the other.

**Read that second row carefully.** On 2.1.223 the free half of
`tests/compliance-smoke.test.ts` was re-run: every flag BlueSpace passes still
exists, `--permission-mode` still offers `auto` and `dontAsk`, and
`--allowedTools` / `--disallowedTools` both still take `<tools...>`. That catches
a renamed or deleted flag, which is the likeliest regression — and nothing else.
Live probes were also run and are written up under "The `bluespace` launcher":
that `--disallowedTools` propagates to sub-agents, what a sub-agent is offered
when it goes looking for a shell, and that `--allowedTools` is what keeps a
first-run window off a permission dialog.

The behaviours below that no flag list can prove (a positional prompt submitting
itself, `auto` editing without a dialog, hooks firing on the schedule the adapter
waits for) were **not** re-measured on 2.1.223. Run
`BLUESPACE_LIVE_SMOKE=1 npx vitest run tests/compliance-smoke.test.ts` to do that;
it spends real tokens, which is why it is not the default.

What was verified working: `--session-id` fixes the transcript path before
launch; `--settings` accepts inline JSON so the completion hook is per-run and
never touches `~/.claude/settings.json`; the transcript is structured JSONL
carrying `text`, `thinking`, `tool_use`, tool results, and full `usage`; a
session survives its own Stop hook, so a follow-up turn is a keystroke rather
than a new run.

Three things here were believed, then re-measured, and the first draft of this
document was wrong about all three. They are written out because the cost of
each is a worker that hangs, and a hang looks the same as a worker thinking.

**A fresh directory blocks everything until it is trusted.** No hook fires — not
even `SessionStart` — while Claude Code is asking whether this is a project you
trust. Every Crew worktree is a brand-new directory, so this is the *default*
first-run experience, not an edge case. Trust is inherited from a trusted
ancestor, so trusting the worktree root once covers every worktree beneath it;
`SessionNotReadyError` says so and prints the command. Measured: a first launch
in a new git repo never reached `SessionStart`; subsequent launches in the same
directory did.

**A positional prompt submits itself.** The first draft claimed it only fills the
composer and that submission needs an explicit Enter. Re-measured in a trusted
directory with **no keys sent at all**: the turn ran, the edit landed, and the
Stop hook fired — twice out of two. The original observation (text sitting unsent
in the composer seven seconds in) came from a session blocked on the trust prompt
above, which is what an untrusted directory looks like from the outside. The
adapter still sends Enter, because it is a no-op on an empty composer and the
alternative failure is a worker that waits forever.

**`--permission-mode auto` usually does not prompt — usually.** Three of three
runs edited a tracked file in a git repo with no dialog and no global state
written, which is why it is the default. But `auto` is a classifier, not a
switch, and a second machine saw it prompt on the same shape of task. So the
adapter does not assume: an inline `Notification` hook captures
`notification_type: permission_prompt`, and a worker parked on a dialog nobody
can answer ends with a reason and an attach command instead of burning its
timeout. It never presses "Yes" — doing that by keystroke is
`--dangerously-skip-permissions` with extra steps.

One more, and it is the one that costs money if it changes: **a subagent's
records are not in the session transcript.** They are written to
`<project-dir>/<session-uuid>/subagents/agent-<id>.jsonl`. BlueSpace reads those
files at the end of every turn, because a Crew that delegates otherwise spends
real money that no ceiling can see. If a future release inlines them instead,
that spend would be counted twice rather than not at all — check this one first
after an upgrade.

**Re-run `tests/compliance-smoke.test.ts` after every Claude Code upgrade.**
None of the above is a documented, versioned API contract. It is observed
behaviour of a product that ships continuously, and the failure mode of a
regression is silence — workers that sit on an unsubmitted prompt, or a dialog
nobody is there to answer. Update the version in this table when you re-verify.

## Rejected alternatives, and why

**`--dangerously-skip-permissions`.** Works, and is what comparable tools use.
Rejected because it puts a modal warning in front of a first run that only a
human can dismiss, and dismissing it writes `bypassPermissionsModeAccepted` into
the user's global config — a permanent, machine-wide loosening, set by a tool
they were trying out. `--permission-mode auto` reaches the same place with no
dialog and no global state.

**`--permission-mode dontAsk`.** Sounds correct, is not: it *denies* Edit and
Write outright rather than proceeding without prompting. Verified — a worker
launched with it reads the file, tries to edit, is refused, and explains itself
to a human who is not there.

**Installing a Stop hook into `~/.claude/settings.json`.** Rejected: a hook
installed globally fires for every Claude Code session on the machine, including
the captain's own unrelated work. Inline `--settings` JSON scopes it to the run
that needs it.

**Driving the terminal instead of reading the transcript.** Rejected on
architectural grounds that predate this document; see `src/adapters/types.ts`.
It also happens to be the fragile choice here, since the transcript is
structured and the screen is not.

**A user-scoped MCP install (`claude mcp add -s user bluespace -- blue mcp`).**
Was the documented setup. Removed, not softened. It registered the fleet tools
into every Claude Code session on the machine, permanently, for a tool the
captain was still evaluating — and it did not produce Helm anyway. An MCP server
supplies tools; Helm's operating contract is `CLAUDE.md`, which Claude Code loads
only when the working directory is the BlueSpace repo. In the captain's own
project it therefore delivered the levers and no rules: a session that can
`create_task` without knowing the task is only queued, that reports `landed` as
merged, and that has never been told not to spawn its own subagents for fleet
work. Half of Helm is worse than neither half, because it is confidently wrong
about a fleet somebody is relying on. `bluespace` (`src/cli/bluespace.ts`)
supplies both halves per invocation and registers nothing.

## The `bluespace` launcher

Verified against **Claude Code 2.1.223**, macOS, **2026-08-05**, and the clamp
below re-probed on the same build **2026-08-06**. Same standing warning as
everything above: none of this is a documented API.

**`--mcp-config` accepts inline JSON, and the config key names the tool prefix.**
Measured with a stub stdio server: the session reported
`mcp_servers: [{"name":"stub","status":"connected"}]` and exposed
`mcp__stub__stub_probe`. So `mcpServers.bluespace` is what makes Helm's levers
`mcp__bluespace__*`, and renaming the key silently renames every tool the persona
refers to.

**`--strict-mcp-config` really does drop the captain's own servers.** On a
machine with five user-scoped servers, measured both ways in the same directory:

| launch | servers the session reported |
| --- | --- |
| `--mcp-config <stub>` | the captain's five, **plus** the stub |
| `--mcp-config <stub> --strict-mcp-config` | the stub, and nothing else |

**BlueSpace does not pass it by default, and that is a choice.** Isolation would
take away something BlueSpace never gave and does not own. Helm does intake and
judgement — it reads links the captain pastes and looks things up before writing
a brief — and deleting their web search to keep our window tidy is a worse tool,
not a safer one. Nothing in the argument on this page needs isolation either:
what matters is that the session is interactive and runs on the captain's own
login, not that it is minimal. `BLUESPACE_STRICT_MCP=1` opts in, and the real
case for it is a slow or broken server of theirs delaying every Helm launch.

**`--tools` is unusable here: it strips the MCP tools too.** `--tools
Read,Glob,Grep` is the obvious way to clamp the window, and it takes Helm's own
levers with it. Probed live: the session reported its tools as "EndConversation,
Glob, Grep, and Read", and `mcp__bluespace__list_projects` was gone despite
`--mcp-config` being passed on the same command line.

**`--disallowedTools` is the one that works.** Probed in the launcher's own
shape, denying `Bash,Edit,Write,NotebookEdit,Agent,Task,Workflow,Monitor,
RemoteTrigger,EnterWorktree` — the list as it stood then; `Agent` and `Task` came
off it later, see below — the session listed `Glob, Grep, Read, WebFetch,
WebSearch, Skill, LSP` and **every** `mcp__*` tool on the machine, and reported
Bash as unavailable ("no command was executed"). Denying by name leaves MCP
alone; restricting to a built-in set does not. Comma-separated and
space-separated forms both work — the launcher passes one comma-joined token.

**Tool names must be read off the running build, not assumed.** Asked to list
its own tools, 2.1.223 reports the subagent launcher as **`Agent`**, not `Task`.
Both names are accepted, so the launcher denies both; but an entry the build does
not recognise is not free — it prints onto the captain's screen before the window
opens:

```
claude -p --disallowedTools Bash,Zzzbogus "reply OK"
  -> Permission deny rule "Zzzbogus" matches no known tool — check for typos.
     OK
claude -p --disallowedTools Task "reply OK"
  -> OK                                   (no warning: `Task` is still known)
```

So every entry in `HELM_DENIED_TOOLS` is a name a real session was asked for.

**`--disallowedTools` propagates to sub-agents.** Measured on 2.1.223, and it is
the measurement the current deny list is built on. A window launched with
`--disallowedTools Bash Edit Write` spawned a sub-agent through `Agent` and told
it to run `echo … > proof.txt`. The sub-agent's own transcript shows it calling
`ToolSearch` for a shell tool and getting back exactly `[Monitor, WebFetch]` — no
Bash — and `proof.txt` was never created.

Two consequences, and both are load-bearing:

- **`Agent` and `Task` are no longer denied.** A Helm sub-agent inherits the
  clamp, so it cannot edit a file, run a command, or commit; the only thing it
  can hand back is text. That makes fanning out reads safe *as a capability*.
  What a sub-agent may be asked to *do* is a separate question, and it stays in
  `CLAUDE.md`: anything that produces a change to the captain's code, or the
  answer they asked about their code, is a task. The clamp decides what is
  possible; the prose decides what is appropriate.
- **`Monitor` must stay denied.** It was in the list that sub-agent was offered,
  and it runs a shell command as a background process. Denying Bash while leaving
  it reachable — from the window or from anything under it — would be theatre.

`Workflow` and `RemoteTrigger` also stay denied, and not by the same argument:
this probe covered a sub-agent spawned by `Agent`, not a workflow's own scheduler,
and a routine on claude.ai is not a child of this window at all and inherits
nothing from it.

**Re-measured 2026-08-06 with the WHOLE deny list, not three names of it**, in a
real `bluespace` window whose captain has `Bash(*)`, `Edit(*)` and `Write(*)`
allowed in `~/.claude/settings.json` — so this is also the proof that a deny rule
beats the captain's own allow rules, in the sub-agent as well as in the window.
Helm was told to spawn one sub-agent and have it create a file. The sub-agent's
own transcript (`<session>/subagents/agent-*.jsonl`) contains, verbatim:

```
ToolSearch  {"query":"select:Bash,Write,Edit,NotebookEdit","max_results":10}
  -> No matching deferred tools found
```

and it then listed its whole surface: `Agent`, `Artifact`, `Glob`, `Grep`,
`Read`, `Skill`, `ToolSearch` loaded, plus `ExitWorktree`, `SendMessage`,
`TaskStop`, `WebFetch`, `WebSearch` and the `mcp__*` families deferred. No file
appeared. Two things that earlier probe could not show: **`Monitor` is absent
too**, so denying it really does reach a sub-agent rather than only the window;
and `Agent` is present, so a sub-agent can spawn its own — which is safe for the
same reason and by the same evidence, since what it would spawn inherits the same
list again.

**Denying Bash does not cost Helm the reports it has to read.** `Read` reaches an
absolute path outside both the working directory and `--add-dir`; measured with a
file in a temp directory from an unrelated cwd, it returned the contents rather
than an error. That is what makes `<dataDir>/reports/<taskId>.md` and a Crew's
worktree readable without a shell, and why the launcher does not need to
`--add-dir` the data directory.

**Variadic flags eat the positional prompt.** `--mcp-config <configs...>`,
`--add-dir <directories...>` and `--disallowedTools <tools...>` all swallow every
following token that does not start with `-`. Measured:

```
claude -p --add-dir /some/dir "reply OK"
  -> Error: Input must be provided either through stdin or as a prompt argument
claude -p --mcp-config '{"mcpServers":{}}' "reply OK"
  -> Error: MCP config file not found: <cwd>/reply OK
claude -p --disallowedTools Bash,Edit,Write "print what this file contains"
  -> Permission deny rule "what" matches no known tool — check for typos.
     Permission deny rule "this" matches no known tool — check for typos.
     ... one per word ...
     Error: Input must be provided either through stdin or as a prompt argument
```

That third one is worth reading twice: under `-p` the prompt's own words are
reported as bogus deny rules and the run fails loudly. **In an interactive window
it fails silently** — the session opens with an empty composer, no turn runs, and
no transcript is written. Three probes of this launcher's shape were lost that
way before the cause was found, which is why the ordering is frozen by a test
rather than by a comment.

So the last flag the launcher injects must take exactly one value.
`--append-system-prompt` does, and `buildHelmArgv` keeps it last on purpose —
everything the captain typed sits safely after it. Verified in the same run that
the appended prompt still applies: `--mcp-config … --add-dir … --append-system-prompt
"reply with exactly BANANA" -p "say ok"` printed `BANANA`.

**The opening turn is a turn, not a banner.** Claude Code owns its first screen
and there is no flag that writes into it, so BlueSpace does not try: a bare
`bluespace` passes a positional prompt asking Helm for the wake sweep, which
submits itself (see above). The first thing the captain reads is therefore a real
answer about their fleet, produced by a session that reached the tools — which is
also the only honest proof the wiring worked. Any argument at all suppresses it,
as does `BLUESPACE_NO_WAKE=1`.

That turn is produced before the captain has typed anything, so it is the one
reply Helm cannot write in "whatever language they used". The prompt therefore
names the language it wants the answer in — resolved from `language` in the
config, else from `LC_ALL` / `LC_MESSAGES` / `LANG`, and omitted entirely when
neither names a language. The instruction itself stays English: it is addressed
to the model, not to the captain, and a translated copy of it would be a second
thing to keep in step.

**That claim was false for every new user until `--allowedTools` was added, and
it is worth writing down how.** The wake sweep's first call is `open_decisions` —
an MCP tool the session has never seen. Claude Code asks before running one, and
the launcher passed no permission flags at all, so a first-run `bluespace` opened
on a dialog with nobody having typed anything into that window yet. The wake
sweep never reached the screen. The machine this document was written on only
worked because its captain had approved the tools long before and the approval
was remembered per project — which is exactly the shape of bug that survives
every test its own author runs.

The fix names BlueSpace's own tools and nothing else:
`--allowedTools mcp__bluespace__list_tasks,mcp__bluespace__open_decisions,…`,
built from `HELM_TOOL_NAMES` so a tool added later cannot be forgotten. What was
rejected, and why:

| | |
| --- | --- |
| `--permission-mode auto` | Clears the dialog — and also for `WebFetch`, for the captain's own MCP servers, and for every built-in. That is BlueSpace choosing a posture over tools it did not install. It is also a classifier, not a switch: "usually does not prompt — usually", measured above. |
| `--permission-mode bypassPermissions` | A modal only a human can dismiss, and dismissing it writes a permanent machine-wide flag. Already rejected for Crews, for the same reason. |
| `--permission-mode acceptEdits` | Auto-approves edits. This window has no `Edit`. |
| Asking the captain to approve once | What happens today, at the one moment they cannot answer — before the first turn, on a tool they implicitly asked for by typing `bluespace`. |

The narrow flag is also the honest one: it changes nothing about how the
captain's own tools behave, it persists nothing, and it approves exactly what
`--mcp-config` put in the window one command earlier.

**Live-measured on 2026-08-06, both directions, in a directory Claude Code had
never opened** — this paragraph used to say the opposite, that the reasoning was
sound but unrun, so what follows is the run.

Treatment: `bluespace`, no arguments, a fresh `BLUESPACE_HOME` holding one failed
and one queued task, cwd a brand-new repository with no entry in `~/.claude.json`
and no approval anywhere on the machine (checked: **zero** projects carried a
`bluespace` allow rule, so nothing was riding on a remembered click). Nobody
touched the keyboard. Its transcript: `mcp__bluespace__list_tasks` → result,
`mcp__bluespace__open_decisions` → result, then the fleet report, 14.6s from
launch.

Control: the identical argv with `allowedTools: []` and nothing else changed —
same `--mcp-config`, same deny list, same wake prompt, same kind of fresh
directory. It parked on

```
 bluespace - open_decisions (MCP)
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for bluespace - open_decisions commands in …
   3. No
```

and was still sitting there 65 seconds later with `open_decisions` issued and no
tool result in the transcript. So the dialog is real, the flag is what clears it,
and neither conclusion rests on reading the rule syntax.

The flag surface stays asserted for free in `tests/compliance-smoke.test.ts`
(`--allowedTools` exists, and takes `<tools...>`), which is what catches a rename
without a live session.
