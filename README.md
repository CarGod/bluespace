# BlueSpace

**A captain and an AI crew. One conversation in, a fleet of agents out.**

You say what you want in your own Claude Code window. One agent — Helm — turns it into
tasks. Each task gets its own worker, in a git worktree of its own on a throwaway branch;
anything that changes code is graded by an independent verifier that sees only the brief
and the diff; and the only thing that reaches you is a decision that actually needs you.

Named for 蓝色空间号 — *Blue Space*, the ship in 三体 that carried human civilization
forward after the fleet it belonged to was gone. It survived because it was willing to
act on its own judgement, far from anyone who could approve it. That is the posture
this tool takes toward your work.

---

## The role model

Six words, and each one is a real boundary in the code.

| Role | What it is | What it may do |
| --- | --- | --- |
| **Captain** | You. The human. | Makes decisions. Nothing else. |
| **Helm** | The one agent you talk to, inside your own Claude Code window. | Intake and judgement: understands the request, routes it to a project, writes briefs, creates tasks. Never writes your code. |
| **Crew** | A worker. One per task. | Does the work, in a git worktree of its own on a throwaway branch. Never sees another Crew. |
| **Sentinel** | An independent verifier. | Reads the brief and the diff, and nothing else. Returns a pass/fail verdict. Runs on missions; a recon has no diff to grade. |
| **Starmap** | The view. | A live dashboard of the fleet, projected from the Blackbox. |
| **Blackbox** | The log. | An append-only SQLite event log. Every state you can see is a fold over it. |

The split that matters: **Helm decides *what*. The orchestrator decides *when*.**
Helm never dispatches, retries, or reorders anything — it creates tasks, answers
questions, and can stop a task the captain has given up on. Everything that has to be
predictable under failure is code.

---

## Requirements

| | Why |
| --- | --- |
| **Node 20+** | Runs BlueSpace itself. |
| **git** | Every Crew works in a `git worktree`. Nothing else in the system shells out to git. |
| **tmux** | A Crew *is* a terminal session. tmux is where those sessions live and how you attach to one. |
| **Claude Code**, installed and signed in | A Crew is your own `claude` binary. BlueSpace never holds a credential — see below. |

```bash
git clone <this repo> bluespace
cd bluespace
npm install
npm run build
npm link          # puts `bluespace` and `blue` on your PATH
```

## How BlueSpace runs Claude

**A Crew is a real, interactive Claude Code session** — a TUI, in a tmux window, on your
machine, launched from the `claude` binary you installed and signed into. You can attach
to any worker while it is running and type into it. `blue ps` prints the exact command.

That is an architectural boundary, not a configuration choice. Anthropic documents
subscription (OAuth) authentication as being for *ordinary use of Claude Code and other
native Anthropic applications*, and directs anything built on the Agent SDK to API keys
instead. BlueSpace therefore has **no Agent SDK dependency**, never runs `claude -p`, and
never implements a login, holds a token, or proxies a request: its relationship to your
credential is the same as tmux's.

**Read [`docs/compliance.md`](docs/compliance.md) before changing how workers are
launched.** It quotes the rules in full, says where the line falls, and is honest about
the three things this reasoning does *not* settle — volume, distribution, and the
possibility that the reading is wrong. It also documents the escape hatch: set
`ANTHROPIC_API_KEY` and every question on that page goes away, at metered API pricing.

Two practical notes:

```bash
export CLAUDE_CLI_PATH=/full/path/to/claude   # only if `claude` is off your PATH
```

Claude Code asks *"Is this a project you trust?"* the first time it opens a directory, and
no hook runs until it is answered — so a fresh worktree would sit there forever with
nobody to press Enter. **BlueSpace answers it for you**, per worktree, immediately before
each launch: one `hasTrustDialogAccepted: true` in your own `~/.claude.json`, for a
directory BlueSpace just created out of a repository you registered. It is the only thing
BlueSpace ever writes to your global Claude Code config, and it is skipped when the
directory is already trusted.

Answering it by hand for the parent directory does *not* work, and used to: up to Claude
Code 2.1.231 trust was inherited all the way up, and since 2.1.232 the walk stops at the
repository root — which a git worktree is. See `docs/compliance.md`.

Reading the Blackbox needs neither — `blue ps`, `blue log`, `blue inbox`, `blue config`
and `blue map` without `--orchestrate` all run on a machine with no `claude` and no tmux.
Only the commands that actually run agents (`blue mcp`, `blue map --orchestrate`) check
for the CLI, and they check before they accept any work.

## Quickstart

