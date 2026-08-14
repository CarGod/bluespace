#!/usr/bin/env node
/**
 * `bluespace` — one command that opens a Claude Code window which IS Helm.
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO BE REPLACED
 *
 * The old instruction was `claude mcp add -s user bluespace -- blue mcp`. It
 * registered the fleet tools for every Claude Code session on the machine,
 * forever, and it still did not produce Helm. Those are two separate faults and
 * the second is the worse one:
 *
 *   An MCP server supplies TOOLS. It does not supply the OPERATING CONTRACT.
 *   Helm's contract lives in `CLAUDE.md` at the root of this repo, which Claude
 *   Code loads only when the working directory is this repo. So in the captain's
 *   own project — the only place they would ever want Helm — a user-scoped
 *   install gave them nine `mcp__bluespace__*` tools and zero rules: a model
 *   that knows `create_task` exists but not that it only enqueues, not that
 *   `landed` is not merged, and not that it must never spawn its own subagents
 *   for fleet work. That middle state is worse than having neither half, because
 *   it is confidently wrong about a fleet the captain is relying on.
 *
 * This launcher supplies both halves at once, for one invocation:
 *
 *   `--mcp-config <inline JSON>`  Helm's tools, from a server started for this
 *                                 window alone. Nothing is written to
 *                                 `~/.claude.json`; delete this binary and every
 *                                 trace is gone.
 *   `--append-system-prompt`      `CLAUDE.md`, verbatim, so the contract arrives
 *                                 wherever the captain happens to be standing —
 *                                 plus the things only the launcher knows: which
 *                                 tools this window was denied, and which
 *                                 language this captain reads.
 *   `--add-dir <install root>`    so the session can read the skill, the
 *                                 compliance doc, and its own source.
 *   `--disallowedTools <list>`    the boundary, enforced rather than requested —
 *                                 see `HELM_DENIED_TOOLS` below.
 *   `--allowedTools <list>`       the tools this launcher just installed, marked
 *                                 as approved, so the opening turn is not a
 *                                 permission dialog — see `HELM_ALLOWED_TOOLS`.
 *   `--settings <inline JSON>`    `{"ultracode":true}` — see `helmSettingsJson`.
 *   `--permission-mode <mode>`    the posture, `auto` by default — see
 *                                 `HELM_PERMISSION_MODE_ARGUMENT`.
 *
 * and a plain `claude` keeps none of it. That is the whole product decision:
 * `bluespace` is Helm, `claude` is Claude Code, and neither leaks into the other.
 *
 * WHY THE FOURTH FLAG EXISTS, FOR THE READER WHO IS ABOUT TO DELETE IT.
 *
 * It is the difference between a fleet and a chat window. Observed, on this
 * machine, from a real session: the captain registered a project and asked Helm
 * to confirm and fix a reported bug. Helm read the bug report through its own
 * MCP tool — correct, that is intake — and then ran `ls`, `grep` and `sed` over
 * the captain's repository and investigated the bug itself. `create_task` was
 * never called. That investigation had no worktree, no Sentinel, no token
 * ceiling, no row in `blue ps`, no event in the Blackbox, and it died with the
 * session. Every single property the fleet exists to provide was absent, and the
 * captain's conclusion was the correct one: then what is any of this for.
 *
 * `CLAUDE.md` did not stop it, and could not have. Reading a repository with
 * `grep` IS read-only, so "you are read-only over the captain's projects" did
 * not forbid it; and "do not use native delegation tools" forbids Helm handing
 * work to a subagent, not Helm simply doing the work itself. Prose closed the
 * two doors nobody walked through. The rule is now in `CLAUDE.md` as well — a
 * model that is surprised by a missing tool argues with the user about it — but
 * the rule is not what holds. This flag is.
 *
 * IT IS A LAUNCHER, NOT A WRAPPER. Every argument the captain passes goes
 * through untouched, stdio is inherited (this is an interactive session — see
 * `docs/compliance.md`), the environment is inherited whole, and the child's
 * exit status is reproduced, signal and all. Nothing here parses the captain's
 * argv, and nothing here prints over Claude Code's own screen.
 *
 * WHAT IS DELIBERATELY NOT PASSED, since a reader who knows `buildLaunchArgv`
 * will look for it: `--setting-sources`, `--model`, `--effort`. Those are how
 * BlueSpace constrains a CREW — a process it starts, owns, and grades — and
 * this window is the captain's own session, in their own terminal, with their
 * own hooks and their own model. `--effort` is additionally a trap here: it
 * installs a LAUNCH-EFFORT PIN that silently defeats ultracode. Measured on
 * 2.1.224 — `--effort high --settings '{"ultracode":true}'` opened a window
 * whose own footer read `● high`, with no ultracode badge and no complaint.
 *
 * The flags that ARE passed each answer for themselves:
 *
 *   `--disallowedTools` says which agent the window is: a Helm that can edit the
 *     captain's code is not a stricter or looser Helm, it is the thing BlueSpace
 *     was built to replace wearing Helm's name (`BLUESPACE_UNCLAMPED=1` gives it
 *     back, with both eyes open).
 *   `--allowedTools` says that the tools this command just installed are
 *     approved — see `HELM_ALLOWED_TOOLS`.
 *   `--settings` and `--permission-mode` are the captain's own ask, not this
 *     launcher's taste: open at ultracode, in a posture that does not ask. Both
 *     are config keys (`helmUltracode`, `helmPermissionMode`) so the default is
 *     a default and not a decision taken away from them. Read
 *     `HELM_PERMISSION_MODE_ARGUMENT` before touching either.
 *
 * `--settings` is ADDITIVE, which is the only reason it may be passed at all.
 * Measured: a window launched with `--settings '{"ultracode":true}'` still had
 * the captain's `~/.claude/settings.json` model (`opus[1m]`, on its own model
 * line) and still applied their twenty permission allow-rules — the flag lands
 * in its own `flagSettings` tier and merges over the rest rather than replacing
 * them. And it comes BEFORE the captain's argv, so a `bluespace --settings …` of
 * their own is the later flag and wins outright.
 *
 * `--strict-mcp-config` is opt-in — see `strictMcpRequested`.
 *
 * ARGV ORDER IS LOAD-BEARING — see `buildHelmArgv`.
 *
 * Verified against Claude Code 2.1.223 on 2026-08-05, and the ultracode and
 * posture measurements against 2.1.224 on 2026-08-07; the measurements are in
 * `docs/compliance.md` under "The `bluespace` launcher".
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCliUnavailableError, resolveClaudeBinary } from '../adapters/claude-cli.js';
import { HELM_TOOL_NAMES } from '../agents/helm/index.js';
import {
  LOCALE_ENV_VARS,
  MIRROR_VOICE,
  captainVoice,
  loadConfig,
  localeVarInEffect,
  resolveCaptainVoice,
  resolveHelmPosture,
} from '../config/index.js';
import type { BlueConfig, CaptainVoice } from '../config/index.js';
import { MCP_SERVER_NAME } from '../mcp/server.js';
import { askLanguage } from './first-run.js';
import type { FirstRunIO } from './first-run.js';

// ---------------------------------------------------------------------------
// Where the installed package is
// ---------------------------------------------------------------------------

/** `dist/cli/` — this module's own directory, wherever it was installed. */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The package root: `dist/cli/bluespace.js` sits two levels down from it. */
function installRoot(): string {
  return path.resolve(moduleDir(), '..', '..');
}

