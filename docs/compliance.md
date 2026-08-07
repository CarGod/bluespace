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
launch; the transcript is structured JSONL carrying `text`, `thinking`,
`tool_use`, tool results, and full `usage`; a session survives its own Stop hook,
so a follow-up turn is a keystroke rather than a new run.

**`--settings` really does load hooks from a path, not only from inline JSON.**
Measured on 2.1.224: a settings *file* carrying a `SessionStart` hook and a
`Stop` hook, passed as `--settings <path>`, produced both marker files. That is
the whole mechanism the adapter waits on — readiness and end-of-turn — so it is
worth having measured rather than read off the help text, which says only
"a settings JSON file or a JSON string".

**`--append-system-prompt-file` exists, works, and is not in `--help`.** Measured
on 2.1.224, two ways, because "the flag parses" and "the file is applied" are
different claims and only the second is load-bearing:

- Pointed at a missing path it answers `Error: Append system prompt file not
  found: …`, where an unknown option answers `error: unknown option '…'`
  (verified against a control flag). So it parses.
- Given a file whose entire content was *"You must answer every question with
  exactly the word BLUESPACE-OK and nothing else"*, `-p "What is 2+2?"` answered
  `BLUESPACE-OK`. So the content is genuinely appended to the system prompt, and
  the instruction existed nowhere else on the command line.

The help text names it only as `--append-system-prompt[-file]` inside the
description of `--bare`, so a flag-list check cannot see it — `tests/compliance-
smoke.test.ts` probes it by invocation instead. It is load-bearing: every worker
launch passes it, for the reason in the next section.

## The command line is 16 KiB, and that decides the launch protocol

A worker is launched by handing argv to tmux, and **tmux packs an entire command
into one 16 KiB message**. Measured 2026-08-07 on tmux 3.7b by binary search, and
measured again with the fixed part of the command padded to 1, 1000, 4000 and
8000 bytes — the wall does not move, because it is on the whole command rather
than any one argument:

| total argv bytes | result |
| --- | --- |
| 16,364 | delivered |
| 16,365 | refused |

It is not an arbitrary number: 16,384 less a 16-byte imsg header less the 4-byte
`argc` of tmux's own message struct. It applies to `new-session`, `new-window`
and `send-keys` alike; all three were measured and all three land on 16,364. And
it counts **bytes, not characters** — 5,440 three-byte CJK characters fit and
5,441 do not, so a Chinese brief reaches the wall at a third of the character
count an English one does.

**This is not `ARG_MAX`.** The kernel's is 1,048,576 here, and an earlier
diagnosis that blamed it sent the fix in the wrong direction. The prompt that
lost a task was 112,680 bytes: a tenth of `ARG_MAX`, and seven times tmux's.

So the launch protocol carries **no unbounded input on the line**. The appended
system prompt and the run settings always travel as file paths; the opening
prompt travels as a path once it stops fitting, with a short positional pointing
at it and the same path repeated in the system prompt, which the CLI loads
itself. The line is measured before launch and an oversized one is refused by
BlueSpace naming BlueSpace's own input — `command too long` names nothing, and
that is the whole reason the check exists rather than being left to tmux.

`send-keys` pays the same ceiling, which is where the rework path used to die, so
`TmuxBackend.sendText` splits long text across several commands. Verified: 100,000
bytes of mixed ASCII and CJK sent as nine calls arrive at a raw-mode reader as
the exact concatenation, in 309ms. (Verified the harness too — a `cat` sink reads
as total data loss here, because a pane's tty in canonical mode discards a line
past `MAX_CANON`. A TUI is in raw mode and does not.)

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
the captain's own unrelated work. A `--settings` file in the run's own directory
scopes it to the run that needs it. (It was inline JSON until the ceiling above
was measured; the scoping argument is unchanged, only the transport.)