```bash
# 1. Tell BlueSpace where your code lives. It references repos in place and never moves them.
blue projects add ~/code/api --desc "payments API, Go, deploys from main"
blue projects add --scan ~/code    # …or register everything in there at once

# 2. Open a window that IS Helm. In any repo. Nothing to install, nothing registered.
bluespace
> the /refunds endpoint 500s on partial refunds, and while you're in there
  the retry logic has no tests

# Helm — the mcp__bluespace__* tools in that window — asks what it needs to,
# writes the briefs, and creates the tasks. The orchestrator dispatches them,
# in parallel where it can, for as long as that window is open.

# 3. Watch, from any other terminal.
blue ps                  # what the fleet is doing — and what to type to watch a worker
blue map                 # the Starmap dashboard in a browser

# 4. See what needs you.
blue inbox               # read the queue from anywhere; answer in the window from step 2
```

### `bluespace` vs `claude`

`bluespace` is a launcher, not a fork: it runs **your** `claude` with four things added
for that one invocation — the BlueSpace MCP server (`--mcp-config`, inline), Helm's
operating contract from `CLAUDE.md` (`--append-system-prompt`), a deny list that keeps
Helm on the dispatching side of the line (`--disallowedTools`), and those same MCP tools
marked approved so the first turn is a report rather than a permission dialog
(`--allowedTools`). Nothing is written to `~/.claude.json`, nothing is registered, and
deleting the binary removes every trace. Plain `claude` stays plain: no BlueSpace tools, no
BlueSpace rules, in any directory. Your own permission posture is untouched — the only
tools pre-approved are the ones that command just installed.

It passes your arguments straight through and returns the session's exit code, so
`bluespace --model opus`, `bluespace --continue`, and `bluespace "开始吧"` all work.

**A Helm window has no Bash, no Edit and no Write — and neither does anything it
spawns.** It has Read, Glob, Grep, the web tools, every MCP tool you or BlueSpace gave it,
and sub-agents — enough to read your repository, work out which project a request belongs
to, and write a brief a stranger could execute. It does not have the tools to do the work,
and that is the point rather than a limitation: the failure this prevents is Helm quietly
answering "check whether this bug is real and fix it" by grepping through your code itself.
That investigation looks like it worked. It has no worktree, no Sentinel, no token ceiling,
nothing in `blue ps`, no record in the Blackbox, and it is gone when the window closes —
which is every property you opened a fleet to get. Prose in `CLAUDE.md` could not stop it,
because reading a repository with `grep` really is read-only.
`BLUESPACE_UNCLAMPED=1` hands the tools back if you want them.

**Sub-agents are allowed, and the deny list is why.** Measured on 2.1.223,
`--disallowedTools` propagates: a sub-agent of a Helm window has no shell and no editor
either, so the only thing it can hand back is text. That makes it safe for Helm to fan out
its *own* work — reading twenty repositories to fill in what each one is, comparing briefs,
summarising across tasks — in one turn instead of twenty. It does not make it a way to
answer questions about your code: that is still a recon task, with a worktree and a record,
and `CLAUDE.md` is what draws that line. The clamp decides what is possible; the contract
decides what is appropriate.

A bare `bluespace` opens on Helm's **wake sweep** — what needs you, what came back,
what is still running — instead of an empty prompt. BlueSpace cannot paint Claude Code's
welcome box, so it does not fake one; the greeting is a real turn from a session that has
actually reached the tools, which is also the only honest proof the wiring worked. Any
argument suppresses it, as does `BLUESPACE_NO_WAKE=1`.

Your own MCP servers still load in a Helm window. `BLUESPACE_STRICT_MCP=1` drops them and
leaves only BlueSpace's — measured both ways in `docs/compliance.md`; the default keeps
them because Helm reads links and looks things up, and a launcher should not delete tools
it did not give you.

**Already ran `claude mcp add -s user bluespace -- blue mcp`?** Undo it:

```bash
claude mcp remove -s user bluespace
```

That instruction is gone. It put the fleet tools in every Claude Code session on your
machine, forever — and it never produced Helm anyway, because the rules live in
`CLAUDE.md` and that file loads only when your working directory is the BlueSpace repo.
In your own project it gave you the levers and no contract: a model that can create
tasks without knowing they are only queued, or that `landed` is not merged. A bare `blue`
notices the leftover registration and reminds you.

There is no `blue` prompt and no REPL. A bare `blue` points you at `bluespace` and gets
out of the way; typing at Helm happens in a real Claude Code window, which is precisely
the point (`docs/compliance.md` again).

Each task lands as a branch in its own worktree under `~/.bluespace/worktrees/`.
Nothing is ever committed to your primary checkout; a Crew cannot even see it.

---

## What BlueSpace will not do

Stated plainly, because these are the claims people assume:

- **Nothing pushes. Ever.** Not a Crew, not Helm, not the orchestrator. There is no code
  anywhere in this repository that runs `git push` or talks to a remote.
- **Nothing opens a pull request, and nothing merges into your default branch.** `main`
  is reached only by a pull request you open yourself. BlueSpace will tell you when
  there is one worth opening and hand you the `gh pr create` command; running it is
  yours.