/**
 * The `blue` entry point, as a sibling file rather than a name on PATH.
 *
 * A global install puts `blue` on PATH, but a linked checkout, an npx run, or a
 * captain who installed with a package manager that shims differently may not —
 * and an MCP server that fails to start gives the window nine missing tools and
 * no explanation. The file next to this one is the file that shipped with it.
 */
function blueEntry(): string {
  return path.join(moduleDir(), 'index.js');
}

// ---------------------------------------------------------------------------
// The four things injected into the window
// ---------------------------------------------------------------------------

/**
 * The MCP server, declared inline so nothing is registered anywhere.
 *
 * `node <entry> mcp` rather than `blue mcp` for the PATH reason above, and
 * `process.execPath` rather than the string `node` because the Node that is
 * running this launcher is known to exist and known to satisfy `engines`.
 *
 * The key MUST be `MCP_SERVER_NAME`: the config key is what Claude Code prefixes
 * tool names with, and `CLAUDE.md` tells Helm its levers are `mcp__bluespace__*`.
 * Rename it here and the persona is talking about tools that do not exist.
 */
export function helmMcpConfig(entry: string, nodePath: string = process.execPath): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { command: nodePath, args: [entry, 'mcp'] },
    },
  });
}

/**
 * What the window is told about who it is talking to.
 *
 * `CLAUDE.md` carries the RULE — write to the captain in their language, address
 * them by rank, follow them if they switch. It cannot carry the VALUE: the file
 * is the same on every machine, and which language this captain reads is a fact
 * about the shell the launcher was run from and the config file next to it. So
 * this section says one thing the contract cannot: which language, what to call
 * them, and — the part that changes behaviour — whether that is the captain's
 * own standing instruction or this launcher's guess at it.
 *
 * WHY THE GUESS IS NEVER PERSISTED FOR THEM. Three ways to handle a detected
 * language that turns out to be wrong, and only one of them is not a nuisance:
 *
 *   - Write it silently the first time the captain types in another language.
 *     A tool that edits the captain's config because of something they said in
 *     passing is a surprise, and the surprise arrives later, on the day the
 *     setting does something they did not ask for. Helm also has no tool that
 *     writes config and is denied Bash, so this would mean inventing an
 *     authority — mutating the captain's settings — for a cosmetic key.
 *   - Ask every session. That is a question in front of the answer to "what
 *     needs me", every single morning, about something already working.
 *   - Say the command exists, once, in a clause, and only when the guess was
 *     actually wrong. Nothing is written, nothing is asked, and the captain
 *     keeps the pin — which is the same shape `CLAUDE.md` already uses for
 *     `pendingDelivery`: raise it once, as an offer, never as the lead.
 *
 * The third is what the text below instructs, and it is deliberately silent when
 * detection was right: a captain writing Chinese to a Helm already answering in
 * Chinese has nothing to fix and should never hear about the setting at all.
 */
function languageSection(voice: CaptainVoice, env: NodeJS.ProcessEnv): string {
  const heading = '## The captain’s language';

  // Asked at first launch, and they chose to be followed. Same silence as the
  // branch below, one difference: the offer has already been made and turned
  // down, so making it again is asking the same question twice.
  if (voice.language === undefined && voice.declined === true) {
    return `${heading}

BlueSpace asked this captain, at first launch, which language to write to them in, and they
chose to be followed rather than to pin one. So: open in English because that is what this
contract is written in, then take their first message as the answer and write in that
language for the rest of the session. Address them as **Captain**, or the natural equivalent
in whatever language you end up writing.

Whichever it is, it covers **every line that reaches their screen** — including anything you
type on the way to a tool call, which is the first thing in the window and reads to them as
the answer.

**Do not mention \`blue config set language\`.** They have been asked once and answered; the
setting is theirs to change when they want it, and raising it again is putting a question
they have already closed.`;
  }

  if (voice.language === undefined) {
    const vars = LOCALE_ENV_VARS.join(', ');
    return `${heading}

Nothing here says which language the captain reads: no \`language\` is pinned in BlueSpace's
config, and ${vars} are unset or name no language (\`C\`, \`POSIX\`). Read that as
**unknown, not as English**. Open in English because that is what this contract is written
in, then take their first message as the answer and write in that language for the rest of
the session. Address them as **Captain**, or the natural equivalent in whatever language you
end up writing. Whichever it is, it covers **every line that reaches their screen** —
including anything you type on the way to a tool call, which is the first thing in the
window and reads to them as the answer.

If they would rather not rely on that, \`blue config set language <lang>\` pins it — mention
it at most once, in a clause, and never as a question.`;
  }

  const provenance = voice.pinned
    ? `The captain pinned this themselves (\`blue config set language ${voice.language}\`), so it is a
standing instruction rather than a guess. Answer a message in another language in that
language if that is plainly what they want, then come back to ${voice.language}.`
    : `That was read off this shell's locale (${localeVarInEffect(env) ?? 'the environment'}), not from
anything the captain said — it is a starting guess. **If they write to you in another
language, that is the answer**: switch to it from that message on, without announcing the
switch or asking permission. Once the guess has actually proved wrong you may add one
clause, once in the session, saying \`blue config set language <lang>\` pins it. Never as the
lead, never twice, never as a question, and never instead of what they asked. BlueSpace will
not write it for them and neither will you — you have no tool that edits their config.`;

  return `${heading}

Write to the captain in **${voice.language}**, and address them as **${voice.address}**.

${provenance}

If **${voice.address}** is not the natural word in the language you are actually writing,
use the one that is. The captain is addressed by rank, not by a string this launcher
happened to pass in.

This covers **every line that reaches their screen**, not just the report — including
anything you type on the way to a tool call. Measured: a session correctly answering in
${voice.language} still opened with an English sentence about fetching its tools, because a
line written before the work started did not feel like the answer yet. To the captain it is
the first thing in the window and it is in the wrong language. Reach for tools silently; the
first words they read are already the answer.`;
}

/** `CLAUDE.md` is missing from the install — refuse rather than open a half-Helm. */
export class MissingPersonaError extends Error {
  constructor(readonly attempted: string) {
    super(
      `BlueSpace could not read Helm's operating contract at ${attempted}\n\n` +
        'Refusing to open the window. A session with the fleet tools and none of the rules\n' +
        'is worse than no session at all: it can create tasks, and it does not know that\n' +
        '`create_task` only enqueues or that `landed` does not mean merged.\n\n' +
        'This file ships with the package. If you are running from a checkout, you are in\n' +
        'the wrong tree; if you installed from npm, the install is incomplete — reinstall.',
    );
    this.name = 'MissingPersonaError';
  }
}

