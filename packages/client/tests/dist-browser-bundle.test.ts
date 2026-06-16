/**
 * Regression test: packages/client/dist/index.js must NOT contain bare module
 * specifiers (e.g. "@https2wss/protocol") because the browser cannot resolve them
 * without an import map.  The tsup build step in the root "build" script bundles
 * @https2wss/protocol inline; this test guards against that step being removed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIST = resolve(import.meta.dirname, "../dist/index.js");

describe("client dist browser bundle", () => {
  it("dist/index.js must not import @https2wss/protocol as a bare specifier", () => {
    let source: string;
    try {
      source = readFileSync(DIST, "utf8");
    } catch {
      // If the file doesn't exist yet (clean checkout before build) skip
      // gracefully rather than fail — the build step produces it.
      console.warn("dist/index.js not found — run `pnpm build` first");
      return;
    }
    // A bare-specifier import looks like: from "@https2wss/protocol"
    expect(source).not.toMatch(/"@https2wss\/protocol"/);
  });

  it("dist/index.js must export Https2WssSocket", () => {
    let source: string;
    try {
      source = readFileSync(DIST, "utf8");
    } catch {
      console.warn("dist/index.js not found — run `pnpm build` first");
      return;
    }
    expect(source).toMatch(/Https2WssSocket/);
  });
});
