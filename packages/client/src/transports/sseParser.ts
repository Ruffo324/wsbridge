/**
 * Synchronous SSE parser — no I/O; pure text transformation.
 *
 * Follows the WHATWG SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html)
 * at the field level.
 */

export interface SseEvent {
  id?: string;
  /** Defaults to "message" per spec when no "event:" field is present. */
  event?: string;
  /** Data lines joined with "\n", no trailing newline. */
  data: string;
}

/** Accumulated state for a single in-progress event. */
interface CurrentEvent {
  id?: string;
  event?: string;
  data: string[];
}

export class SseParser {
  /** Bytes that have not yet been terminated by a newline. */
  private buf = "";
  /** The event currently being accumulated. */
  private cur: CurrentEvent = { data: [] };
  /** Last seen id (persists across event boundaries per spec). */
  private lastId: string | undefined = undefined;

  /**
   * Push a chunk of UTF-8 text.
   * Returns any events that were completed by this chunk.
   */
  push(chunk: string): SseEvent[] {
    // Normalise line endings: \r\n → \n, lone \r → \n
    const normalised = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buf += normalised;

    const events: SseEvent[] = [];

    let newlineIdx = this.buf.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buf.slice(0, newlineIdx);
      this.buf = this.buf.slice(newlineIdx + 1);
      const dispatched = this.processLine(line);
      if (dispatched !== null) {
        events.push(dispatched);
      }
      newlineIdx = this.buf.indexOf("\n");
    }

    return events;
  }

  /**
   * Force-flush any pending partial event (call on stream close).
   * Per spec, a trailing line without a terminator is NOT dispatched.
   * This method follows spec — returns nothing unless there is buffered data
   * that includes a blank-line terminator which was somehow not processed yet.
   * In practice it is called to drain any remaining buf content.
   */
  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buf.length > 0) {
      // Treat the remaining content as a final line (no terminator → not dispatched per spec)
      this.buf = "";
    }
    return events;
  }

  /** Process a single line; returns a dispatched event or null. */
  private processLine(line: string): SseEvent | null {
    // Blank line → dispatch event
    if (line === "") {
      return this.dispatchEvent();
    }

    // Comment line — ignore
    if (line.startsWith(":")) {
      return null;
    }

    const colonIdx = line.indexOf(":");
    let field: string;
    let value: string;

    if (colonIdx === -1) {
      // No colon → entire line is field name, value is empty string
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIdx);
      // If next char is a space, strip it (spec: "remove a single U+0020 SPACE")
      value = line.slice(colonIdx + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
    }

    switch (field) {
      case "id":
        this.cur.id = value;
        break;
      case "event":
        this.cur.event = value;
        break;
      case "data":
        this.cur.data.push(value);
        break;
      case "retry":
        // Ignore for MVP (reconnect timing handled elsewhere)
        break;
      default:
        // Unknown field — ignore per spec
        break;
    }

    return null;
  }

  /** Dispatch the current event if it has data. Returns null otherwise. */
  private dispatchEvent(): SseEvent | null {
    const { id, event, data } = this.cur;

    // Reset accumulator
    this.cur = { data: [] };

    // Per spec: if data buffer is empty, do not dispatch
    if (data.length === 0) {
      return null;
    }

    // Update last seen id
    if (id !== undefined) {
      this.lastId = id;
    }

    return {
      id: this.lastId,
      event,
      // Join data lines with \n; remove trailing \n added by last join
      data: data.join("\n"),
    };
  }
}