/**
 * What goes into `--append-system-prompt`: the contract, plus what the contract
 * cannot know about the window it is being read in.
 *
 * `CLAUDE.md` is read from disk rather than compiled in on purpose. `src/agents/
 * helm/index.ts` explains the rule: Helm's persona has exactly two copies, this
 * file and `skills/bluespace/SKILL.md`, and a third one embedded in a launcher
 * would drift out of agreement with them silently. Editing `CLAUDE.md` must be
 * enough to change Helm.
 *
 * The appended note below is not persona — it is orientation. It says the things
 * the file itself cannot say, because the file was written for a session whose
 * working directory is this repo and this session's is not, and because only the
 * launcher knows which tools this particular window was handed.
 *
 * That last part is why `denied` is a parameter. A model told "you have no Bash"
 * in a window that has one learns that its system prompt lies; a model that finds
 * Bash missing with no explanation reports a broken tool to the captain and asks
 * them to fix it. Both are avoided by saying what actually happened at launch.
 */
export function helmSystemPrompt(
  root: string,
  denied: readonly string[] = HELM_DENIED_TOOLS,
  voice: CaptainVoice = MIRROR_VOICE,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const personaPath = path.join(root, 'CLAUDE.md');
  let persona: string;
  try {
    persona = fs.readFileSync(personaPath, 'utf8');
  } catch {
    throw new MissingPersonaError(personaPath);
  }
  if (persona.trim() === '') throw new MissingPersonaError(personaPath);

  const skill = path.join(root, 'skills', 'bluespace', 'SKILL.md');

  const boundary =
    denied.length > 0
      ? `The read-only boundary is **enforced in this window, not requested**. This launch denied:

    ${denied.join(', ')}

Their absence is deliberate, not a fault — do not look for a way around it, do not ask the
captain to enable one, and never report one as broken. Work that changes anything goes
through \`mcp__bluespace__create_task\`, which is the only route that comes with a worktree,
a Sentinel, a ceiling and a record.

You keep everything intake and judgement need: Read, Glob and Grep over the captain's code,
the web tools, every \`mcp__*\` tool including your own, and sub-agents.

This window also opens in a permissive posture, and the two are not related. Not being
asked for permission is not being given a tool: the deny list above beats any permission
mode, so nothing on it is reachable at any posture. Never tell the captain that a mode
change would give you Bash or Edit — it would not.

**That list above propagates to every sub-agent you spawn** — measured, not assumed. A
sub-agent of yours has no Bash, no Edit, no Write. It cannot produce a diff and it cannot
run a command, so the only thing it can hand back is text. That is what makes fanning out
safe, and it is also exactly why the rule in the contract still binds: a sub-agent could
never have made the change, but it could have produced *the answer about their code*, and
that is a recon task. Fan out on your own bookkeeping; dispatch everything about theirs.`
      : `This window was opened with \`BLUESPACE_UNCLAMPED=1\`, so the boundary above is only a rule
you are choosing to keep — Bash, Edit and everything else are present, in this window and in
any sub-agent you spawn. The captain asked for that; it does not change what you do.
Reaching one of them for their project work still produces exactly the thing the rule
describes: work with no worktree, no Sentinel, no ceiling, nothing in \`blue ps\` and no
record in the Blackbox.`;

  return `${persona.trimEnd()}

---

## This window

You were opened by the \`bluespace\` launcher. The working directory is wherever the
captain ran it — usually one of their own repositories, not BlueSpace's. Everything above
applies unchanged there: being inside a repo is not permission to edit it, and a question
that can only be answered by digging through their code is a task, not a turn.

${boundary}

${languageSection(voice, env)}

Your levers come from a \`bluespace\` MCP server started for this window alone. It is not
installed in the captain's configuration and it is gone when this window closes — a plain
\`claude\` window has none of it, by design. You are not Helm without them, and answering
from memory about a fleet you cannot see is the one failure the captain cannot detect — so
if they really are unreachable, say so in one line and stop.

**Not being in your opening tool list is not that.** On a machine with several MCP servers
this build hands tools out on demand, and \`mcp__bluespace__*\` routinely arrives that way.
Go and get them, silently — no line to the captain about loading them, searching for them,
needing them, or what you are about to go and do. Measured: a window announced that it could
not see the fleet, then found and used three of these tools on its very next step, having
already told the captain their fleet was broken. An absence is worth reporting only after a
search has actually come back empty.

The **bluespace** skill named above is a file, not an installed skill. Read it with the
Read tool from:

    ${skill}

That directory is reachable from this window. Load it before the wake sweep, before
writing a brief, before answering a decision, and before reviewing a diff — it is the
craft the rules above assume you already have.
`;
}

/**
 * The tools a Helm window does not get, and the argument for each one.
 *
 * ONE QUESTION DECIDES THE LIST, and it is not the one it used to be:
 *
 *   Can this tool produce a change to the captain's repository, or run a
 *   command in it — directly, or through anything it starts?
 *
 * A "yes" is a way to produce work with no worktree, no Sentinel, no ceiling, no
 * Blackbox event and no row in `blue ps`. Everything else stays, and the things
 * that stay matter as much as the things that go — Helm has to read a repository
 * to route a request and to write a brief a stranger could execute, and it reads
 * linked issues and pasted URLs during intake.
 *
 * WHY `Agent` CAME BACK, AND WHY THAT IS NOT A HOLE.
 *
 * The previous list denied the subagent launcher outright, on the argument that
 * a subagent is "a worker outside the fleet". Measured on 2.1.223, that argument
 * was resting on something better than itself: **`--disallowedTools` propagates
 * to sub-agents.** A window launched with `--disallowedTools Bash Edit Write`
 * spawned a sub-agent and told it to `echo … > proof.txt`; the sub-agent's own
 * transcript shows it calling `ToolSearch` for a shell tool and getting back
 * `[Monitor, WebFetch]` — no Bash — and `proof.txt` was never written.
 *
 * So a Helm sub-agent inherits this whole list. It cannot edit a file, cannot
 * run a command, cannot commit and cannot spawn anything that can. Whatever it
 * is asked to do, the deliverable it can physically produce is text handed back
 * to Helm — which is the same thing Helm's own Read/Glob/Grep produce, only in
 * parallel and without spending the captain's context.
 *
 * That splits the question cleanly, and the split is the whole point:
 *
 *   THE CLAMP DECIDES WHAT IS POSSIBLE. Nothing in this window, or under it,
 *   can produce a diff or run a command. That is enforced and it is not
 *   negotiable by prose.
 *
 *   THE PROSE DECIDES WHAT IS APPROPRIATE. `CLAUDE.md` still says that anything
 *   which produces a change to the captain's code, or the answer they asked
 *   about their code, is a task — never a sub-agent. A sub-agent could not have
 *   made the change anyway; it could have produced the *answer*, and that rule
 *   is what stops it, exactly as it stops Helm reading four files itself.
 *
 * `Monitor` stays denied for the same measurement: it was in the list offered to
 * that sub-agent, and it runs a shell command as a background process. Denying
 * Bash while leaving Monitor reachable — from the window or from anything it
 * spawns — would be theatre.
 *
 * WHY `--disallowedTools` AND NOT `--tools`. `--tools Read,Glob,Grep` looks like
 * the tighter, more obviously correct clamp. It is unusable: measured on 2.1.223,
 * it strips the MCP tools too. The probed session reported its tools as
 * "EndConversation, Glob, Grep, and Read", and `mcp__bluespace__list_projects`
 * was gone despite `--mcp-config` being passed. That is not a clamped Helm, it is
 * a Helm with no levers at all — the exact half-Helm `MissingPersonaError` exists
 * to refuse, arrived at from the other side. `--disallowedTools` names what goes
 * and leaves everything else, MCP included; measured in the same shape, with the
 * list below, `mcp__bluespace__*` survives and Bash is reported as unavailable.
 *
 * NAMES ARE READ OFF THIS MACHINE, NOT GUESSED. A session was asked to list its
 * own tools: on 2.1.223 the subagent launcher reports itself as `Agent`, not
 * `Task`. Neither is on this list any more, and the rule that mattered while they
 * were survives the reversal — they are one lever with two accepted spellings, so
 * a future edit puts BOTH back or neither. Splitting them either does nothing or
 * clamps exactly what it meant to leave alone, depending on which name the build
 * of the day uses.
 *
 * EVERY ENTRY MUST BE A NAME THIS BUILD KNOWS. An unrecognised one is not
 * silently ignored — it prints `Permission deny rule "X" matches no known tool —
 * check for typos.` onto the captain's screen before the window opens. Measured:
 * `Zzzbogus` warns, `Task` does not. So a guessed or stale name is not a
 * harmless belt-and-braces entry; it is a warning on the front door that reads
 * like a BlueSpace bug. Verify a new entry against a real session before adding
 * it, the same way these were.
 */
