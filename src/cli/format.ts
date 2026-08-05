/**
 * Presentation primitives for the `blue` CLI.
 *
 * This module owns *how things look in a terminal* and nothing else: raw ANSI
 * escapes (no chalk), colour capability detection, column-aligned tables,
 * relative time, USD, and the per-state colour vocabulary the whole CLI shares
 * so `ps`, `inbox`, and `log` never disagree about what "working" looks like.
 *
 * Deliberately dependency-free — it imports types only, never runtime code.
 */

import type { TaskState } from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';

// ---------------------------------------------------------------------------
// Colour capability
// ---------------------------------------------------------------------------

const CSI = '\u001B[';

/** Raw SGR parameter strings. Kept as data so `paint` can compose them. */
export const SGR = {
  reset: '0',
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  inverse: '7',
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  brightRed: '91',
  brightGreen: '92',
  brightYellow: '93',
  brightBlue: '94',
  brightMagenta: '95',
  brightCyan: '96',
} as const;

export type SgrName = keyof typeof SGR;

function detectColour(): boolean {
  const env = process.env;
  // https://no-color.org — presence of the variable at all disables colour.
  if (env['NO_COLOR'] !== undefined) return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true;
  if (env['TERM'] === 'dumb') return false;
  return process.stdout.isTTY === true;
}

let colourOn = detectColour();

/** True when the current stream should receive ANSI escapes. */
export function colourEnabled(): boolean {
  return colourOn;
}

/** Force colour on or off (used by `--no-color` and by tests). */
export function setColourEnabled(on: boolean): void {
  colourOn = on;
}

/** Wrap `text` in the given SGR codes, or return it untouched when colour is off. */
export function paint(text: string, ...names: SgrName[]): string {
  if (!colourOn || names.length === 0 || text === '') return text;
  const codes = names.map((n) => SGR[n]).join(';');
  return `${CSI}${codes}m${text}${CSI}${SGR.reset}m`;
}

export const bold = (s: string): string => paint(s, 'bold');
export const dim = (s: string): string => paint(s, 'dim');
export const red = (s: string): string => paint(s, 'red');
export const green = (s: string): string => paint(s, 'green');
export const yellow = (s: string): string => paint(s, 'yellow');
export const blue = (s: string): string => paint(s, 'brightBlue');
export const cyan = (s: string): string => paint(s, 'cyan');
export const magenta = (s: string): string => paint(s, 'magenta');
export const gray = (s: string): string => paint(s, 'gray');

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** Remove every SGR escape, so widths can be measured honestly. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

/**
 * Terminal cells occupied by one code point.
 *
 * A pragmatic wcwidth: combining marks and variation selectors take no cell,
 * CJK and emoji take two, everything else takes one. Without this a task title
 * containing an emoji silently shifts every column to its right.
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // Combining marks, zero-width joiners/spaces, variation selectors, skin tones.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff)
  ) {
    return 0;
  }
  // Wide: Hangul, CJK, fullwidth forms, and the emoji planes.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Printable width of a string in terminal cells, ignoring colour escapes. */
export function visibleWidth(s: string): number {
  let width = 0;
  for (const ch of stripAnsi(s)) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Collapse whitespace and truncate to `max` terminal cells, adding an ellipsis.
 * Colour-unaware — strips escapes rather than cutting one in half.
 */
export function truncate(s: string, max: number): string {
  const flat = stripAnsi(s).replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  if (visibleWidth(flat) <= max) return flat;
  if (max === 1) return '…';

  let width = 0;
  let kept = '';
  for (const ch of flat) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (width + cw > max - 1) break;
    kept += ch;
    width += cw;
  }
  return `${kept}…`;
}

/** Pad to `width` printable characters. */
export function padEnd(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** Left-pad to `width` printable characters. */
export function padStart(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? ' '.repeat(gap) + s : s;
}

/** `1 task` / `2 tasks`. */
export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}

/** Matches a v4-style UUID, the shape used for task, crew, decision and verdict ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abbreviate an id for display.
 *
 * UUIDs are cut to their first group: 8 hex characters, unique enough in a fleet
 * this size and short enough to scan down a column.
 *
 * Everything else is returned WHOLE. Project ids are minted as `slug-abc123`,
 * and a blind 8-character slice turns `fixture-feba0a` into `fixture-` — which
 * is not merely ugly, it is wrong: it is the string a captain would copy, and it
 * identifies nothing. Ids that are meant to be typed are never truncated here.
 */
