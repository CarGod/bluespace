/**
 * Buffers every line readline emits.
 *
 * `rl.question` registers a *one-shot* listener, so on a non-TTY stdin — where
 * the whole pipe flushes in a single tick — any line after the first is dropped
 * on the floor. Queueing lines as they arrive makes a prompt scriptable
 * (`printf '1\n2\n' | blue inbox`) as well as interactive.
 *
 * Extracted from `inbox.ts` when the first-run language question hit the same
 * wall from the other side: two questions, one stream, and the second one
 * answering itself with an empty string because readline had already read and
 * discarded the line meant for it.
 */

import type * as readline from 'node:readline';

export class LineReader {
  private readonly buffered: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(rl: readline.Interface) {
    rl.on('line', (line: string) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.buffered.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()?.(null);
    });
  }

  /**
   * True once the input is exhausted.
   *
   * Worth asking before writing another prompt: `rl.prompt()` THROWS on a closed
   * interface, and a queued line can still be waiting to be read after the
   * stream that carried it has ended — which is the normal case for a pipe.
   */
  get done(): boolean {
    return this.closed && this.buffered.length === 0;
  }

  /** True once the underlying interface has closed, buffered lines or not. */
  get ended(): boolean {
    return this.closed;
  }

  /** Next line, or `null` once the input is exhausted. */
  next(): Promise<string | null> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
