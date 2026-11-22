// Build the extension into dist/ with esbuild (no framework, no bundler plugins).
//   node scripts/build.mjs          production build
//   node scripts/build.mjs --watch  rebuild on change
import { build, context } from "esbuild";
import { cpSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "app"), { recursive: true });
mkdirSync(join(dist, "devtools"), { recursive: true });

const common = { bundle: true, format: "iife", target: "chrome120", logLevel: "info", sourcemap: false, legalComments: "none" };
const entries = [
  { entryPoints: [join(root, "src/page/index.ts")], outfile: join(dist, "page.js") },
  { entryPoints: [join(root, "src/content/content.ts")], outfile: join(dist, "content.js") },
  { entryPoints: [join(root, "src/background/index.ts")], outfile: join(dist, "background.js") },
  { entryPoints: [join(root, "src/app/main.ts")], outfile: join(dist, "app/main.js") },
  { entryPoints: [join(root, "src/devtools/devtools.ts")], outfile: join(dist, "devtools/devtools.js") },
];

function copyStatic() {
  copyFileSync(join(root, "manifest.json"), join(dist, "manifest.json"));
  cpSync(join(root, "icons"), join(dist, "icons"), { recursive: true });
  copyFileSync(join(root, "src/app/index.html"), join(dist, "app/index.html"));
  copyFileSync(join(root, "src/app/style.css"), join(dist, "app/style.css"));
  copyFileSync(join(root, "src/devtools/devtools.html"), join(dist, "devtools/devtools.html"));
}

copyStatic();
if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
  console.log("watching…");
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
  const m = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  for (const f of ["page.js", "content.js", "background.js", "app/main.js", "app/index.html"]) {
    if (!existsSync(join(dist, f))) throw new Error("missing build output " + f);
  }
  console.log(`built Cetus ${m.version} -> dist/`);
}
