import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["packages/adapters/home-assistant/src/index.ts"],
  format: ["esm"],
  // Bundle both @https2wss/client and @https2wss/protocol inline so the
  // browser output is a single self-contained ESM file with no bare specifiers.
  noExternal: ["@https2wss/client", "@https2wss/protocol"],
  outDir: "packages/adapters/home-assistant/dist/browser",
  dts: false,
  sourcemap: true,
  clean: false,
  target: "es2022",
  platform: "browser",
  treeshake: false,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
});
