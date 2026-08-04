# BlueSpace

**A captain and an AI crew. One conversation in, a fleet of agents out.**

You talk to one agent. It talks to the fleet. Work gets split into tasks, each task
gets its own worker in its own disposable git worktree, an independent verifier checks
the result, and the only thing that reaches you is a decision that actually needs you.

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
| **Helm** | The one agent you talk to. | Intake and judgement: understands the request, routes it to a project, writes briefs, creates tasks. Never writes your code. |
| **Crew** | A worker. One per task. | Does the work, in a disposable git worktree of its own. Never sees another Crew. |
| **Sentinel** | An independent verifier. | Reads the brief and the diff, and nothing else. Returns a pass/fail verdict. |
| **Starmap** | The view. | A live dashboard of the fleet, projected from the Blackbox. |
| **Blackbox** | The log. | An append-only SQLite event log. Every state you can see is a fold over it. |

The split that matters: **Helm decides *what*. The orchestrator decides *when*.**
Helm never dispatches, retries, or tears anything down — it only creates tasks and
answers questions. Everything that has to be predictable under failure is code.

---

## Install

Requires **Node 20+** and **git**.

```bash
git clone <this repo> bluespace
cd bluespace
npm install
npm run build
npm link          # optional: puts `blue` on your PATH
```

## Authentication — use an API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # https://console.anthropic.com/settings/keys
```

BlueSpace is a third-party agent built on the Claude Agent SDK, and Anthropic's SDK
documentation is explicit about what those may authenticate with:

> Unless previously approved, Anthropic does not allow third party developers to offer
> claude.ai login or rate limits for their products, including agents built on the Claude
> Agent SDK. Use the API key authentication methods described in the Quickstart instead.

Left alone, the SDK resolves whatever credential it can find — and on a machine with
Claude Code installed that is usually a claude.ai subscription login. So BlueSpace
**refuses to start** rather than quietly using it. Nothing about running on a
subscription *fails*; it works fine right up until it becomes your problem, which is
exactly why the guard is a refusal and not a warning.

If you have read the above and want to make that call for your own account:

```bash
export BLUESPACE_INHERIT_AUTH=1
```

It is an environment variable rather than a config key on purpose. Config files get
committed, copied between machines, and inherited by teammates and by anyone who clones
a fork — a risk one person accepted for themselves should not travel to other people's
accounts inside a JSON file. BlueSpace prints a warning on every start while it is set.

Everything that only reads the Blackbox — `blue ps`, `blue log`, `blue inbox`,
`blue config`, and `blue map` without `--orchestrate` — needs no credentials at all.

## Quickstart

```bash
# 1. Tell BlueSpace where your code lives. It references repos in place and never moves them.
blue projects add ~/code/api --desc "payments API, Go, deploys from main"

# 2. Talk to Helm. This is the whole interface.
blue
› the /refunds endpoint 500s on partial refunds, and while you're in there
  the retry logic has no tests

# Helm asks what it needs to, writes the briefs, and creates the tasks.
# The orchestrator dispatches them — in parallel where it can.

# 3. Watch, from anywhere.
blue ps                  # what the fleet is doing right now
blue map                 # the Starmap dashboard in a browser

# 4. Answer only what needs you.
blue inbox
```

Each task lands as a branch in its own worktree under `~/.bluespace/worktrees/`.
Nothing is ever committed to your primary checkout; a Crew cannot even see it.

---

## Commands

```
blue                          talk to Helm (interactive session)

blue inbox                    answer the decisions waiting on you  ← start here
      --list                  render only, do not prompt
blue ps                       what the fleet is doing right now
blue log <taskId>             replay one task's events from the Blackbox
      -f, --follow            keep streaming new events
blue map                      start the Starmap server and print its URL
      --port <n>              port to listen on
      --orchestrate           also run the dispatch loop
blue projects                 list registered projects
blue projects add <path>      register a repo
      --name X --desc Y --delivery pr|local
blue projects rm <id>         forget a project
blue config                   print the effective config and where it lives
blue config set <k> <v>       change one setting (validated)

  -h, --help                  usage
  -V, --version               version
      --no-color              never emit ANSI colour
