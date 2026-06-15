/**
 * Tiny event emitter — no external dependencies; works in browser and Node.
 */

export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  /** Subscribe. Returns an unsubscribe function. */
  on(l: Listener<T>): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /**
   * Dispatch value to all listeners.
   *
   * Each listener is called in a try/catch so that one misbehaving listener
   * cannot prevent delivery to the remaining listeners — the same guarantee
   * native EventTarget gives when a handler throws.
   */
  emit(v: T): void {
    for (const l of this.listeners) {
      try {
        l(v);
      } catch {
        // Intentionally swallowed: one bad listener must not break others.
      }
    }
  }
}
