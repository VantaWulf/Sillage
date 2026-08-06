/**
 * Copy static site assets into public/ for Vercel (same pattern as Hermes).
 * Root files stay the source of truth for local server.py + GitHub Pages.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public");

const FILES = [
  "index.html",
  "app.js",
  "styles.css",
  "data.js",
  "catalog.json",
  "catalog-popular.json",
  ".nojekyll",
];

const DIRS = ["images"];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(rel) {
  const src = path.join(ROOT, rel);
  const dest = path.join(OUT, rel);
  if (!fs.existsSync(src)) {
    console.warn("skip missing", rel);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(rel) {
  const src = path.join(ROOT, rel);
  const dest = path.join(OUT, rel);
  if (!fs.existsSync(src)) {
    console.warn("skip missing dir", rel);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(from, to, { recursive: true });
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) copyFile(f);
for (const d of DIRS) copyDir(d);
console.log("built public/ for Vercel from static root assets");
