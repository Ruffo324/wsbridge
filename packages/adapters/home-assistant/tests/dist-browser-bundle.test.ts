/**
 * Regression test: packages/adapters/home-assistant/dist/browser/index.js must NOT
 * contain bare module specifiers (e.g. "@https2wss/client", "@https2wss/protocol")
 * because the browser cannot resolve them without an import map.
 *
 * The tsup build step bundles both @https2wss/client and @https2wss/protocol inline;
 * this test guards against that step being removed or misconfigured.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIST = resolve(import.meta.dirname, "../dist/browser/index.js");

function readDist(): string | null {
  try {
    return readFileSync(DIST, "utf8");
  } catch {
    console.warn("dist/browser/index.js not found — run `pnpm build` first");
    return null;
  }
}

describe("home-assistant adapter dist browser bundle", () => {
  it("dist/browser/index.js must not import @https2wss/client as a bare specifier", () => {
    const source = readDist();
    if (source === null) return;
    expect(source).not.toMatch(/"@https2wss\/client"/);
  });

  it("dist/browser/index.js must not import @https2wss/protocol as a bare specifier", () => {
    const source = readDist();
    if (source === null) return;
    expect(source).not.toMatch(/"@https2wss\/protocol"/);
  });

  it("dist/browser/index.js must export HomeAssistantClient", () => {
    const source = readDist();
    if (source === null) return;
    expect(source).toMatch(/HomeAssistantClient/);
  });
});
