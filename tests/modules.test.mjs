/**
 * Module graph guard.
 *
 * Every `import { ... } from "./x.js"` in the frontend must resolve to a real
 * file that actually exports those names. This catches the cheapest and most
 * common breakage in a no-bundler project: a renamed export or a typo in a
 * path, which a browser would only reveal at runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// js/config.js reads window/document at import time.
globalThis.window = {
  location: {
    origin: "https://droply-files.vercel.app",
    hostname: "droply-files.vercel.app",
    protocol: "https:",
    pathname: "/",
    search: "",
  },
  isSecureContext: true,
  setTimeout,
  clearTimeout,
};
globalThis.document = { querySelector: () => null };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JS_ROOT = path.join(ROOT, "js");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const STATIC_IMPORT = /import\s+(?:([\w*\s{},]+?)\s+from\s+)?["']([^"']+)["']/g;

function collectImports(source) {
  const found = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const clause = (match[1] ?? "").trim();
    const specifier = match[2];
    const names = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const entry of braces[1].split(",")) {
        const name = entry.trim().split(/\s+as\s+/)[0];
        if (name) names.push(name);
      }
    }
    found.push({ specifier, names });
  }
  return found;
}

const files = walk(JS_ROOT);

test("every frontend module evaluates", async () => {
  for (const file of files) {
    const relative = path.relative(ROOT, file).replace(/\\/g, "/");
    if (relative === "js/app.js") continue; // boot() needs a real document
    await assert.doesNotReject(
      () => import(pathToFileURL(file).href),
      `${relative} must import without throwing`,
    );
  }
});

test("every import target exists and exports the names it promises", async () => {
  const modules = new Map();
  const load = async (file) => {
    if (!modules.has(file)) {
      modules.set(file, await import(pathToFileURL(file).href));
    }
    return modules.get(file);
  };

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const { specifier, names } of collectImports(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      const relative = path.relative(ROOT, file).replace(/\\/g, "/");
      assert.ok(fs.existsSync(target), `${relative} imports missing file ${specifier}`);

      if (!names.length) continue;
      const exports = await load(target);
      for (const name of names) {
        assert.ok(
          name in exports,
          `${relative} imports "${name}" from ${specifier}, which does not export it`,
        );
      }
    }
  }
});

test("the app shell loads the feature stylesheet", () => {
  const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(index, /css\/features\.css/);
  assert.ok(fs.existsSync(path.join(ROOT, "css/features.css")));
});

test("worker sources and the presence binding agree", () => {
  const wrangler = fs.readFileSync(path.join(ROOT, "worker/wrangler.toml"), "utf8");
  assert.match(wrangler, /name = "PRESENCE"/);
  assert.match(wrangler, /class_name = "Presence"/);
  assert.match(wrangler, /new_sqlite_classes = \["Presence"\]/, "the class needs a migration");

  // Six-character pairing sessions need their own Durable Object + migration.
  assert.match(wrangler, /name = "PAIRING"/);
  assert.match(wrangler, /class_name = "Pairing"/);
  assert.match(wrangler, /new_sqlite_classes = \["Pairing"\]/, "the class needs a migration");

  const index = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
  assert.match(index, /export \{ Room, RateLimiter, Presence, Pairing \}/);
  assert.match(index, /\/api\/nearby\/register/);
  assert.match(index, /\/api\/nearby\/socket/);
  assert.match(index, /\/api\/pair/);
});