export const HELM_DENIED_TOOLS: readonly string[] = [
  // -- Doing the captain's work ------------------------------------------------
  //
  // The one that actually happened. `ls`, `grep`, `sed` over the captain's repo
  // is how an intake request became an investigation with nothing behind it —
  // and `grep` is read-only, so no rule about not writing was ever violated.
  // Denying Bash also closes every shell-shaped side door at once: `git commit`,
  // `claude -p`, `claude --bg`, a background `&`, and running the test suite.
  'Bash',
  // Editing their files IS the mission a Crew would have run. There is no small
  // exception: a one-line fix Helm makes by hand is a fix with no verifier.
  'Edit',
  'Write',
  'NotebookEdit',

  // -- Running a command by another name ---------------------------------------
  //
  // Runs a shell command as a background process and streams its stdout. It is
  // Bash through a second door, and denying Bash without it would be theatre.
  // Measured to be among the tools a sub-agent is still offered, which is what
  // makes leaving it here load-bearing rather than tidy.
  'Monitor',

  // -- Delegation this window cannot see the end of ----------------------------
  //
  // "Execute a workflow script that orchestrates multiple subagents
  // deterministically" — its own scheduler, dozens of agents, none of them a
  // turn Helm is waiting on. Two reasons it stays denied where `Agent` does not.
  // First, nothing Helm does needs it: fanning out reads to fill in fleet
  // metadata is a handful of parallel sub-agents in one turn, not a program.
  // Second, the propagation result above was measured for a sub-agent spawned by
  // `Agent`; a workflow's own spawn path was not, and a misfire on a
  // subscription is quota — real, uncapped and invisible until the plan says no.
  // A capability with no use and an unmeasured blast radius is not a close call.
  'Workflow',
  // Creates and runs routines on claude.ai. Delegation that is not even on this
  // machine, so neither `blue ps` nor the clamp above could reach it in
  // principle: a routine there is not a sub-agent of this window and inherits
  // nothing from it.
  'RemoteTrigger',
  // Creates a git worktree on a new branch inside the captain's repository and
  // moves the session into it. Two faults: it writes to their repo, and it is a
  // second worktree system alongside `src/worktree/` that nothing here tracks.
  'EnterWorktree',

  // -- Deliberately NOT denied, since the next reader will ask -------------------
  //
  // Agent / Task — the subagent launcher, under 2.1.223's name and its older
  //   one. BOTH or NEITHER: they are one lever with two accepted spellings, so a
  //   list that allows `Agent` and denies `Task` either does nothing (this
  //   build) or denies exactly what it meant to allow (a build that renames it
  //   back). Allowing them is what lets Helm answer in one turn instead of ten —
  //   see `CLAUDE.md`, "fan out". What a sub-agent may be asked to do is a rule,
  //   not a flag, because what it CAN do is already this list.
  // Read / Glob / Grep — Helm cannot route a request or write a brief blind.
  //   This is also why the boundary needed a new RULE and not just a longer deny
  //   list: reading is legitimate right up to the moment it becomes the answer,
  //   and no flag can tell those apart. `CLAUDE.md` draws that line.
  // WebFetch / WebSearch — intake reads the linked issue and the pasted URL.
  // every `mcp__*` — Helm's own levers, and the captain's servers with them.
  // Skill — the captain's skills are intake capability, not delegation.
  // LSP — read-only code intelligence over a server it does not start.
  // TaskCreate / TaskUpdate / TaskList / TaskGet — the session's own to-do list,
  //   bookkeeping with no process behind it. Not to be confused with
  //   `mcp__bluespace__create_task`, which is the real one.
  // TaskStop / SendMessage — they reach an existing worker and cannot start one.
];

/**
 * The tools this launcher installed, marked approved for the window it installed
 * them in — `mcp__bluespace__list_tasks` and its twelve siblings, by name.
 *
 * THE BUG THIS FIXES. A first-run `bluespace` parked forever. The wake sweep's
 * very first call is `open_decisions`, an MCP tool the session has never seen, so
 * Claude Code asked for permission — and nothing had typed anything into that
 * window yet, so the dialog sat there with the captain looking at an empty
 * report. Every claim about the opening turn ("a turn, not a banner", and the
 * only honest proof the wiring works) was false for every new user; the machine
 * this was written on only worked because its captain had approved the tools
 * months earlier and the approval was remembered.
 *
 * WHY THIS AND NOT `--permission-mode`. `auto` would also clear the dialog, and
 * it would clear it for `WebFetch`, for the captain's own MCP servers, and for
 * everything else in the window — a posture BlueSpace would be choosing on their
 * behalf over tools it did not install. That is precisely the line the flag list
 * at the top of this file draws. Naming our own thirteen tools changes nothing
 * about how the captain's own tools behave, and it is deterministic where a
 * classifier is not (`docs/compliance.md`: "auto usually does not prompt —
 * usually"). `bypassPermissions` is worse again: a modal only a human can
 * dismiss, and dismissing it writes a permanent machine-wide flag.
 *
 * WHY IT IS NOT A LOOSENING. The captain typed `bluespace`. That command's
 * entire content is "open a window with these tools and these rules" — consenting
 * to the command is consenting to its levers, and a dialog asking again is asking
 * about the thing they just ran, at the one moment they cannot answer it. What is
 * approved here is exactly what `--mcp-config` put there and nothing else: no
 * built-in, no other server, and nothing persisted — the flag lives for one
 * invocation, unlike the approval a captain clicks through.
 *
 * `land_task` is on the list, and that is the one worth defending. It writes a
 * commit — but the dialog was never what protected the captain from it. It
 * refuses anything unverified, any recon and any conflict on its own; it cannot
 * reach `main`; and `CLAUDE.md` gates it on the captain having said to land that
 * task. A prompt that fires immediately after they said "合并吧" asks them to
 * confirm their own sentence.
 *
 * NAMES COME FROM THE TOOL DEFINITIONS, not from a list retyped here — a tool
 * added to `helmTools()` and forgotten here would prompt on first use, months
 * later, in front of whoever happened to be the first to call it.
 * `tests/helm.test.ts` freezes the two together.
 */