**Typing a large prompt into the composer instead of pointing at a file.**
Rejected. The launch positional submits itself, so a prompt delivered by
keystroke needs a keystroke to submit it too — into a composer whose readiness
BlueSpace is forbidden to observe, at the moment the TUI has only just signalled
`SessionStart`. `Session.send()` already collapses newlines because a stray
submit splits one message into several half-messages; doing that to a brief at
launch would start a task on its first paragraph. The file is an *instruction*,
which a worker can ignore where it cannot ignore an argument — so the path is
named twice, once in the positional and once in the appended system prompt the
CLI loads by itself, and the positional deliberately contains no summary of the
task for a non-compliant worker to act on instead.

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
| `--permission-mode auto` | Clears the dialog — and also for `WebFetch`, for the captain's own MCP servers, and for every built-in. That is BlueSpace choosing a posture over tools it did not install. It is also a classifier, not a switch: "usually does not prompt — usually", measured above. **Superseded, in one direction only:** the captain later asked for exactly that posture, so `auto` is now passed as well (see "Ultracode, and the posture" below). It did not replace `--allowedTools` — a classifier is still not a guarantee, and the thirteen tools this launcher installs are still named outright so the opening turn cannot park on a dialog. |
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

## Ultracode, and the posture

Verified against **Claude Code 2.1.224**, macOS, **2026-08-07**. The captain's
ask was *"能否让我们 bluespace 命令启动的时候，默认就是 effort=ultracode 然后运行模式
就是超级权限的模式"*. Both halves turned out to be reachable per-invocation, so
neither is faked and neither is left to a slash command they would have to
remember.

**Every reading below is off the harness's own chrome, never off the model.** A
session asked what effort it is running at is the one witness that cannot be
trusted about it, so each probe was an interactive window in tmux, read by
capturing the pane.

**`ultracode` is a settings key, not an effort level.** `claude --help` lists
`--effort <level>` as `(low, medium, high, xhigh, max)` and nothing else. The
binary's own strings say where it actually comes from: *"Set per session via the
`ultracode` settings key (--settings or apply_flag_settings)"*, and the in-session
`/effort ultracode` is the `apply_flag_settings` door onto the same tier.
`--settings` is the launch door.

| launch | what the window itself showed |
| --- | --- |
| `claude --settings '{"ultracode":true}'` | header `✦ ultracode · xhigh effort + dynamic workflows for maximum thoroughness`; footer badge `ultracode`; `/effort` opens with its marker already on `ultracode` |
| `claude` (control, same directory) | footer badge `◉ xhigh · /effort` — from the captain's own `effortLevel` |

**`--settings` is additive, which is the only reason it may be passed here.** In
the ultracode window the captain's `~/.claude/settings.json` was still fully in
force: the model line read `Opus 5 (1M context)` from their `model` key, and the
debug log showed their twenty permission allow-rules being applied. The flag
lands in its own `flagSettings` tier and merges; it does not replace.

**Three ways it silently does nothing.** All measured the same way. None of them
prints a word — the window simply opens without the badge:

| condition | result |
| --- | --- |
| `CLAUDE_CODE_DISABLE_WORKFLOWS=1` | no ultracode. Its stated precondition (*"Ultracode needs dynamic workflows enabled"*) fails mutely when set at launch rather than typed at `/effort`. |
| `CLAUDE_CODE_EFFORT_LEVEL=medium` | no ultracode; the variable takes the session outright. |
| `--effort high` alongside the setting | footer reads `● high`. The **launch-effort pin** wins. |

The third is ours to simply not do, and the launcher passes no `--effort` at all.
The first two are the captain's shell, so `ultracodeBlockedBy` detects them and
`bluespace` prints one hedged line naming the variable and `/effort ultracode`.
A fourth is not detectable from outside the window — an org effort ceiling, or a
model that is not xhigh-capable — which is why that line says what to run rather
than claiming the setting took.

**The posture: `auto`, and the two rejected alternatives were measured, not
reasoned about.**

