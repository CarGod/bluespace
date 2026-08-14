/**
 * Telling the captain something finished, when nobody is looking at the screen.
 *
 * WHY THIS HAS TO EXIST OUTSIDE THE MODEL. Helm is an interactive Claude Code
 * session, and a session speaks only when it is spoken to: there is no turn in
 * which nobody typed. So Helm cannot volunteer "the task you dispatched twenty
 * minutes ago just landed" — not because it is unhelpful, but because it is not
 * running at that moment. The wake sweep is what answers that question, and it
 * answers it the next time the captain says something, which may be an hour
 * later or the next morning.
 *
 * The orchestrator, on the other hand, is deterministic code that is running
 * exactly when the task settles. So the push comes from here, and it is a
 * NOTIFICATION rather than a report: enough to decide whether to go and look,
 * never a substitute for the sweep that has the detail.
 *
 * WHAT IT DELIBERATELY IS NOT. It does not summarise the diff, it does not
 * paraphrase a verdict, and it never claims a task is delivered. `landed` means
 * verification is over and the branch is sitting in a worktree — the same thing
 * it means everywhere else in BlueSpace — and a notification that made it sound
 * like a deployment would be the most expensive kind of wrong.
 */

import { spawn } from 'node:child_process';

/** One thing worth interrupting the captain for. */
export interface FleetNotice {
  /** Bold line: the outcome and where. */
  title: string;
  /** The task, and one clause about how it went. */
  body: string;
}

/** Everything that could stop a notifier from existing, named. */
export type NotifierReason =
  | 'disabled-by-config'
  | 'disabled-by-env'
  | 'unsupported-platform';

export type Notifier = (notice: FleetNotice) => void;

/**
 * `osascript` takes an AppleScript SOURCE STRING, so a task title is source
 * code the moment it is interpolated — and BlueSpace's task titles are written
 * by whoever wrote the brief.
 *
 * Backslash first, then quote: the other order double-escapes. Newlines become
 * spaces because a literal newline ends the AppleScript statement, and a control
 * character in a title would otherwise mean a notification that never appears
 * and an error nobody sees.
 *
 * Exported so the rule can be tested as what it is: a quoting rule.
 */
export function appleScriptString(value: string): string {
  const flat = value.replace(/[\r\n\t]+/g, ' ');
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The one line handed to `osascript -e`. Exported for the same reason. */
export function appleScriptFor(notice: FleetNotice): string {
  return `display notification ${appleScriptString(notice.body)} with title ${appleScriptString(notice.title)}`;
}

/**
 * Fire and forget, with the emphasis on FORGET.
 *
 * Detached, output discarded, `unref`'d, and every error swallowed: this runs
 * inside the dispatch loop, and a fleet that stalls because a notification
 * daemon is wedged would be a worse bug than never being told at all. The
 * `error` listener is not optional — an unhandled one on a spawn is an
 * uncaught exception that takes the process with it.
 */
function fire(command: string, args: readonly string[]): void {
  try {
    const child = spawn(command, [...args], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no notifier on this machine; the fleet does not care */
    });
    child.unref();
  } catch {
    /* same */
  }
}

/**
 * A notifier for this machine, or the reason there is none.
 *
 * `BLUESPACE_NO_NOTIFY=1` turns it off for one shell — for a captain who wants
 * the fleet quiet this afternoon without editing their config.
 */
export function desktopNotifier(
  options: { enabled?: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): { notify: Notifier } | { unavailable: NotifierReason } {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (options.enabled === false) return { unavailable: 'disabled-by-config' };
  const off = env['BLUESPACE_NO_NOTIFY'];
  if (off !== undefined && off !== '' && off !== '0' && off.toLowerCase() !== 'false') {
    return { unavailable: 'disabled-by-env' };
  }

  if (platform === 'darwin') {
    return { notify: (n) => fire('osascript', ['-e', appleScriptFor(n)]) };
  }
  if (platform === 'linux') {
    // argv, so nothing here is a quoting problem.
    return { notify: (n) => fire('notify-send', ['--app-name=BlueSpace', n.title, n.body]) };
  }
  return { unavailable: 'unsupported-platform' };
}