export function shortId(id: string): string {
  return UUID_RE.test(id) ? id.slice(0, 8) : id;
}

/** Indent every line of a block. */
export function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n');
}

/** A horizontal rule, dimmed. */
export function rule(width = 60, char = '─'): string {
  return dim(char.repeat(Math.max(1, width)));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface TableColumn {
  header: string;
  /** Right-align numeric columns (cost). Defaults to left. */
  align?: 'left' | 'right';
  /** Hard cap on printable width; cells are truncated to fit. */
  max?: number;
}

/**
 * Render an aligned table. Cells may already contain colour escapes — widths
 * are measured on the printable text, so alignment survives colouring.
 */
export function renderTable(columns: TableColumn[], rows: string[][]): string {
  if (columns.length === 0) return '';

  const capped = rows.map((row) =>
    columns.map((col, i) => {
      const cell = row[i] ?? '';
      if (col.max !== undefined && visibleWidth(cell) > col.max) {
        // Truncation is only safe on uncoloured cells; colour them after.
        return truncate(stripAnsi(cell), col.max);
      }
      return cell;
    }),
  );

  const widths = columns.map((col, i) => {
    let w = visibleWidth(col.header);
    for (const row of capped) {
      const cell = row[i] ?? '';
      w = Math.max(w, visibleWidth(cell));
    }
    return col.max !== undefined ? Math.min(w, col.max) : w;
  });

  const line = (cells: string[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const width = widths[i] ?? 0;
      const cell = cells[i] ?? '';
      const isLast = i === columns.length - 1;
      if (col?.align === 'right') {
        parts.push(padStart(cell, width));
      } else {
        parts.push(isLast ? cell : padEnd(cell, width));
      }
    }
    return parts.join('  ').replace(/\s+$/, '');
  };

  const header = line(columns.map((c) => dim(c.header.toUpperCase())));
  return [header, ...capped.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact duration: `4s`, `12m`, `2h 5m`, `3d 4h`. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  if (abs < MINUTE) return `${Math.round(abs / SECOND)}s`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)}m`;
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs % HOUR) / MINUTE);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** `3m ago`, `just now`, `in 20s`. */
export function relTime(at: number, now: number = Date.now()): string {
  const delta = now - at;
  if (delta < 0) return `in ${formatDuration(-delta)}`;
  if (delta < 5 * SECOND) return 'just now';
  return `${formatDuration(delta)} ago`;
}

/** Wall-clock time, for event logs: `14:03:22`. */
export function clockTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** `$0.00`, `$0.0042`, `$12.30`. Sub-cent amounts keep four decimals. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$—';
  const n = Math.max(0, usd);
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * `0 B`, `812 B`, `4.2 MB`. Powers of 1024, one decimal above a kilobyte.
 *
 * Used by `blue gc` to make the size of `~/.bluespace/worktrees` legible at a
 * glance — the number exists to answer "is this growing", so readable beats
 * exact.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < BYTE_UNITS.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const label = BYTE_UNITS[unit] ?? 'B';
  return unit === 0 ? `${Math.round(n)} ${label}` : `${n.toFixed(1)} ${label}`;
}

// ---------------------------------------------------------------------------
// Task state vocabulary
// ---------------------------------------------------------------------------

const STATE_SGR: Record<TaskState, SgrName[]> = {
  queued: ['gray'],
  dispatched: ['cyan'],
  working: ['brightBlue'],
  awaiting_decision: ['brightYellow', 'bold'],
  verifying: ['magenta'],
  needs_rework: ['yellow'],
  ready: ['brightGreen'],
  landed: ['green'],
  failed: ['red'],
  cancelled: ['gray', 'dim'],
};

/** Colour a task state for terminal output (no-op when colour is disabled). */
export function colourState(state: TaskState): string {
  return paint(state, ...(STATE_SGR[state] ?? ['white']));
}

/** A single-glyph state marker, for dense views. */
export function stateGlyph(state: TaskState): string {
  const glyphs: Record<TaskState, string> = {
    queued: '·',
    dispatched: '→',
    working: '●',
    awaiting_decision: '?',
    verifying: '◇',
    needs_rework: '↺',
    ready: '✓',
    landed: '✔',
    failed: '✗',
    cancelled: '−',
  };
  return paint(glyphs[state] ?? '·', ...(STATE_SGR[state] ?? ['white']));
}

// ---------------------------------------------------------------------------
// Event rendering (used by `blue log`)
// ---------------------------------------------------------------------------

export interface EventLine {
  label: string;
  detail: string;
}

/** Render one Blackbox event as a label plus a human-readable detail string. */
export function describeEvent(e: BlueEvent): EventLine {
  switch (e.type) {
    case 'task.created':
      return { label: cyan('created'), detail: `${e.kind} · ${e.title}` };
    case 'task.dispatched':
      return {
        label: cyan('dispatched'),
        detail: `crew ${shortId(e.crewId)} · ${e.permissionMode}${
          e.model ? ` · ${e.model}` : ''
        }${e.effort ? ` · effort ${e.effort}` : ''} · ${e.worktree}`,
      };
    case 'task.state_changed':
      return {
        label: dim('state'),
        detail: `${colourState(e.from)} → ${colourState(e.to)}${
          e.reason ? dim(`  (${e.reason})`) : ''
        }`,
      };
    case 'task.completed':
      return {
        label: green('completed'),
        detail: e.artifact ? `${e.summary} · ${e.artifact}` : e.summary,
      };
    case 'task.failed':
      return { label: red('failed'), detail: e.reason };
    case 'crew.spawned':
      return {
        label: blue('crew up'),
        // The attach command goes on its own line: it is the one thing on this
        // event a human acts on, and a command you have to reconstruct out of a
        // wrapped line is a command nobody runs. `eventLine` indents the rest.
        detail:
          `${shortId(e.crewId)} in ${e.cwd}${e.sessionId ? dim(` · session ${shortId(e.sessionId)}`) : ''}` +
          (e.attachCommand !== undefined ? `\n${dim('watch it:')} ${e.attachCommand}` : ''),
      };
    case 'crew.text':
      return { label: blue('crew'), detail: e.text };
    case 'crew.thinking':
      return { label: dim('crew'), detail: dim('thinking…') };
    case 'crew.tool_use':
      return { label: magenta('tool'), detail: `${e.name}(${truncate(e.inputPreview, 90)})` };
    case 'crew.tool_result':
      return {
        label: e.ok ? dim('result') : red('result'),
        detail: e.resultPreview ? truncate(e.resultPreview, 110) : e.ok ? 'ok' : 'error',
      };
    case 'crew.usage':
      return {
        label: dim('usage'),
        detail: `${formatUsd(e.costUsd)} · ${e.inputTokens} in / ${e.outputTokens} out${
          e.model ? ` · ${e.model}` : ''
        }`,
      };
    case 'crew.exited':
      return {
        label: e.ok ? dim('crew down') : red('crew down'),
        detail: `${e.ok ? 'ok' : 'error'}${e.interrupted ? ' · interrupted' : ''}${
          e.reason ? ` · ${e.reason}` : ''
        }`,
      };
    case 'decision.opened':
      return {
        label: yellow('decision'),
        detail: `${e.question}${e.options.length > 0 ? dim(` [${e.options.map((o) => o.label).join(' | ')}]`) : ''}`,
      };
    case 'decision.resolved':
      return { label: green('answered'), detail: e.answer };
    case 'sentinel.started':
      return { label: magenta('sentinel'), detail: `verifying (${shortId(e.verdictId)})` };
    case 'sentinel.verdict':
      return {
        label: e.pass ? green('verdict') : red('verdict'),
        detail: `${e.pass ? 'PASS' : 'FAIL'} · ${e.reasoning}${
          e.unmet.length > 0 ? dim(`  unmet: ${e.unmet.join('; ')}`) : ''
        }`,
      };
    case 'project.registered':
      return { label: cyan('project'), detail: `${e.name} · ${e.path}` };
    default:
      return { label: dim('event'), detail: '' };
  }
}