- **One merge exists, and only when you say so.** `blue land <taskId>` (and Helm's
  `land_task`, on your word) merges one *verified* task's branch into the project's
  integration branch, `blue/dev` — created off your default branch when the project is
  registered. It happens in a worktree BlueSpace cuts and deletes, so your own checkout
  is never touched and uncommitted work in it is never at risk. It refuses an unverified
  task, refuses a recon, and a conflict aborts and changes nothing. See
  [Delivery](#delivery).
- **`landed` means verification is over, not that anything shipped.** It is a local
  branch sitting in a worktree. On a mission it means the Sentinel read the diff and
  passed it; a recon has no diff to grade, so it lands on its report with nothing
  checking it. Merging it is a separate act, and yours to ask for.
- **Helm never writes your code, and no longer merely promises not to.** The `bluespace`
  launcher denies the window `Bash`, `Edit`, `Write` and `NotebookEdit` — and every
  sub-agent it spawns inherits that, measured — so the levers are absent rather than
  discouraged. `CLAUDE.md` still states the rule — a model surprised by a missing tool
  argues with you about it — but the rule is not what holds.

  Be clear about what that is and is not. It is a flag on your own `claude`, not a
  sandbox: it removes tools, and `BLUESPACE_UNCLAMPED=1` puts them back. What it cannot
  constrain is judgement — Helm can still read your repository, because routing a request
  and writing a brief require it, and no flag can tell reading-to-decide apart from
  reading-as-the-answer. That line is drawn in `CLAUDE.md`, and it is drawn there because
  it genuinely cannot be drawn anywhere else.

  The isolation that is *fully* enforced is the Crew's: its own worktree, on a throwaway
  branch, proven distinct from your checkout by four separate checks before it is handed
  over (`src/worktree/`).
- **Nothing reclaims a worktree on its own.** A finished task keeps its worktree,
  because the branch in it is the deliverable and deleting it would throw the work away
  at the moment it succeeded. Only cancelling a task removes one automatically. Nothing
  sweeps on a timer, at exit, or behind your back.

  What you can do is ask. `blue gc` reclaims the worktrees **whose work is already
  merged into the branch it went into** — `blue/dev` for a task you landed, your default
  branch for one you merged yourself, and nothing at all for one that landed nowhere.
  That last case is the point: the base is read from the task's own merge record in the
  Blackbox, so a worktree whose commits sit on no branch but its own is kept and told to
  you with the reason, because at that point the directory is the only copy of
  something. So the pile shrinks when you land, and not before. It considers finished
  tasks' worktrees and any it finds with no task attached; a task still running is never
  a candidate, at any force level.

  Two things it does not promise. It asks git what is dirty, and git does not count
  files your `.gitignore` covers — a `.env` or a `dist/` a Crew wrote is not what keeps
  a merged worktree alive, and goes with it. And a loose directory under
  `~/.bluespace/worktrees/` that git cannot account for is reported, never removed,
  unless you force it.

  `blue gc --force` takes the ones it kept, after listing exactly what that costs and
  making you confirm it, with two exceptions it will not take at any force level: a
  worktree it cannot speak for (another repository's, or a `blue/` one with a detached
  HEAD — the one place a Crew's commits can sit on no branch), and a checkout of an
  integration branch. That second one matters most in the window right after your pull
  request merges, when `blue/dev` is fully contained in your default branch and so looks
  maximally reclaimable — reaping it then would delete the branch every landed task went
  into. Commits survive on their branch even when you do force — it reaps a branch
  only once it has proved it merged — but uncommitted work does not. On a
  non-interactive stdin there is nobody to confirm, so it refuses and exits non-zero;
  `--yes` is the only way to force from a script, and it means what it says.

---

## Commands

```
bluespace [claude args…]      open a Claude Code window that IS Helm  ← the front door
blue                          how to reach Helm; there is no prompt here
blue mcp                      serve Helm's tools over stdio — `bluespace` starts this for you

blue inbox                    read the decisions waiting on you  ← start here
      --list                  render only, do not prompt
blue ps                       what is in flight, plus what finished in the last day
                              — and what Helm's own window spent, read from disk
      -a, --all               every task ever — the log keeps them all
blue log <taskId>             replay one task's events from the Blackbox
      -f, --follow            keep streaming new events
      --limit <n>             show only the last n events
blue map                      start the Starmap server and print its URL (default :7777)
      --port <n>              port to listen on
      --orchestrate           also run the dispatch loop
blue land <taskId>            merge a verified task into blue/dev — never into main
blue cancel <taskId>          end a task, stop its Crew, remove its worktree
      --force                 record it anyway when no Crew is held here — see below
blue gc                       reclaim finished tasks' worktrees whose work is merged
      -n, --dry-run           report what it would reclaim, change nothing
      --force                 take unmerged and dirty ones too — lists them, then asks
      -y, --yes               skip that question (the only way to force non-interactively)
blue projects                 list registered projects
blue projects add <path…>     register one repo, or several
      --scan <dir>            register every repo directly inside <dir> (one level)
      --name X --desc Y       one repo at a time; refused for a batch
      --delivery pr|local     (metadata; default pr)
blue projects rm <id>         forget a project
blue config                   print the effective config and where it lives
blue config set <k> <v>       change one setting (validated)

  -h, --help                  usage
  -V, --version               version
      --no-color              never emit ANSI colour

BLUESPACE_STRICT_MCP=1        (bluespace) load only BlueSpace's MCP server, drop your own
BLUESPACE_NO_WAKE=1           (bluespace) open silently instead of on a wake sweep
BLUESPACE_UNCLAMPED=1         (bluespace) give Helm back Bash/Edit/Write — it can then do
                              the work itself, with no worktree, no Sentinel, no token
                              ceiling, nothing in `blue ps` and no record in the Blackbox
                              (Helm has sub-agents either way; clamped, they inherit the
                              same denials and cannot write a file or run a command)
CLAUDE_CLI_PATH               point at a `claude` that is not on PATH
```

Helm itself is not a `blue` subcommand. It is the `mcp__bluespace__*` tools plus
`CLAUDE.md`, both injected into one Claude Code window by `bluespace` — tools without the
rules is not Helm, which is why there is a launcher instead of an install instruction.
Everything else above is the fleet's instrument panel, not a way to talk to it.

The dispatch loop runs inside `blue mcp` for as long as that window holds the connection.
If you want the fleet to keep moving with the window closed, `blue map --orchestrate`
turns the same crank. Two Helm windows open at once means two loops over one queue; open
the second one when you need a second conversation, not as a habit.

**Answering a decision happens where the fleet is running, not in an arbitrary terminal.**
The answer has to be typed into the live session the Crew is parked in, and only the
process that dispatched it holds that handle — `blue mcp`, or `blue map --orchestrate`.
So the ordinary way to answer is to tell Helm, in the window from step 2. `blue inbox`
reads the queue from anywhere; if you try to answer from a terminal that is not running
the fleet, it says so and leaves the decision open rather than pretending.

**Cancelling has the same shape, for the same reason.** `blue cancel <taskId>` ends a task,
stops its Crew and removes its worktree — when this process is the one holding that Crew.
When it is not, it refuses and tells you where to cancel instead, because the alternative
is writing `cancelled` into the log while the Crew keeps running: a task that looks over,
is not, and is still spending your quota. A task that never dispatched has no Crew to
stop, so cancelling it works from anywhere. `blue cancel <taskId> --force` is for the case
the refusal cannot help with — the fleet process died holding the handle — and it does
exactly one thing: records the cancellation. It stops nothing and deletes nothing, and it
says so.

---

## Delivery

The shape is one sentence: **development merges onto `blue/dev`; `main` is reached only
by a pull request you open.** Nothing here merges into your default branch, at any point,
for any reason.

```bash
blue projects add ~/code/api      # creates blue/dev off main, if it isn't there already
# … Helm writes briefs, Crews work, the Sentinel verifies …
blue land 8673ef2e                # merges blue/8673ef2e… into blue/dev
blue ps                           # tells you blue/dev is N landed tasks ahead of main
blue gc                           # the landed worktree is now reclaimable
```

Or say it to Helm — "合并吧" — and `land_task` does the same thing through the same code.

**The integration branch is `blue/dev`, fixed.** It is namespaced with the task branches
(`blue/<taskId>`) so it groups with them in `git branch` and essentially cannot collide
with a branch you already have — which is what lets BlueSpace create it without asking. If
it exists, BlueSpace made it; if it does not, BlueSpace makes it, off your default branch,
at registration. The name is recorded on the project, so renaming the constant in a later
version cannot retarget a repository already using the old one.

The one repository this cannot work in is one with a branch named plain `blue`: git cannot
hold both `refs/heads/blue` and `refs/heads/blue/dev`, and every task branch is
`blue/<taskId>` anyway. That is detected when you register it, with the conflict named,
rather than surfacing inside a merge weeks later.

**What landing refuses**, changing nothing when it does:

- a task the Sentinel did not pass — anything not `ready` or `landed`;
- a recon: it produced a report, not a diff, and nothing verified it;
- a conflict. `git merge --abort`, the conflicting files reported, both branches exactly
  as they were. No `-X ours`, no rebase, no force, no auto-resolution;
- a merge target that is not in the `blue/` namespace, or that resolves to your default
  branch — asserted immediately before the merge, from the branch recorded on the
  project.

**Your checkout is never touched.** The merge happens in a linked worktree BlueSpace cuts
for it and removes afterwards, proven distinct from your checkout by the same four checks
every Crew worktree passes. Uncommitted work in your working copy is not at risk, and if
`blue/dev` happens to be checked out somewhere, landing refuses rather than merging through
a checkout it does not own.

**The pull request is yours.** When `blue/dev` is ahead, `blue ps` and `blue projects` say
so, and Helm mentions it once. `delivery_status` (or Helm, when you ask) hands you the
`gh pr create` command with a body built from the landed tasks' briefs and the Sentinel's
verdicts. BlueSpace does not run it. Once your PR merges, the count drops to zero on its
own — it is measured by asking git, not by remembering.

---

## Configuration

Lives in `~/.bluespace/config.json`. Change it with `blue config set <key> <value>`,
which validates before it writes. Set `BLUESPACE_HOME` to relocate the whole data
directory (config, Blackbox, worktrees) — useful for keeping work projects separate.

| Key | Default | Meaning |
| --- | --- | --- |
| `permissionMode` | `auto` | Permission posture handed to every Crew. See below. |
| `model` | harness default | Model id for Crew and Sentinel runs. |
| `effort` | `high` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. |
| `maxTokensPerTask` | `5000000` | **Token ceiling for one task**, across its Crew *and* Sentinel runs, counting input + output + cache-read + cache-creation tokens. `0` disables it. |
| `maxBudgetUsdPerTask` | `5` | USD ceiling for one task — **enforced only on a metered run** (`ANTHROPIC_API_KEY` set). See below. |
| `maxConcurrentCrew` | `4` | How many Crew may be in flight at once. |
| `maxRework` | `2` | How many times a failing verdict may send a task back before it escalates to you. |
| `language` | *(unset)* | The language Helm writes to you in. Unset means "work it out". See below. |
| `address` | *(unset)* | What Helm calls you. Unset derives it from `language` — 舰长 in Chinese, Captain otherwise. |
| `languageAsked` | *(unset)* | Whether the first-launch language question has been put. `false` puts it back. |
| `helmUltracode` | `true` | Open the `bluespace` window at **ultracode** — xhigh effort plus standing dynamic-workflow orchestration. See below. |
| `helmPermissionMode` | `auto` | Permission posture for the `bluespace` window. Not the same key as `permissionMode`, which is for Crews. |
| `dataDir` | `~/.bluespace` | Derived from `BLUESPACE_HOME`. Read-only; not settable. |

### How the `bluespace` window opens

```bash
blue config set helmUltracode false        # open at your normal effort instead
blue config set helmPermissionMode manual  # ask me before every tool
blue config set helmUltracode -            # back to the default
```

`bluespace` opens at **ultracode** in a posture that does not interrupt you. Both
are defaults, both are one command to change, and neither is written anywhere
outside the invocation.

`ultracode` is not an effort *level* — `--effort` only accepts `low` … `max`. It
is a per-session setting, passed as `--settings '{"ultracode":true}'`, which is
the same tier `/effort ultracode` writes from inside a window. It merges over
your own `~/.claude/settings.json` rather than replacing it, so your model, hooks
and permissions are untouched.

It can be defeated by your shell without saying so. If `CLAUDE_CODE_EFFORT_LEVEL`
or `CLAUDE_CODE_DISABLE_WORKFLOWS` is set, `bluespace` prints one line naming it
and pointing at `/effort ultracode`, then opens anyway. An organization effort
ceiling or a model that cannot do xhigh will also defeat it, and nothing outside
the window can see that — run `/effort` inside to see where it actually landed.

**A permissive posture is not a wider clamp.** The window still has no `Bash`,
`Edit`, `Write` or `NotebookEdit`, at any posture — a deny rule beats a
permission mode, and `HELM_DENIED_TOOLS` is untouched by this setting. It means
Helm is not stopped to ask about the tools it *does* have. `bypassPermissions` is
accepted here but argued against: it opens on a modal only you can dismiss, and
dismissing it writes a permanent machine-wide flag into your global Claude Code
config — for nothing, since there is no dangerous tool in this window to unlock.

### The language Helm talks to you in

**The first time you run `bluespace`, it asks — once.**

```
BlueSpace — one question, once.

Which language should Helm write to you in?

  1  en-AU    detected from LANG
  2  中文     zh-CN
  3  English  en

  Enter    skip — Helm follows whatever language you write to it in
  or type a language: ja, Español, 中文, Simplified Chinese, …
```

Answer it and it is saved; skip it and that is saved too. Either way you are never asked
again, and either way you can change your mind:

```bash
blue config set language zh-CN     # a tag, or a name: "中文", "Simplified Chinese"
blue config set language -         # unset it again
blue config set languageAsked false   # put the question back on the next launch
```

The menu is short on purpose: what this machine detected, 中文, English, and a line to type
anything else into. It is what we actually know rather than a list of eight plausible
languages nobody checked.

**Pressing Enter is always safe.** It means "follow whatever I write" — never "accept the
guess". That matters because the guess is wrong more often than it looks: the case this
question was added for was a captain who reads Chinese, on a machine whose macOS locale is
`en_US`, in a terminal whose profile pinned `LANG=en_AU.UTF-8`. Helm wrote English at them,
correctly, because that is the value it was handed.

Skip the question and the locale is dropped with it — you were shown `en-AU` by name and
said no, so BlueSpace does not go on to use it anyway.

Until you have been asked (a launch with no terminal to ask in — a pipe, a cron job — never
asks), `bluespace` still reads `LC_ALL`, then `LC_MESSAGES`, then `LANG`, and opens in
whatever they name. A locale that names no language (`C`, `POSIX`, or nothing at all)
resolves to **unknown, not to English**: Helm opens in English, then follows whatever
language you write to it in and stays there.

Whatever the language, **you are the captain and Helm addresses you as one** — 舰长 in
Chinese, Captain in English. That is where the immersion stops by design: the fleet's own
vocabulary for what is happening to your work, and no roleplay around it.

Helm never writes this setting for you — the first-run question does, and only with the
answer you gave it. If Helm worked out your language from something you typed, it may
mention the command once, in a clause; if you were asked and skipped, it will not mention it
at all. It has no tool that edits your config, and it will not ask you the same question
every morning.

### What a task costs, and which ceiling stops it

**A Crew is your own Claude Code session on your own login.** Its tokens come out of your
plan's quota. Nobody sends you an invoice for them, so BlueSpace does not pretend there is
one: the quantity it accumulates, ceilings, and reports is **tokens, broken down by model**
— which is exactly what a worker's transcript reports (`message.usage`, `message.model`)
and the only thing in it that is measured rather than modelled.

`src/pricing/` can still turn those counts into dollars, and that number is correct as an
answer to *"what would this work have cost on the API?"*. It is not spend, and BlueSpace
labels it as an equivalent everywhere it appears on a subscription run.

So there are two ceilings, and which one applies is not a preference:

| | Applies | Enforced when |
| --- | --- | --- |
| `maxTokensPerTask` | always | every run — tokens exist on every path |
| `maxBudgetUsdPerTask` | metered runs only | `ANTHROPIC_API_KEY` is set, so the tokens are actually billed |

**When both apply, whichever trips first stops the task**, and the failure names which one
fired. On a subscription, `maxBudgetUsdPerTask` is deliberately not enforced — killing a
task over an invoice nobody will ever send is a ceiling denominated in fiction. It is not
silently ignored either: `blue config` annotates it, `blue config set` says so, and a
config file that predates `maxTokensPerTask` gets a one-time explanation on load.

Either ceiling is a ceiling with up to one turn of overshoot, not a hard stop mid-request:
usage arrives when a message completes, and the harness's own `--max-budget-usd` only
works in the non-interactive mode BlueSpace does not use.

Set the one that matters to you:

```bash
blue config set maxTokensPerTask 2000000     # ~2M tokens per task
blue config set maxBudgetUsdPerTask 10       # only bites with an API key set
```

Cache reads dominate an agentic run — the whole conversation prefix is re-read every turn
— so a healthy task measures in millions of tokens. Set this ceiling from what `blue ps`
shows your real tasks using, not from intuition about how many words that is.

`maxConcurrentCrew` is not a performance knob. "Advertised usage limits assume ordinary,
individual usage" is a real constraint and raising this is a decision about it; the
default is low on purpose. See `docs/compliance.md`.

### Helm spends your quota too, and now you can see it

Every ceiling above bounds a **Crew**. Helm is not a Crew: it runs in your own terminal,
under no orchestrator, and it can fan out to sub-agents. So it was the one consumer of your
plan that nothing here measured. Observed, before this existed — you asked for a template
upgrade, Helm launched two sub-agents that spent 153.4k and 128.5k tokens in two minutes,
and `blue ps` showed nothing while the Starmap said *"Nothing needs you · 0 crew working"*.

`blue ps` and the Starmap now show that window: its own tokens, and one row per sub-agent
with **what Helm asked it to do**, because "Survey the template repos · 153.4k" is the line
that tells you it should have been a recon task.

```
Helm · your own window · read from its transcript, as of 01:11:18 — not live
  ~/aulp  329a83e3  282k tokens · 0.3k in the window itself
    ↳ Explore          Survey the template repos                153.4k
    ↳ Explore          Map the SDK surface                      128.5k
  2 sub-agents — Helm's own, not the fleet's: no worktree, no Sentinel, no ceiling, and nothing above.
```

**It is after the fact, and it says so.** Nothing watches that window — this is read from
the transcript Claude Code writes to disk, at the moment you ask. A sub-agent that started
a second ago has not written anything yet and will not be there. There is no ceiling on it
either: `maxTokensPerTask` stops a Crew, and Helm is not one. What this buys you is the
ability to *see* the bill, which is what you need to tell Helm to stop doing that.

It works because `blue mcp` — the server `bluespace` starts for that window — is handed the
window's session id by Claude Code, and records it. Nothing else is written, and closing the
window leaves nothing running.

### Permission modes

These are exactly the modes `claude --permission-mode` accepts — BlueSpace deliberately
does not invent its own vocabulary, because a mapping is a place for one mode to quietly
become another. Projects may override the global setting individually. The authority is
`PermissionMode` in `src/types/domain.ts`.

| Mode | Behaviour |
| --- | --- |
| **`auto`** | **The default.** Edits and commands proceed unattended: no dialog, and nothing written to your global config. The one posture that does real work with nobody watching. |
| `acceptEdits` | File edits auto-approved; other tools still prompt. Attended runs only. |
| `plan` | Plans and reports, changes nothing. Useful for a dry run on an unfamiliar repo. |
| `manual` | Prompts on anything sensitive. Only meaningful with a human attached. |
| `dontAsk` | **Reads like "proceed without prompting"; does the opposite.** It *denies* Edit and Write outright — a Crew launched with it reads the repo, tries the change, is refused, and explains itself to a human who is not there. Present because the harness has it. |
| `bypassPermissions` | Fully unrestricted. Costs a one-time modal only a human can dismiss, and dismissing it writes a permanent, machine-wide loosening into your global config. |

`auto` is the default *because of* the isolation model, not in spite of it: a Crew works
in a throwaway worktree on a throwaway branch, so the worst case is a branch you delete.
If you would rather it not act unattended at all:

```bash
blue config set permissionMode plan
```

A Crew that hits a permission dialog anyway does not sit on it. A `Notification` hook
reports the prompt, the run ends in seconds, and the error tells you which session to
attach to. BlueSpace will not answer the dialog for you — a machine pressing "1. Yes" is
`--dangerously-skip-permissions` by keystroke, which it rejected for milder reasons.

---

## Architecture

Everything is an append-only event in the Blackbox. Task state, cost, the decision
inbox, the Starmap — none of these are stored. They are all projections, folded from
the log on demand. Kill the process mid-flight and reopen it: the state is identical,
because the state was never in memory to begin with.

```
  Captain
     │ types `bluespace`, then talks — a real interactive Claude Code window
     ▼            src/cli/bluespace.ts: their own `claude`, + tools, + CLAUDE.md
  Claude Code ──► blue mcp ──► Helm ──► creates tasks ──► ORCHESTRATOR (code)
                  src/mcp/     src/agents/helm/          src/orchestrator/
                  stdio                                       │
                  JSON-RPC              ┌─────────────────────┼─────────────────────┐
                                        ▼                     ▼                     ▼
                                      Crew                  Crew                  Crew
                                  tmux session          tmux session          tmux session
                                  git worktree          git worktree          git worktree
                                        │                     │                     │
                                        │  a real TUI you can attach to and type into
                                        │
                    what it did and what it consumed (tokens, per model) is
                    read back from the session transcript on disk, never from
                    the screen: src/session/ ─► src/transcript/ ─► src/pricing/
                                        │
                                        └──── diff ────► Sentinel   (sees the brief + the
                                                             │       diff. never the Crew's
                                                             │       reasoning.)
                                                             ▼
                                        pass ──► ready ──► landed  (a local branch. that is all
                                                                    "landed" has ever meant.)
                                        fail ──► rework, or a decision for the Captain

  every arrow above is an event in the Blackbox; every view is a fold over it
```

Three decisions carry the whole design.

### 1. The orchestrator is code, not an agent

It would have been easy to make dispatch another agent — "here are the tasks, decide
what to run." That is the mistake. Concurrency limits, dependency gating, retry
budgets, consumption ceilings and teardown are exactly the behaviours that must stay correct
when everything else is going wrong, and a model is the wrong instrument for a job
whose requirement is *predictability under failure*. A model that is having a bad day
should not be able to spawn thirty crews, retry forever, or skip a teardown.

So `src/orchestrator/` is ordinary deterministic TypeScript, governed by an explicit
state machine that rejects illegal transitions rather than tolerating them. Every hop
is recorded. It is unit-testable, it is reasoned about the same way twice, and it is
the part of the system that does not surprise you.

Helm still does the genuinely judgement-shaped work — understanding a vague request,
deciding what splits into parallel tasks, writing a brief a stranger could execute.
That is where a model belongs. The line between them is the design.

### 2. Verification is done by an independent context

A Crew asked to check its own work grades its intentions. It knows what it *meant* to
do, and that knowledge is exactly the contamination that makes self-review worthless:
the reasoning that produced a mistake is the reasoning that will excuse it.

The Sentinel is a separate run with a separate context. It receives two things — the
original brief, and the git diff — and it never receives the Crew's transcript,
narration, or explanation of why something was skipped. It cannot be talked into a
pass, because there is no conversation to be talked into. Its verdict must match
`VERDICT_SCHEMA`: the Sentinel is handed the schema and a path outside the worktree,
writes its JSON there, and the file is validated on exit, with one bounded correction
typed into the live session if it is malformed. That is an application-layer check
rather than a protocol-level guarantee, and the Sentinel fails closed on a missing or
unreadable verdict — which is what makes the weakening survivable, not equivalent.

A failing verdict returns unmet requirements to the Crew as rework. Because the session
outlives the turn, rework is a follow-up message typed into the *same* worker rather
than a fresh run replaying context. After `maxRework` attempts, the orchestrator stops
burning tokens and opens a decision for the Captain. That escalation path is the honest
answer to "what happens when the agent can't do it" — which is a question most of these
systems decline to answer.

### 3. Nothing reads the screen

A terminal is a picture of a conversation, not the conversation. `src/session/` may
start a session, address it, and type into it; it may **not** read what it renders.
Every semantic signal comes from a structured source instead: the JSONL transcript
Claude Code writes to disk (`src/transcript/`), and marker files written by per-run
hooks that travel in inline `--settings` JSON and never touch `~/.claude/settings.json`.

Consumption works the same way, and it is the reason tokens are the unit. The transcript
carries token counts and a model string and nothing else — so that is what BlueSpace
accumulates, per task and per model, and what `maxTokensPerTask` bounds. It also drains a
delegating worker's subagent files, so a Crew cannot spend tokens the ceiling cannot see.

`src/pricing/` is still here and still correct: it converts those counts with a table of
published rates, dated in the source, pricing unknown models at the most expensive known
family rather than at zero. It is just no longer the primary axis. On a subscription its
output is what the same work *would* cost on the API — shown as an equivalent, never as
spend — and on an `ANTHROPIC_API_KEY` run it is the real number, which is why
`maxBudgetUsdPerTask` still bites there.

---

## Layout

```
src/types/        domain + event schemas — the frozen contracts everything codes against
src/blackbox/     the append-only SQLite log, and every projection over it
src/adapters/     the harness boundary: AdapterEvent / Session / SpawnRequest, and the
                  Claude Code CLI adapter that stitches session + transcript + pricing
src/session/      start a terminal session, address it, type into it. Never reads it.
src/transcript/   the event stream, recovered from the JSONL the CLI writes to disk
src/pricing/      token counts -> API list price, for the metered case and for comparison
                  (tokens, not dollars, are what BlueSpace accounts and ceilings in)
src/mcp/          the stdio MCP server `blue mcp` runs — BlueSpace's front door
src/worktree/     git worktree lifecycle, the `blue/dev` integration branch, and the
                  `blue gc` sweep that reclaims merged ones. Nothing else shells out to git.
src/land/         delivery: merging a verified task onto blue/dev, and what is waiting for
                  a pull request. The only code in BlueSpace that writes to your repos.
src/orchestrator/ the engine room: dispatch, ordering, retry, ceilings, teardown + state machine
src/agents/       Helm's tools, the Crew brief builder, the Sentinel. Helm's own
                  persona is not here — it lives in CLAUDE.md and skills/bluespace/
src/config/       BlueConfig and the project registry
src/cli/          the `blue` command, and `bluespace` — the launcher that opens a
                  Claude Code window with the fleet tools AND CLAUDE.md in it
src/server/       the Starmap dashboard
docs/compliance.md  why a worker is an interactive session and not an SDK call
```

## Development

```bash
npm run typecheck    # tsc over src and tests
npm test             # vitest
npm run build        # emit to dist/
```

TypeScript, ESM, NodeNext resolution — every relative import ends in `.js`. `strict`
and `noUncheckedIndexedAccess` are on. Two runtime dependencies — `better-sqlite3` and
`zod` — and the intent is to keep it that way.

`CLAUDE.md`, `skills/` and `docs/` are in `package.json`'s `files` because they are
**read at runtime**, not just documentation: `bluespace` loads `CLAUDE.md` from the
install root into `--append-system-prompt` and points Helm at the skill on disk. Removing
them from the package would ship a launcher that refuses to open (`MissingPersonaError`).
Helm's persona has exactly two copies — `CLAUDE.md` and `skills/bluespace/SKILL.md` — and
the launcher reads rather than embeds so that editing them is still enough to change Helm.

`tests/compliance-smoke.test.ts` is the tripwire for everything on this page that is
observed rather than promised. Free and always on: every flag a worker is launched with
still exists, `auto` and `dontAsk` are both still offered, and no Agent SDK has come back
into `package.json`. Opt-in with `BLUESPACE_LIVE_SMOKE=1`, and it spends real tokens
driving a session end to end — the only half that can show those two modes still *mean*
what they mean, rather than merely still being listed. Re-run both after every Claude
Code upgrade, and update the version table in `docs/compliance.md`.

## License

MIT
