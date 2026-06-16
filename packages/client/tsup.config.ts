import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["packages/client/src/index.ts"],
  format: ["esm"],
  // Bundle @https2wss/protocol so the browser output has no bare specifiers.
  // Node consumers (tests, adapters) rely on the tsc .d.ts / composite build;
  // this tsup step is solely for the browser-deployable dist/index.js.
  noExternal: ["@https2wss/protocol"],
  outDir: "packages/client/dist",
  dts: false, // tsc -b handles declarations via composite refs
  sourcemap: true,
  clean: false, // Do not wipe tsc .d.ts files; only overwrite .js
  target: "es2022",
  platform: "browser",
  // Keep all public exports; no tree-shake at this layer
  treeshake: false,
  // Single-file bundle named index.js so nginx serve path stays unchanged
  splitting: false,
  outExtension: () => ({ js: ".js" }),
});
