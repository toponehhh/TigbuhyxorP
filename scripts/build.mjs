import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/", import.meta.url);
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["worker.ts"],
  outfile: fileURLToPath(new URL("_worker.js", output)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
});
await cp(new URL("../public/", import.meta.url), output, { recursive: true });
console.log("Cloudflare Pages build ready: dist/_worker.js");