```

Inside a Helm session, `/ps`, `/inbox`, `/help` and `/exit` work without leaving it.

---

## Configuration

Lives in `~/.bluespace/config.json`. Change it with `blue config set <key> <value>`,
which validates before it writes. Set `BLUESPACE_HOME` to relocate the whole data
directory (config, Blackbox, worktrees) — useful for keeping work projects separate.

| Key | Default | Meaning |
| --- | --- | --- |
| `permissionMode` | `bypassPermissions` | Permission posture handed to every Crew. See below. |
| `model` | harness default | Model id for Crew and Sentinel runs. |
| `effort` | `high` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. |
| `maxBudgetUsdPerTask` | `5` | Hard USD ceiling for one task, across its Crew *and* Sentinel runs. The task is killed at the line. |
| `maxConcurrentCrew` | `4` | How many Crew may be in flight at once. |
| `maxRework` | `2` | How many times a failing verdict may send a task back before it escalates to you. |
| `dataDir` | `~/.bluespace` | Derived from `BLUESPACE_HOME`. Read-only; not settable from the file. |

### Permission modes

All five are accepted. Projects may override the global setting individually.

| Mode | Behaviour |
| --- | --- |
| **`bypassPermissions`** | **The default.** No prompts. The Crew acts freely inside its worktree. This is the point of the tool — a permission prompt with nobody sitting in front of it is just a hang, and the worktree is the safety boundary instead. |
| `default` | The harness's normal posture: prompts on the actions it considers sensitive. |
| `dontAsk` | Proceeds without prompting, but still refuses what policy forbids. |
| `plan` | The Crew plans and reports but does not modify anything. Useful for a dry run on an unfamiliar repo. |
| `async` | For unattended runs: a classifier decides in place of a human rather than blocking on one. |

`bypassPermissions` is the default *because of* the isolation model, not in spite of
it. A Crew works in a throwaway worktree on a throwaway branch; the worst case is a
branch you delete. If you would rather it not be, dial it back:

```bash
blue config set permissionMode plan
```

---

## Architecture

Everything is an append-only event in the Blackbox. Task state, cost, the decision
inbox, the Starmap — none of these are stored. They are all projections, folded from
the log on demand. Kill the process mid-flight and reopen it: the state is identical,
because the state was never in memory to begin with.

```
  Captain ──► Helm ──► creates tasks ──► ORCHESTRATOR (code)
                                            │
                            ┌───────────────┼───────────────┐
                            ▼               ▼               ▼
                          Crew            Crew            Crew        each in its own
                        worktree        worktree        worktree      git worktree
                            │               │               │
                            └──── diff ─────┴───────────────┘
                                    ▼
                                 Sentinel   (sees the brief + the diff.
                                    │        never the Crew's reasoning.)
                                    ▼
                            pass ──► ready ──► landed
                            fail ──► rework, or a decision for the Captain

  every arrow above is an event in the Blackbox; every view is a fold over it
```

Two decisions carry the whole design.

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
pass, because there is no conversation to be talked into. Its verdict is constrained
to a JSON schema (`VERDICT_SCHEMA`) at the tool-call layer, so a result is validated
structure rather than prose someone has to parse and hope about.

A failing verdict returns unmet requirements to the Crew as rework. After `maxRework`
attempts, the orchestrator stops burning money and opens a decision for the Captain.
That escalation path is the honest answer to "what happens when the agent can't do
it" — which is a question most of these systems decline to answer.

---

## Layout

```
src/types/        domain + event schemas — the frozen contracts everything codes against
src/blackbox/     the append-only SQLite log, and every projection over it
src/adapters/     the ONLY place a vendor SDK is imported; everything else is neutral
src/worktree/     git worktree lifecycle. Nothing else in the system shells out to git.
src/orchestrator/ the engine room: dispatch, ordering, retry, budget, teardown + state machine
src/agents/       Helm's prompt and tools, the Crew brief builder, the Sentinel
src/config/       BlueConfig and the project registry
src/cli/          the `blue` command
src/server/       the Starmap dashboard
```

## Development

```bash
npm run typecheck    # tsc over src and tests
npm test             # vitest
npm run build        # emit to dist/
```

TypeScript, ESM, NodeNext resolution — every relative import ends in `.js`. `strict`
and `noUncheckedIndexedAccess` are on.

## License

MIT
