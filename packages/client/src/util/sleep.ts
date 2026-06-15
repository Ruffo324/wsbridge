/**
 * AbortSignal-aware sleep.
 * Rejects with the signal's reason (or a DOMException AbortError) if aborted.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject((signal as AbortSignal).reason ?? new DOMException("Aborted", "AbortError"));
    }

    function off(): void {
      signal?.removeEventListener("abort", onAbort);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
