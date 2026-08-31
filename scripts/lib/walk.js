import { readdirSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "dist", ".git", ".vs"]);

/**
 * Resolve a manifest pattern to concrete file paths under repoRoot.
 *
 * Supports plain relative paths and two `**` glob shapes:
 *   `src/**\/*.csproj`      — every file with that extension
 *   `apps/**\/package.json` — every file with that exact name
 *
 * The exact-name form is what a multi-site repo needs: `apps/**\/*.json` would
 * also drag in tsconfig.json, package-lock.json and every other JSON file,
 * where `apps/**\/package.json` finds one manifest per site and nothing else.
 * Not a general glob engine — that's all the config schema allows.
 */
export function resolveManifests(repoRoot, pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  if (!normalized.includes("*")) {
    // Normalise so "app/x.json" and "./app/x.json" are one manifest, not two
    // identical rows. Kept relative; ".." is preserved and handled upstream.
    return [normalized.replace(/^\.\/+/, "").replace(/\/{2,}/g, "/")];
  }
  const match = /^([^*]*?)\*\*\/(.+)$/.exec(normalized);
  const matcher = match && fileMatcher(match[2]);
  if (!matcher) {
    throw new Error(
      `Unsupported manifest pattern "${pattern}". Use a plain path, ` +
        `"<prefix>/**/*.<ext>", or "<prefix>/**/<filename>".`
    );
  }
  const prefix = match[1].replace(/\/$/, "");
  const startDir = path.join(repoRoot, prefix);
  const results = [];
  walk(startDir, matcher, results);
  return results
    .map((abs) => path.relative(repoRoot, abs).replaceAll("\\", "/"))
    .sort();
}

/** A predicate over basenames, or null if the tail shape is unsupported. */
function fileMatcher(tail) {
  const byExtension = /^\*(\.[A-Za-z0-9.]+)$/.exec(tail);
  if (byExtension) {
    const ext = byExtension[1];
    return (name) => name.endsWith(ext);
  }
  if (!tail.includes("*") && !tail.includes("/")) {
    // Exact filename. Compared case-insensitively: Windows checkouts are
    // case-insensitive, and a pattern should not silently find nothing.
    const wanted = tail.toLowerCase();
    return (name) => name.toLowerCase() === wanted;
  }
  return null;
}

function walk(dir, matcher, results) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing directory: caller reports zero manifests
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), matcher, results);
    } else if (matcher(entry.name)) {
      results.push(path.join(dir, entry.name));
    }
  }
}
