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
npm link          # optional: puts `blue` on your PATH
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
nobody to press Enter. Trust is inherited from a parent, so answer it once for the
directory worktrees are created under:

```bash
mkdir -p ~/.bluespace/worktrees && cd ~/.bluespace/worktrees && claude
# answer "Yes, I trust this folder", then /exit
```

Reading the Blackbox needs neither — `blue ps`, `blue log`, `blue inbox`, `blue config`
and `blue map` without `--orchestrate` all run on a machine with no `claude` and no tmux.
Only the commands that actually run agents (`blue mcp`, `blue map --orchestrate`) check
for the CLI, and they check before they accept any work.

## Quickstart

```bash
# 1. Tell BlueSpace where your code lives. It references repos in place and never moves them.
blue projects add ~/code/api --desc "payments API, Go, deploys from main"

# 2. Register BlueSpace with your own Claude Code, once. This is the front door.
claude mcp add -s user bluespace -- blue mcp

# 3. Open Claude Code anywhere and say what you want built.
claude
> the /refunds endpoint 500s on partial refunds, and while you're in there
  the retry logic has no tests

# Helm — the mcp__bluespace__* tools in that window — asks what it needs to,
# writes the briefs, and creates the tasks. The orchestrator dispatches them,
# in parallel where it can, for as long as that window is open.

# 4. Watch, from any other terminal.
blue ps                  # what the fleet is doing — and what to type to watch a worker
blue map                 # the Starmap dashboard in a browser

# 5. See what needs you.
blue inbox               # read the queue from anywhere; answer in the window from step 3
```

There is no `blue` prompt and no REPL. A bare `blue` prints the setup command and gets
out of the way; typing at Helm happens in a real Claude Code window, which is precisely
the point (`docs/compliance.md` again).

Each task lands as a branch in its own worktree under `~/.bluespace/worktrees/`.
Nothing is ever committed to your primary checkout; a Crew cannot even see it.

---

## What BlueSpace will not do

Stated plainly, because these are the claims people assume:

- **No Crew ever pushes.** Not to a remote, not on a landed task, not on any delivery
  mode. The brief forbids it explicitly.
- **No Crew opens a pull request, and nothing merges anything.** A project's `delivery`
  setting is metadata Helm reads when writing a brief. `pr` does not open one; there is
  no code anywhere in this repo that pushes, opens, or merges.
- **`landed` means verification is over, not that anything shipped.** It is a local
  branch sitting in a worktree. On a mission it means the Sentinel read the diff and
  passed it; a recon has no diff to grade, so it lands on its report with nothing
  checking it. Either way, taking delivery is your hands on your own repository.
- **Helm never writes your code, but nothing sandboxes it.** Helm is a persona in your
  own Claude Code window, holding whatever tools that window has. `CLAUDE.md` tells it
  to stay read-only over your projects and to route every change through a Crew — that
  is an instruction to a model, not a boundary the code enforces. The isolation that
  *is* enforced is the Crew's: its own worktree, on a throwaway branch, proven distinct
  from your checkout by four separate checks before it is handed over (`src/worktree/`).
- **Nothing reclaims a worktree on its own.** A finished task keeps its worktree,
  because the branch in it is the deliverable and deleting it would throw the work away
  at the moment it succeeded. Only cancelling a task removes one automatically. Nothing
  sweeps on a timer, at exit, or behind your back.

  What you can do is ask. `blue gc` reclaims the worktrees **whose work is already
  merged into the base branch** — and only those. A worktree with uncommitted changes,
  or with commits that are not in `main`, is kept and told to you with the reason,
  because at that point the directory is the only copy of something. So the pile
  shrinks when you merge, and not before: it is a sweep for merged work, not a
  clean-up-everything command, and on a fleet whose branches you have not merged it
  will correctly take nothing at all. It considers finished tasks' worktrees and any
  it finds with no task attached; a task still running is never a candidate, at any
  force level.

  Two things it does not promise. It asks git what is dirty, and git does not count
  files your `.gitignore` covers — a `.env` or a `dist/` a Crew wrote is not what keeps
  a merged worktree alive, and goes with it. And a loose directory under
  `~/.bluespace/worktrees/` that git cannot account for is reported, never removed,
  unless you force it.

  `blue gc --force` takes the ones it kept, after listing exactly what that costs and
  making you confirm it. Commits survive on their branch even then — it reaps a branch
  only once it has proved it merged — but uncommitted work does not. On a
  non-interactive stdin there is nobody to confirm, so it refuses and exits non-zero;
  `--yes` is the only way to force from a script, and it means what it says.

---

## Commands

```
blue mcp                      serve Helm's tools over stdio — your Claude Code window runs this
blue                          how to reach Helm; there is no prompt here

blue inbox                    read the decisions waiting on you  ← start here
      --list                  render only, do not prompt
blue ps                       what the fleet is doing, and how to watch a worker
blue log <taskId>             replay one task's events from the Blackbox
      -f, --follow            keep streaming new events
      --limit <n>             show only the last n events
blue map                      start the Starmap server and print its URL (default :7777)
      --port <n>              port to listen on
      --orchestrate           also run the dispatch loop
blue gc                       reclaim finished tasks' worktrees whose work is merged
      -n, --dry-run           report what it would reclaim, change nothing
      --force                 take unmerged and dirty ones too — lists them, then asks
      -y, --yes               skip that question (the only way to force non-interactively)
blue projects                 list registered projects
blue projects add <path>      register a repo
      --name X --desc Y --delivery pr|local   (delivery is metadata; default pr)
blue projects rm <id>         forget a project
blue config                   print the effective config and where it lives
blue config set <k> <v>       change one setting (validated)

  -h, --help                  usage
  -V, --version               version
      --no-color              never emit ANSI colour
```