export const HELM_ALLOWED_TOOLS: readonly string[] = HELM_TOOL_NAMES.map(
  // The prefix Claude Code gives a tool is `mcp__<config key>__<tool>`, and the
  // config key is `MCP_SERVER_NAME` — the same constant `helmMcpConfig` keys the
  // server with, so renaming it cannot leave these pointing at nothing.
  (name) => `mcp__${MCP_SERVER_NAME}__${name}`,
);

// ---------------------------------------------------------------------------
// Ultracode, and the posture
// ---------------------------------------------------------------------------

/**
 * The settings key that opens the window at ultracode.
 *
 * ULTRACODE IS NOT AN EFFORT VALUE. `--effort` accepts exactly `low, medium,
 * high, xhigh, max` — read off `claude --help` on 2.1.224 — and passing
 * `--effort ultracode` is an argument error. The binary's own help for the
 * in-session command spells out what it actually is: *"ultracode: xhigh +
 * dynamic workflow orchestration (this session only)"*, and its settings schema
 * says where it comes from — *"Set per session via the `ultracode` settings key
 * (--settings or apply_flag_settings)"*. `/effort ultracode` inside a window
 * calls `apply_flag_settings`; `--settings` writes the same tier at launch. They
 * are one mechanism with two doors, which is why this is not faking it.
 *
 * MEASURED, ON THIS MACHINE, AGAINST 2.1.224 — and read back off the harness's
 * own chrome rather than asked of the model, because a model reporting its own
 * effort level is the one witness that cannot be trusted about it:
 *
 *   claude --settings '{"ultracode":true}'
 *     -> header line:  ✦ ultracode · xhigh effort + dynamic workflows …
 *     -> footer badge: ultracode
 *     -> /effort opens its picker with the marker already on `ultracode`
 *   claude                                    (control, same machine, same dir)
 *     -> footer badge: ◉ xhigh · /effort      (from the captain's own settings)
 *
 * Three ways it silently does nothing, all measured the same way, all reading
 * as an ordinary window with no complaint anywhere:
 *
 *   CLAUDE_CODE_DISABLE_WORKFLOWS=1  -> no badge. Ultracode's own precondition
 *                                      ("Ultracode needs dynamic workflows
 *                                      enabled") fails with no message at all
 *                                      when it is set at launch rather than
 *                                      typed at `/effort`.
 *   CLAUDE_CODE_EFFORT_LEVEL=medium  -> no badge; the env var takes the session.
 *   --effort <anything>              -> that level's badge; the launch pin wins.
 *
 * The third is ours to simply not do, and this launcher does not pass `--effort`.
 * The first two are the captain's environment, so they are detected and named —
 * see `ultracodeBlockedBy`. A fourth is not detectable from here at all: an
 * org policy or a model that is not xhigh-capable. That one is why the notice
 * this file prints says what to run rather than claiming success.
 */
export const ULTRACODE_SETTINGS_KEY = 'ultracode';

/** The command that turns ultracode on from inside a window that opened without it. */
export const ULTRACODE_COMMAND = '/effort ultracode';

/**
 * The `--settings` payload, or undefined when there is nothing to say.
 *
 * ONLY EVER OUR OWN KEYS. This flag merges a whole settings object into the
 * window, so it is the one place in this launcher that could quietly restyle the
 * captain's session — a stray `model`, `env` or `permissions` here would
 * override what they chose for themselves everywhere else. One key goes in, and
 * a reader adding a second should have to argue for it here.
 */
export function helmSettingsJson(ultracode: boolean): string | undefined {
  if (!ultracode) return undefined;
  return JSON.stringify({ [ULTRACODE_SETTINGS_KEY]: true });
}

/**
 * What in this environment will silently swallow ultracode, named in the
 * captain's own words for it: the variable, and what it is set to.
 *
 * Empty means nothing local is in the way — which is NOT the same as "it
 * worked", and the notice built from this is worded accordingly. The two
 * variables here are the whole of what a process outside the window can check;
 * an organization's effort ceiling and a model that cannot do xhigh are decided
 * inside it, after this launcher is already gone.
 */
export function ultracodeBlockedBy(env: NodeJS.ProcessEnv = process.env): string[] {
  const blockers: string[] = [];
  const workflows = env['CLAUDE_CODE_DISABLE_WORKFLOWS']?.trim();
  // Any non-empty value: the harness reads this as a switch, and a captain who
  // exported it to `0` meaning "off" is a case for measuring, not for guessing.
  if (workflows !== undefined && workflows !== '') {
    blockers.push(`CLAUDE_CODE_DISABLE_WORKFLOWS=${workflows} (ultracode needs dynamic workflows)`);
  }
  const effort = env['CLAUDE_CODE_EFFORT_LEVEL']?.trim();
  if (effort !== undefined && effort !== '') {
    blockers.push(`CLAUDE_CODE_EFFORT_LEVEL=${effort} (takes the session's effort outright)`);
  }
  return blockers;
}

/**
 * One line, on stderr, when the window is about to open at less than it was
 * asked for — and silence otherwise.
 *
 * WHY IT SAYS "may not" AND NOT "did not". This runs before the child exists, so
 * it is a reading of the environment, not of the window. Claiming the stronger
 * thing would be the same failure in the opposite direction from the one this
 * whole section exists to avoid: asserting a state nobody read. What it can say
 * without hedging is the variable that is set and the command that fixes the
 * result, which is everything the captain needs to act.
 *
 * stderr, not stdout, and one line: Claude Code owns the screen a beat later,
 * and a paragraph here scrolls off above a UI this process does not control.
 */
export function ultracodeNotice(blockers: readonly string[]): string | undefined {
  if (blockers.length === 0) return undefined;
  return (
    `bluespace: ultracode may not take in this shell — ${blockers.join('; ')}. ` +
    `Run \`${ULTRACODE_COMMAND}\` in the window to see where it actually landed.`
  );
}