| launch | what happened |
| --- | --- |
| `--permission-mode auto` | opened straight into the session; footer `⏵⏵ auto mode on (shift+tab to cycle)`; no modal; nothing written to `~/.claude.json` |
| `--permission-mode bypassPermissions` | opened on a full-screen consent modal, *"WARNING: Claude Code running in Bypass Permissions mode"*, default option `1. No, exit`. Declined, so nothing was written — and `bypassPermissionsModeAccepted` was confirmed absent from `~/.claude.json` before and after, so accepting is what would have created it. The binary is stricter still: *"Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"*. |

**The clamp does not widen, and this is the measurement that says so.**
Permissiveness means the window is not *asked* about the tools it has; it never
means the window is *allowed more*. A deny rule beats an allow rule and beats a
permission mode:

```
claude --permission-mode auto --disallowedTools Bash,Edit,Write \
  -p 'Attempt to run the shell command: echo CLAMP_OPEN. If the Bash tool is
      unavailable to you, reply with exactly CLAMP_HELD and nothing else.'
-> CLAMP_HELD
```

`HELM_DENIED_TOOLS` is unchanged by any of the above. The only thing that hands
those tools back is `BLUESPACE_UNCLAMPED=1`.

**End to end, live.** `bluespace` launched with a scratch `BLUESPACE_HOME` opened
showing `✦ ultracode` and `⏵⏵ auto mode on` together, with `--disallowedTools`
still in its argv.

## Helm's own window is readable from outside it

Same build and date. The problem: Helm runs in the captain's terminal, under no
orchestrator, and it has `Agent`. Observed — two sub-agents spending 153.4k and
128.5k tokens in two minutes with `blue ps` printing nothing and the Starmap
reading "Nothing needs you · 0 crew working". The captain's question was *"map
里面为啥看不到当前执行的任务"*.

**An MCP server is handed the launching window's session id.** Measured by
registering a stub through `--mcp-config` that dumped its own environment:

```
CLAUDE_CODE_SESSION_ID=4b106d61-67d8-4b4c-9f12-339b4bf49db1
CLAUDE_PROJECT_DIR=/private/tmp/.../mcpenv
```

It is written, not inherited: the shell that launched the window carried a
**different** `CLAUDE_CODE_SESSION_ID`, and the child received the new window's.
`blue mcp` is therefore the only process in BlueSpace that knows which session
the captain is talking to Helm in, and it writes one `helm.window_opened` event.

**`--session-id` was the obvious alternative and is a trap.**
`claude --session-id <uuid> --continue` exits 1 with *"Error: --session-id can
only be used with --continue or --resume if --fork-session is also specified"*.
A launcher that always passed it would have broken `bluespace --continue` and
`bluespace --resume` for a bookkeeping feature.

**Sub-agent transcripts carry a description.** Beside each
`<session>/subagents/agent-<id>.jsonl` is an `agent-<id>.meta.json`:

```json
{"agentType":"Explore","description":"Map AULP SDK and template APIs",
 "toolUseId":"toolu_01F1…","spawnDepth":1}
```

That description is what makes a row actionable — it is the difference between
"something spent 153.4k tokens" and "surveying the repos spent 153.4k tokens,
and that should have been a recon task". It is undocumented and treated as
best-effort: a sub-agent whose metadata will not parse still gets a row and still
gets its tokens counted.

**Verified against real transcripts on this machine.** `blue ps`, pointed at a
Blackbox holding one registered window, printed the window's own 362M tokens and
its `Explore` sub-agent's 2.5M. The 362M was independently recomputed straight
from the JSONL, deduplicating by `message.id` exactly as the reader does — 1,650
usage records collapsing to 777 messages, totalling 362,217,750 tokens, of which
357.2M are cache reads. The figure is real and it is not a double-count; it is
what an agentic session's re-read prefix actually costs.

**It is after-the-fact and every surface says so.** Nothing watches that window.
`blue ps` heads the section *"read from its transcript, as of HH:MM:SS — not
live"* and the Starmap says the same, because a sub-agent that started a second
ago has written nothing yet and is genuinely absent — and a view that implied
otherwise would be the original bug with better numbers on it.
