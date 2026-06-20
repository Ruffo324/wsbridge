import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["packages/client/src/index.ts"],
  format: ["esm"],
  // Bundle @https2wss/protocol so the browser output has no bare specifiers.
  noExternal: ["@https2wss/protocol"],
  outDir: "packages/client/dist/browser",
  dts: false,
  sourcemap: true,
  clean: false,
  target: "es2022",
  platform: "browser",
  treeshake: false,
  splitting: false,
  outExtension: () => ({ js: ".js" }),
});
