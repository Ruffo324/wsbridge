/**
 * CookieJar interface + default browser implementation.
 *
 * Security note: the cookie stores only a routing decision (epoch-ms of the
 * fallback expiry). It contains no secrets or tokens. SameSite=Lax + Secure
 * (auto-set on HTTPS origins) is sufficient protection.
 *
 * Note: direct document.cookie assignment is intentional here — the Cookie Store API
 * is not yet universally available, and this module's sole purpose is low-level
 * routing-hint persistence.  biome-ignore comments mark the two necessary writes.
 */

export interface CookieJar {
  get(name: string): string | undefined;
  set(
    name: string,
    value: string,
    opts: {
      maxAgeMs: number;
      path?: string;
      sameSite?: "Strict" | "Lax" | "None";
      secure?: boolean;
    },
  ): void;
  delete(name: string): void;
}

/**
 * Returns a browser-backed CookieJar when `document` is available,
 * or `undefined` in Node / non-browser environments.
 */
export function defaultCookieJar(): CookieJar | undefined {
  if (typeof document === "undefined") return undefined;
  return {
    get(name: string): string | undefined {
      const m = document.cookie.match(new RegExp(`(?:^|; )${encodeURIComponent(name)}=([^;]*)`));
      if (m == null) return undefined;
      const raw = m[1];
      return raw !== undefined ? decodeURIComponent(raw) : undefined;
    },

    set(
      name: string,
      value: string,
      opts: {
        maxAgeMs: number;
        path?: string;
        sameSite?: "Strict" | "Lax" | "None";
        secure?: boolean;
      },
    ): void {
      const expires = new Date(Date.now() + opts.maxAgeMs).toUTCString();
      const parts = [
        `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
        `Expires=${expires}`,
        `Path=${opts.path ?? "/"}`,
        `SameSite=${opts.sameSite ?? "Lax"}`,
      ];
      if (
        opts.secure === true ||
        (typeof location !== "undefined" && location.protocol === "https:")
      ) {
        parts.push("Secure");
      }
      // biome-ignore lint/suspicious/noDocumentCookie: intentional low-level routing cookie
      document.cookie = parts.join("; ");
    },

    delete(name: string): void {
      // biome-ignore lint/suspicious/noDocumentCookie: intentional cookie deletion
      document.cookie = `${encodeURIComponent(name)}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`;
    },
  };
}

// ── Cookie value format ────────────────────────────────────────────────────
//
// The cookie value is the numeric epoch-ms (as a decimal string) at which the
// fallback decision expires.  Only the FALLBACK (bridge) decision is persisted;
// a missing or unreadable cookie means "optimistically try native".
//
// Examples:
//   "1750123456789"   → bridge sticky until that epoch-ms
//   "" / "bad"        → ignored; treated as absent

/** Parse the epoch-ms stored in the cookie. Returns `undefined` for anything invalid. */
export function parseFallbackCookie(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Serialize the epoch-ms to store in the cookie. */
export function serializeFallbackCookie(untilMs: number): string {
  return String(untilMs);
}
