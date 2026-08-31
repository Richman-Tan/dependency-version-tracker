import { readdirSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "dist", ".git", ".vs"]);

/**
 * Resolve a manifest pattern to concrete file paths under repoRoot.
 * Supports plain relative paths and simple `**` globs of the form
 * `src/**\/*.csproj` (a fixed prefix, a recursive wildcard, and an extension).
 * Not a general glob engine — that's all the config schema allows.
 */
export function resolveManifests(repoRoot, pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  if (!normalized.includes("*")) {
    // Normalise so "app/x.json" and "./app/x.json" are one manifest, not two
    // identical rows. Kept relative; ".." is preserved and handled upstream.
    return [normalized.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/")];
  }
  const match = /^([^*]*?)\*\*\/(\*(\.[A-Za-z0-9.]+))$/.exec(normalized);
  if (!match) {
    throw new Error(
      `Unsupported manifest pattern "${pattern}". Use a plain path or "<prefix>/**/*.<ext>".`
    );
  }
  const prefix = match[1].replace(/\/$/, "");
  const ext = match[3];
  const startDir = path.join(repoRoot, prefix);
  const results = [];
  walk(startDir, ext, results);
  return results
    .map((abs) => path.relative(repoRoot, abs).replaceAll("\\", "/"))
    .sort();
}

function walk(dir, ext, results) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing directory: caller reports zero manifests
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), ext, results);
    } else if (entry.name.endsWith(ext)) {
      results.push(path.join(dir, entry.name));
    }
  }
}