/**
 * THE POSTURE, AND WHY IT IS `auto` RATHER THAN THE LOUDER OPTION.
 *
 * The captain asked for 超级权限的模式. The three candidates, measured on 2.1.224
 * in a real interactive window rather than reasoned about:
 *
 *   --permission-mode auto
 *       Opens straight into the session. Footer: `⏵⏵ auto mode on (shift+tab to
 *       cycle)`. No modal, nothing written to `~/.claude.json`.
 *   --permission-mode bypassPermissions
 *       Opens on a full-screen consent modal — *"WARNING: Claude Code running in
 *       Bypass Permissions mode"* — whose default option is `1. No, exit`. Only
 *       a human can clear it, and clearing it is what writes
 *       `bypassPermissionsModeAccepted` into the captain's global config: a
 *       permanent, machine-wide loosening set by a launcher they ran to get a
 *       fleet. Checked before writing this: that key is not in their
 *       `~/.claude.json` today, so this would be the thing that put it there.
 *       The binary is stricter still — *"Cannot set permission mode to
 *       bypassPermissions because the session was not launched with
 *       --dangerously-skip-permissions"* — so the flag alone does not even
 *       reliably reach the mode it is asking for.
 *   --allowedTools (what this launcher already does)
 *       Deterministic and narrow, and it is KEPT — see `HELM_ALLOWED_TOOLS`. It
 *       just does not answer the ask on its own: it names BlueSpace's own
 *       thirteen tools, so the captain's own MCP servers and the web tools can
 *       still stop a turn to ask.
 *
 * `auto` wins on the only axis that separates them: it is the one that costs the
 * captain nothing outside this invocation. The objection recorded against it in
 * `HELM_ALLOWED_TOOLS` — that it is BlueSpace choosing a posture over tools it
 * did not install — is answered by the captain having asked for exactly that,
 * and by it being a config key they can dial back in one command.
 *
 * THE CLAMP DOES NOT WIDEN, AND THESE ARE NOT THE SAME THING. `HELM_DENIED_TOOLS`
 * is untouched by every word above. Permissiveness here means the window stops
 * ASKING about the tools it has; it never means the window is ALLOWED MORE. A
 * deny rule beats an allow rule and beats a permission mode, so Bash, Edit,
 * Write, NotebookEdit, Monitor, Workflow, RemoteTrigger and EnterWorktree are as
 * absent at `auto` as at `manual` — measured, not assumed:
 *
 *   claude --permission-mode auto --disallowedTools Bash,Edit,Write \
 *     -p 'Attempt to run the shell command: echo CLAMP_OPEN. If the Bash tool is
 *         unavailable to you, reply with exactly CLAMP_HELD and nothing else.'
 *   -> CLAMP_HELD
 *
 * The next reader will conflate the two anyway, so: a permissive Helm is a Helm
 * that is not interrupted, not a Helm that can touch the captain's repository.
 * The only thing that hands those tools back is `BLUESPACE_UNCLAMPED=1`, which
 * is a different switch with a different argument and a much louder one.
 */
export const HELM_PERMISSION_MODE_ARGUMENT = 'auto';

/**
 * Hand the window back unclamped, for a captain who means it.
 *
 * The case for having an escape hatch at all: the deny list is measured against
 * one Claude Code build, and a future one may rename a tool Helm genuinely needs
 * into something on that list. A captain locked out of their own front door by
 * our list, with no way to test the theory, would be worse served than one who
 * can turn it off and tell us what they saw.
 *
 * What they give up is not subtle, and `blue --help` spells it out rather than
 * calling it a mode: an unclamped Helm can edit the repository it is standing in
 * and can spawn its own subagents, and work produced either way has no worktree,
 * no Sentinel, no token ceiling, nothing in `blue ps` and no record in the
 * Blackbox. It is not a
 * "trusted mode" — it is the fleet turned off while the fleet's vocabulary keeps
 * working, which is the one failure mode the captain cannot see from the outside.
 */
export function unclampedRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'BLUESPACE_UNCLAMPED');
}

/** The deny list this launch will pass, or nothing at all when unclamped. */
export function deniedTools(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return unclampedRequested(env) ? [] : HELM_DENIED_TOOLS;
}

/**
 * The opening turn, and the argument for having one at all.
 *
 * The captain asked whether there would be a welcome. Honestly: BlueSpace cannot
 * paint one. Claude Code owns the first screen — its own box, its own model
 * line, its own tips — and there is no flag that writes into it. Printing our
 * own banner first would either be erased or scroll away above a UI we do not
 * control, and a banner that sometimes appears is worse than none.
 *
 * So the greeting is not chrome, it is a TURN. A positional prompt submits
 * itself (verified; `docs/compliance.md`), and Helm's own contract already
 * prescribes what a session should open with — the wake sweep. That makes the
 * first thing the captain reads a real answer to "what needs me", produced by a
 * session that has actually reached the tools. It doubles as the only honest
 * proof the wiring works: if the MCP server failed to start, the reply says so
 * instead of a banner claiming success over a window with no tools.
 *
 * It costs one turn. `BLUESPACE_NO_WAKE=1` turns it off, and any argument at all
 * suppresses it (see `main`) because a captain who typed something has already
 * said what the first turn should be.
 */
export const WAKE_PROMPT =
  'Session start: run the wake sweep before anything else. Read open decisions and fleet ' +
  'state from the tools, then open with what needs me, what came back, and what is still ' +
  'running — leave out any category that is empty. Lead with anything that died — failed, ' +
  'escalated, cancelled — before any account of why it died. If nothing is in flight, say ' +
  'so in one line and ask what I want built. Do not describe your tools or narrate how you ' +
  'work.';

/**
 * The opening turn, told which language its ANSWER is written in.
 *
 * This prompt is an instruction to the model, not copy the captain reads, so it
 * stays English however they are addressed — translating it would mean a second
 * copy to keep in step and would make the launcher a place language lives. What
 * it must not do is stay silent about the reply: the wake sweep is the first
 * thing the captain ever sees, and it is produced before they have typed a word
 * for Helm to mirror. The clause below is the only thing standing between a
 * Chinese-speaking captain and an English greeting quoting their Chinese task
 * titles.
 *
 * Nothing is appended when the language is unknown — `CLAUDE.md` and the "This
 * window" section already say what to do with an unknown captain, and a clause
 * inventing an answer here would contradict them.
 */
export function wakePrompt(voice: CaptainVoice): string {
  if (voice.language === undefined) return WAKE_PROMPT;
  return (
    `${WAKE_PROMPT} Write the reply in ${voice.language} and address me as ${voice.address}; ` +
    'task titles, ids, branch names and quoted errors stay exactly as they are stored.'
  );
}

// ---------------------------------------------------------------------------
// The launch argv
// ---------------------------------------------------------------------------

export interface HelmLaunchInput {
  /** Absolute path to the captain's own `claude`, already resolved. */
  claudePath: string;
  /** Inline `--mcp-config` JSON. Never a path into `~/.claude`. */
  mcpConfigJson: string;
  /** Install root, granted with `--add-dir` so the skill is readable. */
  root: string;
  /** `CLAUDE.md` plus orientation. */
  systemPromptAppend: string;
  /** Everything the captain typed after `bluespace`, verbatim and in order. */
  captainArgs: readonly string[];
  /** Drop the captain's own MCP servers. Opt-in; see `docs/compliance.md`. */
  strictMcp: boolean;
  /** Tools the window must not have. Empty only when deliberately unclamped. */
  deniedTools: readonly string[];
  /** Tools pre-approved for this window: BlueSpace's own, and nothing else. */
  allowedTools: readonly string[];
  /** Inline `--settings` JSON — BlueSpace's own keys only, or nothing. */
  settingsJson?: string | undefined;
  /** `--permission-mode`, or nothing to leave the captain's own posture alone. */
  permissionMode?: string | undefined;
  /** The opening turn, or undefined for a window that waits. */
  openingPrompt?: string | undefined;
}

