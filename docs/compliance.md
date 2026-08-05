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
| Claude Code | **2.1.222** |
| Date | **2026-08-04** |
| Platform | macOS (darwin 25.5.0), tmux 3.7b |

What was verified working: `--session-id` fixes the transcript path before
launch; `--permission-mode auto` performs real file edits with **no confirmation
dialog and no persisted global state**; `--settings` accepts inline JSON so the
completion hook is per-run and never touches `~/.claude/settings.json`; a
positional prompt populates the composer without submitting, so submission is an
explicit keypress; the transcript is structured JSONL carrying `text`,
`thinking`, `tool_use`, tool results, and full `usage`.

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
