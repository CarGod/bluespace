/**
 * Blackbox store — the append-only event log every other module reads from.
 *
 * This module owns exactly one thing: durable, ordered, queryable persistence
 * of `BlueEventBody` values. It assigns `seq` (monotonic, gap-free-ish, and the
 * only ordering anyone may rely on) and `at` (wall clock, informational).
 *
 * It deliberately knows NOTHING about task state, cost, or decisions — those
 * are folds over the log and live in `projections.ts`. Keeping the writer dumb
 * is what lets the reader change its mind later without a migration.
 *
 * Everything here is synchronous: better-sqlite3 is synchronous, and an event
 * log that can silently reorder under concurrent async writers is a liability.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import type { BlueEvent, BlueEventBody, BlueEventType } from '../types/events.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  type    TEXT    NOT NULL,
  task_id TEXT,
  body    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_task_id ON events (task_id);
CREATE INDEX IF NOT EXISTS idx_events_at      ON events (at);
`;

interface EventRow {
  seq: number;
  at: number;
  body: string;
}

export interface ReadOptions {
  /** Exclusive: return events with seq strictly greater than this. */
  sinceSeq?: number;
  taskId?: string;
  types?: BlueEventType[];
  /** Max rows, taken from the START of the (seq ASC) result set. */
  limit?: number;
}

export type Subscriber = (e: BlueEvent) => void;

/**
 * Pull the task id out of a body when the variant carries one, so
 * `read({ taskId })` hits an index instead of scanning and parsing JSON.
 * Crew-scoped events (crew.text, crew.usage, ...) carry only a crewId; the
 * crew -> task mapping is reconstructed at projection time from crew.spawned.
 */
export function taskIdOf(body: BlueEventBody): string | undefined {
  return 'taskId' in body && typeof body.taskId === 'string' ? body.taskId : undefined;
}

/** Pull the crew id out of a body when the variant carries one. */
export function crewIdOf(body: BlueEventBody): string | undefined {
  return 'crewId' in body && typeof body.crewId === 'string' ? body.crewId : undefined;
}

export class Blackbox {
  readonly path: string;

  private readonly db: Database.Database;
  private readonly subscribers = new Set<Subscriber>();
  private readonly stmtCache = new Map<string, Database.Statement<unknown[], EventRow>>();
  private readonly insert: Database.Statement<
    [number, string, string | null, string],
    unknown
  >;
  private closed = false;

  private constructor(db: Database.Database, path: string) {
    this.db = db;
    this.path = path;
    this.insert = this.db.prepare(
      'INSERT INTO events (at, type, task_id, body) VALUES (?, ?, ?, ?)',
    ) as Database.Statement<[number, string, string | null, string], unknown>;
  }

  /**
   * Open (creating if absent) the log at `dbPath`. Pass ':memory:' for tests.
   * Idempotent: opening an existing database re-applies the schema as no-ops.
   */
  static open(dbPath: string): Blackbox {
    if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
      const dir = dirname(dbPath);
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    }

    const db = new Database(dbPath);
    // WAL lets the TUI/server read while a Crew's event firehose is writing.
    // In-memory databases report 'memory' here and ignore the request; that is
    // fine and not an error.
    db.pragma('journal_mode = WAL');
    // NORMAL is the standard companion to WAL: a hard power loss can drop the
    // most recent commits but can never corrupt the log. FULL would fsync on
    // every crew.text event, which is far too expensive for a live stream.
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);

    return new Blackbox(db, dbPath);
  }

  /** Append one event. Stamps `at`, assigns `seq`, notifies subscribers. */
  append(body: BlueEventBody): BlueEvent {
    this.assertOpen();
    const event = this.insertOne(body);
    this.notify([event]);
    return event;
  }

  /**
   * Append many events in ONE transaction — either every event lands or none
   * does. Subscribers are notified only after the commit succeeds, so nobody
   * ever observes an event that later disappears.
   */
  appendMany(bodies: BlueEventBody[]): BlueEvent[] {
    this.assertOpen();
    if (bodies.length === 0) return [];

    const run = this.db.transaction((batch: BlueEventBody[]): BlueEvent[] =>
      batch.map((body) => this.insertOne(body)),
    );
    const events = run(bodies);
    this.notify(events);
    return events;
  }

  /** Query the log. Always ordered by seq ASC. */
  read(opts: ReadOptions = {}): BlueEvent[] {
    this.assertOpen();

    // An explicit empty type filter matches nothing; a limit of zero or less
    // asks for nothing. Both are legitimate callers, not errors.
    if (opts.types && opts.types.length === 0) return [];
    if (opts.limit !== undefined && opts.limit <= 0) return [];

    const where: string[] = [];
    const params: unknown[] = [];

    if (opts.sinceSeq !== undefined) {
      where.push('seq > ?');
      params.push(opts.sinceSeq);
    }
    if (opts.taskId !== undefined) {
      where.push('task_id = ?');
      params.push(opts.taskId);
    }
    if (opts.types) {
      where.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
      params.push(...opts.types);
    }

    let sql = 'SELECT seq, at, body FROM events';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY seq ASC';
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(Math.floor(opts.limit));
    }

    return this.statement(sql).all(params).map(rowToEvent);
  }

  /**
   * Register a listener for every subsequently appended event. Returns the
   * unsubscribe function. Listeners are called synchronously, in registration
   * order, after the write is durable.
   */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.subscribers.clear();
    this.stmtCache.clear();
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private insertOne(body: BlueEventBody): BlueEvent {
    const at = Date.now();
    const info = this.insert.run(at, body.type, taskIdOf(body) ?? null, JSON.stringify(body));
    const seq = Number(info.lastInsertRowid);
    return { ...body, seq, at };
  }

  /**
   * Fan out to subscribers. A broken listener must never take down the writer:
   * the event is already committed, so throwing here would report failure for
   * a write that actually succeeded. Errors are swallowed rather than logged
   * because stdout/stderr belong to the CLI's rendering, not to the store.
   */
  private notify(events: BlueEvent[]): void {
    if (this.subscribers.size === 0) return;
    // Snapshot: a listener may unsubscribe (or subscribe) during dispatch.
    const listeners = [...this.subscribers];
    for (const event of events) {
      for (const fn of listeners) {
        if (!this.subscribers.has(fn)) continue;
        try {
          fn(event);
        } catch {
          // Intentionally ignored — see comment above.
        }
      }
    }
  }

  private statement(sql: string): Database.Statement<unknown[], EventRow> {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql) as Database.Statement<unknown[], EventRow>;
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Blackbox is closed');
  }
}

function rowToEvent(row: EventRow): BlueEvent {
  const body = JSON.parse(row.body) as BlueEventBody;
  return { ...body, seq: row.seq, at: row.at };
}