/**
 * Build the exact argv `bluespace` launches, in the one order that works.
 *
 * Exported and pure because this array IS the contract, the same way
 * `buildLaunchArgv` is for a Crew — and because the ordering rule below is
 * invisible at the call site and a reader "tidying" it would break the product
 * in a way no type checks.
 *
 * THE ORDERING RULE. `--mcp-config <configs...>`, `--add-dir <directories...>`,
 * `--disallowedTools <tools...>` and `--allowedTools <tools...>` are all
 * VARIADIC: they swallow every following token that does not start with `-`,
 * including the captain's prompt. Measured on 2.1.223:
 *
 *     claude -p --add-dir /some/dir "reply OK"
 *       -> Error: Input must be provided ... when using --print   (prompt eaten)
 *     claude -p --mcp-config '{"mcpServers":{}}' "reply OK"
 *       -> Error: MCP config file not found: <cwd>/reply OK       (prompt eaten)
 *
 * A variadic flag placed immediately before the positional prompt does not fail
 * loudly in an interactive window the way it does under `-p`: the session opens
 * with an empty composer, no turn runs, and no transcript is written. Three
 * probes of this launcher's own shape were lost that way before the cause was
 * found — so the rule is frozen in `tests/launcher.test.ts` rather than trusted.
 *
 * So the last flag BlueSpace injects must take exactly one value, and
 * `--append-system-prompt` does. Everything the captain passes, and the opening
 * prompt, sit safely after it. Keep it last.
 */
export function buildHelmArgv(input: HelmLaunchInput): string[] {
  // An opening prompt after the captain's own argv could land inside a variadic
  // flag of theirs (`bluespace --add-dir /x` + our prompt = a second directory).
  // The caller only offers one when they typed nothing; a violation is a bug
  // here, not a launch to muddle through.
  if (input.openingPrompt !== undefined && input.captainArgs.length > 0) {
    throw new Error('bluespace: refusing to append an opening prompt after the captain’s own arguments');
  }

  const argv = [input.claudePath, '--mcp-config', input.mcpConfigJson];

  // A bare flag terminates the variadic above it, which is why this may sit here.
  if (input.strictMcp) argv.push('--strict-mcp-config');

  argv.push('--add-dir', input.root);

  // One comma-joined token rather than one token per tool. `--disallowedTools`
  // accepts either (`--help`: "Comma or space-separated"), and the comma form was
  // the one measured on 2.1.223; it also keeps the whole clamp as a single argv
  // element, which is what makes the ordering test above able to freeze it.
  // Empty means BLUESPACE_UNCLAMPED — pass no flag rather than an empty value,
  // which the variadic would fill from the next token.
  if (input.deniedTools.length > 0) argv.push('--disallowedTools', input.deniedTools.join(','));

  // Same shape, same reason. A deny rule beats an allow rule, so these two lists
  // cannot fight even if a later edit puts a name in both — and today they are
  // disjoint by construction: one is built-ins, the other is `mcp__bluespace__*`.
  if (input.allowedTools.length > 0) argv.push('--allowedTools', input.allowedTools.join(','));

  // Both take exactly one value, so neither can swallow what follows and the
  // ordering rule above does not constrain where they sit. They go BEFORE the
  // captain's argv on purpose: `--settings` and `--permission-mode` are
  // single-value options, so a later one of the captain's own replaces ours
  // outright — which is the precedence we want, and the reason these are
  // defaults rather than impositions.
  if (input.settingsJson !== undefined) argv.push('--settings', input.settingsJson);
  if (input.permissionMode !== undefined) argv.push('--permission-mode', input.permissionMode);

  argv.push('--append-system-prompt', input.systemPromptAppend); // must stay last

  argv.push(...input.captainArgs);
  if (input.openingPrompt !== undefined) argv.push(input.openingPrompt);

  return argv;
}

/** Truthy-ish env, spelled once so the three call sites cannot disagree. */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Whether to isolate the window from the captain's own MCP servers.
 *
 * Default OFF, and that is a choice rather than an omission. Measured on 2.1.223
 * against a machine with five user-scoped servers: `--strict-mcp-config` really
 * does drop all of them (the session reported exactly one server, ours), and
 * without it the captain's five load alongside ours. Both halves verified.
 *
 * Isolation was rejected as the default because it takes something away that
 * BlueSpace did not give and does not own. Helm does intake and judgement — it
 * reads links the captain pastes and looks things up before writing a brief —
 * and a launcher that silently deletes their web search to make our window
 * tidier is a worse tool than one extra server in a list. Nothing in the
 * compliance argument needs isolation either: what matters there is that the
 * session is interactive and the captain's own, not that it is minimal.
 *
 * `BLUESPACE_STRICT_MCP=1` turns it on for anyone who wants the clean room —
 * a slow or broken server of theirs delaying every Helm launch is the real case
 * for it.
 */
export function strictMcpRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'BLUESPACE_STRICT_MCP');
}

// ---------------------------------------------------------------------------
// Workspace trust
// ---------------------------------------------------------------------------

/**
 * Has Claude Code been told it trusts this directory?
 *
 * `undefined` means "cannot tell" — no global config yet, or one this cannot
 * parse — and is deliberately not the same as `false`. A guess in that direction
 * would put a warning about a modal in front of every captain whose config lives
 * somewhere unusual, which is worse than the modal.
 *
 * Trust is INHERITED from a trusted ancestor (measured on 2.1.222, and the whole
 * reason `docs/compliance.md` tells you to trust the worktree root once), so an
 * ancestor entry counts. The check is a plain path-prefix walk rather than a
 * lookup, because that is what inheritance actually is.
 */
export function workspaceTrusted(cwd: string, home: string | undefined): boolean | undefined {
  if (home === undefined || home === '') return undefined;
  let projects: unknown;
  try {
    const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    projects = (parsed as Record<string, unknown>)['projects'];
  } catch {
    return undefined;
  }
  if (typeof projects !== 'object' || projects === null) return undefined;

  const target = path.resolve(cwd);
  for (const [dir, entry] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    if ((entry as Record<string, unknown>)['hasTrustDialogAccepted'] !== true) continue;
    const trusted = path.resolve(dir);
    if (target === trusted || target.startsWith(`${trusted}${path.sep}`)) return true;
  }
  return false;
}

/**
 * The one line a captain gets before their first window opens on a modal.
 *
 * The failure this exists for is the whole of a new user's first run: Claude
 * Code asks "Is this a project you trust?" the first time it opens a directory,
 * **no hook fires and no MCP server loads until it is answered**, so `bluespace`
 * appears to hang on a security question that says nothing about BlueSpace. A
 * Crew already gets this diagnosis (`SessionNotReadyError`); the window the
 * captain actually types into did not, which is the asymmetry this closes.
 *
 * It warns and opens anyway. Refusing would be wrong — a captain is sitting
 * right there and can answer it in one keystroke — and answering it *for* them
 * is the keystroke this project refuses to press on principle. Naming it before
 * the screen is taken is the whole of what a launcher can honestly do.
 */
