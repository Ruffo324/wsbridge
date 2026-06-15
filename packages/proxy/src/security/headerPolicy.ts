export class HeaderPolicy {
  private readonly allowedHeaders: ReadonlySet<string>;

  constructor(opts: { allowedHeaders: ReadonlyArray<string> }) {
    // Normalize to lowercase at construction time for O(1) lookup.
    // Dangerous headers (host, authorization, cookie, origin, forwarded, x-forwarded-*)
    // are blocked unless explicitly listed here — the deny-by-default behaviour comes
    // from the allowlist-only approach: a header only passes if it is in allowedHeaders.
    this.allowedHeaders = new Set(opts.allowedHeaders.map((h: string) => h.toLowerCase()));
  }

  /**
   * Filter a header bag (input keys are assumed already lowercased) down to allowed headers.
   * A header passes iff its name is in the explicit allowedHeaders list.
   * Dangerous headers that the profile explicitly allows are passed through.
   * Unknown/unlisted headers are silently dropped — no exception thrown.
   */
  filterOutbound(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (this.allowedHeaders.has(lower)) {
        result[lower] = value;
      }
      // else: drop silently
    }
    return result;
  }
}
