#!/usr/bin/env node
// Bundles the PoC: node poc/build.mjs [--watch]
import { context } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ctx = await context({
  entryPoints: [here("./src/demo.ts")],
  outfile: here("./dist/demo.js"),
  bundle: true, format: "esm", target: "es2020", sourcemap: true, minify: !process.argv.includes("--watch"),
});
if (process.argv.includes("--watch")) { await ctx.watch(); console.log("watching poc/src …"); }
else { await ctx.rebuild(); await ctx.dispose(); console.log("built poc/dist/demo.js"); }