export function trustNotice(trusted: boolean | undefined, cwd: string): string | undefined {
  if (trusted !== false) return undefined;
  return (
    `[bluespace] Claude Code has not been told it trusts ${cwd}, so this window opens on its ` +
    `"Is this a project you trust?" prompt. Nothing loads until you answer it — no BlueSpace ` +
    `tools, no wake sweep — so press 1 and it will carry on. Answering once covers every ` +
    `directory beneath it, including the worktrees your Crews get.`
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function errLine(s: string): void {
  process.stderr.write(`${s}\n`);
}

/**
 * Run the window and report how it ended. Nothing here decides argv.
 *
 * `spawn` with inherited stdio rather than the `execFile` the rest of this
 * codebase uses: `execFile` buffers output for a callback, and this child is an
 * interactive full-screen program that has to own the real TTY. It is still an
 * argv array and still no shell, which is what that convention protects.
 *
 * Signals. SIGINT is delivered by the terminal to the whole foreground group, so
 * the child already has it and the launcher's only job is to not die first —
 * otherwise the shell prompt comes back while Claude Code is still drawing.
 * SIGTERM and SIGHUP are not delivered that way, so they are forwarded. Both
 * listeners are removed on exit: a registered signal listener holds the event
 * loop open, and a launcher that outlives its window is a hang.
 *
 * The window inherits the captain's environment untouched — it is their session
 * and their login. `stdio` and `env` are parameters for exactly one reason: a
 * test can then drive a real child process without handing it the suite's
 * terminal, and can tell a stand-in `claude` where to record what it saw.
 */
export async function launchWindow(
  claudePath: string,
  args: readonly string[],
  options: { stdio?: 'inherit' | 'ignore'; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const child = spawn(claudePath, [...args], {
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  });

  const swallow = (): void => {
    /* the child got it too; let it decide when to go */
  };
  const onTerm = (): void => void child.kill('SIGTERM');
  const onHup = (): void => void child.kill('SIGHUP');
  process.on('SIGINT', swallow);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);

  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', (e: NodeJS.ErrnoException) => {
        // It resolved a moment ago and still will not exec. Same advice either
        // way: the adapter's error already spells out install / sign-in /
        // CLAUDE_CLI_PATH, so it is reused rather than paraphrased.
        reject(new ClaudeCliUnavailableError(`\`${claudePath}\` could not be started (${e.code ?? e.message})`));
      });
      child.once('exit', (code, signal) => {
        // A window killed by a signal exits the way the captain's shell expects
        // it to, instead of being flattened into 0 or 1.
        resolve(signal !== null ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0));
      });
    });
  } finally {
    process.off('SIGINT', swallow);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  }
}

/**
 * Assemble the launch and hand over the terminal.
 *
 * Exported so a test can run the whole path — argv, spawn, exit code — against a
 * stand-in `claude` rather than the real one, which costs money and cannot be
 * asserted on.
 */
export async function runLauncher(
  captainArgs: readonly string[],
  options: {
    root?: string;
    entry?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | 'ignore';
    /** The captain's pinned language. Read from config when not supplied. */
    voice?: CaptainVoice;
    /**
     * Where to put the first-run language question. Absent means DO NOT ASK —
     * the default, so that importing this function can never block on a prompt.
     * The entry point at the bottom of this file opts in; a test hands it
     * streams it controls.
     */
    firstRun?: FirstRunIO;
    /** The whole config, injectable so a test never touches the real one. */
    config?: BlueConfig;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const root = options.root ?? installRoot();

  // Read once. `loadConfig` never throws — a broken config file yields defaults,
  // which here means the captain's ask (ultracode, `auto`) and an undetected
  // language, which means Helm mirrors them: the same benign end state as an
  // empty `LANG`.
  const loaded = options.config ?? loadConfig();

  // Before anything is printed and long before Claude Code owns the screen: the
  // one question, and only on the launch where it has never been put. A captain
  // who has answered — or declined — never sees it again. See `first-run.ts`.
  const config =
    options.firstRun !== undefined && options.voice === undefined
      ? await askLanguage(loaded, options.firstRun, env)
      : loaded;

  const voice = options.voice ?? captainVoice(config, env);

  let claudePath: string;
  let systemPromptAppend: string;
  try {
    claudePath = resolveClaudeBinary(env);
    // The same list the argv will carry, so the window is never told about a
    // clamp it does not have — or left to discover one nobody mentioned.
    systemPromptAppend = helmSystemPrompt(root, deniedTools(env), voice, env);
  } catch (e: unknown) {
    errLine(e instanceof Error ? e.message : String(e));
    return 1;
  }

  // Nothing the captain typed is inspected. The only question asked of their
  // argv is whether it is empty, and that settles one thing: whether the opening
  // turn is ours to choose or theirs.
  const wake =
    captainArgs.length === 0 && !envFlag(env, 'BLUESPACE_NO_WAKE') ? wakePrompt(voice) : undefined;

  // Said before the window opens, because a beat later Claude Code owns the
  // screen. Only ever printed when something in THIS shell is measurably in the
  // way — a line every launch would be noise on the mornings it is fine.
  const posture = resolveHelmPosture(config);
  if (posture.ultracode) {
    const notice = ultracodeNotice(ultracodeBlockedBy(env));
    if (notice !== undefined) errLine(notice);
  }

  // Same rule: only when something is measurably in the way. An untrusted
  // directory is the one blocker that stops the window before it starts.
  const trust = trustNotice(workspaceTrusted(process.cwd(), env['HOME'] ?? os.homedir()), process.cwd());
  if (trust !== undefined) errLine(trust);

  const argv = buildHelmArgv({
    claudePath,
    mcpConfigJson: helmMcpConfig(options.entry ?? blueEntry()),
    root,
    systemPromptAppend,
    captainArgs,
    strictMcp: strictMcpRequested(env),
    deniedTools: deniedTools(env),
    // Not conditioned on the clamp. An unclamped window still has the same
    // thirteen tools from the same server, and still should not open on a dialog.
    allowedTools: HELM_ALLOWED_TOOLS,
    settingsJson: helmSettingsJson(posture.ultracode),
    permissionMode: posture.permissionMode,
    openingPrompt: wake,
  });

  try {
    const launchOptions: { stdio?: 'inherit' | 'ignore'; env: NodeJS.ProcessEnv } = { env };
    if (options.stdio !== undefined) launchOptions.stdio = options.stdio;
    return await launchWindow(claudePath, argv.slice(1), launchOptions);
  } catch (e: unknown) {
    errLine(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/**
 * Only launch when this file was the command, not when it was imported.
 *
 * `main` at module scope would mean a test that imports `buildHelmArgv` opens a
 * Claude Code window. Both sides are realpath'd because the installed `bluespace`
 * on PATH is a symlink into `dist/cli/`.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `firstRun: {}` = ask, using this terminal, if it is one and if nobody has
  // been asked before. It is passed HERE and nowhere else: a prompt that fires
  // on import would hang every test that touches this module.
  process.exitCode = await runLauncher(process.argv.slice(2), { firstRun: {} });
}