Helm itself is not a `blue` subcommand. It is the `mcp__bluespace__*` tools inside your
own Claude Code window — see `CLAUDE.md` — and `blue mcp` is what that window launches.
Everything above is the fleet's instrument panel, not a way to talk to it.

The dispatch loop runs inside `blue mcp` for as long as your Claude Code window holds the
connection. If you want the fleet to keep moving with that window closed, `blue map
--orchestrate` turns the same crank.

**Answering a decision happens where the fleet is running, not in an arbitrary terminal.**
The answer has to be typed into the live session the Crew is parked in, and only the
process that dispatched it holds that handle — `blue mcp`, or `blue map --orchestrate`.
So the ordinary way to answer is to tell Helm, in the window from step 3. `blue inbox`
reads the queue from anywhere; if you try to answer from a terminal that is not running
the fleet, it says so and leaves the decision open rather than pretending.

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
| `maxBudgetUsdPerTask` | `5` | USD ceiling for one task, across its Crew *and* Sentinel runs. |
| `maxConcurrentCrew` | `4` | How many Crew may be in flight at once. |
| `maxRework` | `2` | How many times a failing verdict may send a task back before it escalates to you. |
| `dataDir` | `~/.bluespace` | Derived from `BLUESPACE_HOME`. Read-only; not settable. |

The budget ceiling is enforced by the orchestrator, which prices the token counts in each
worker's transcript (`src/pricing/`) and kills the task when the total crosses the line.
That is a ceiling with up to one turn of overshoot, not a hard stop mid-request: the
harness's own `--max-budget-usd` only works in the non-interactive mode BlueSpace does
not use.

`maxConcurrentCrew` is not a performance knob. "Advertised usage limits assume ordinary,
individual usage" is a real constraint and raising this is a decision about it; the
default is low on purpose. See `docs/compliance.md`.

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
     │ types into their own interactive Claude Code window
     ▼
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
                    what it did and what it cost is read back from the
                    session transcript on disk, never from the screen:
                    src/session/ ─► src/transcript/ ─► src/pricing/
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
budgets, cost ceilings and teardown are exactly the behaviours that must stay correct
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
burning money and opens a decision for the Captain. That escalation path is the honest
answer to "what happens when the agent can't do it" — which is a question most of these
systems decline to answer.

### 3. Nothing reads the screen

A terminal is a picture of a conversation, not the conversation. `src/session/` may
start a session, address it, and type into it; it may **not** read what it renders.
Every semantic signal comes from a structured source instead: the JSONL transcript
Claude Code writes to disk (`src/transcript/`), and marker files written by per-run
hooks that travel in inline `--settings` JSON and never touch `~/.claude/settings.json`.

Cost works the same way. The transcript carries token counts and a model string and
nothing else, so `src/pricing/` converts them with a table of published rates — one that
is dated in the source, prices unknown models at the most expensive known family rather
than at zero, and drains a delegating worker's subagent files so a Crew cannot spend
money the ceiling cannot see.

---

## Layout

```
src/types/        domain + event schemas — the frozen contracts everything codes against
src/blackbox/     the append-only SQLite log, and every projection over it
src/adapters/     the harness boundary: AdapterEvent / Session / SpawnRequest, and the
                  Claude Code CLI adapter that stitches session + transcript + pricing
src/session/      start a terminal session, address it, type into it. Never reads it.
src/transcript/   the event stream, recovered from the JSONL the CLI writes to disk
src/pricing/      token counts -> USD, so the budget ceiling means something
src/mcp/          the stdio MCP server `blue mcp` runs — BlueSpace's front door
src/worktree/     git worktree lifecycle, plus the `blue gc` sweep that reclaims the
                  merged ones. Nothing else in the system shells out to git.
src/orchestrator/ the engine room: dispatch, ordering, retry, budget, teardown + state machine
src/agents/       Helm's nine tools, the Crew brief builder, the Sentinel. Helm's own
                  persona is not here — it lives in CLAUDE.md and skills/bluespace/
src/config/       BlueConfig and the project registry
src/cli/          the `blue` command
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

`tests/compliance-smoke.test.ts` is the tripwire for everything on this page that is
observed rather than promised. Free and always on: every flag a worker is launched with
still exists, `auto` and `dontAsk` are both still offered, and no Agent SDK has come back
into `package.json`. Opt-in with `BLUESPACE_LIVE_SMOKE=1`, and it spends real tokens
driving a session end to end — the only half that can show those two modes still *mean*
what they mean, rather than merely still being listed. Re-run both after every Claude
Code upgrade, and update the version table in `docs/compliance.md`.

## License

MIT
