import { readFileSync } from "node:fs";
import path from "node:path";
import { stripRangePrefix } from "./versions.js";

/**
 * Extract tracked npm packages from one package.json.
 *
 * Only `dependencies` and `devDependencies` are consulted; non-standard blocks
 * (e.g. a parked `dependencies-disabled`) and `overrides` are ignored. If a
 * package appears in both, `dependencies` wins and a warning is emitted.
 *
 * Returns { results, warnings } where each result is
 * { name, manifestPath, rawRange, currentVersion } — currentVersion is null
 * when the range can't be reduced to a base version (drift "range").
 */
export function extractNpmVersions(repoRoot, manifestPath, trackedNames) {
  const abs = path.join(repoRoot, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Cannot parse npm manifest "${manifestPath}": ${err.message}`);
  }
  const deps = manifest.dependencies ?? {};
  const devDeps = manifest.devDependencies ?? {};
  const results = [];
  const warnings = [];

  for (const name of trackedNames) {
    let rawRange = deps[name];
    if (rawRange !== undefined && devDeps[name] !== undefined) {
      warnings.push(
        `${manifestPath}: "${name}" is in both dependencies and devDependencies; using dependencies.`
      );
    }
    if (rawRange === undefined) rawRange = devDeps[name];
    if (rawRange === undefined) continue;

    results.push({
      name,
      manifestPath,
      rawRange,
      currentVersion: resolveRange(rawRange, deps, devDeps),
    });
  }
  return { results, warnings };
}

function resolveRange(rawRange, deps, devDeps) {
  let range = rawRange;
  // "$other-package" alias (npm overrides style): re-resolve against declared deps.
  if (typeof range === "string" && range.startsWith("$")) {
    const target = range.slice(1);
    range = deps[target] ?? devDeps[target];
    if (range === undefined) return null;
  }
  // "npm:actual-package@^1.2.3" alias: take the range after the last "@".
  if (typeof range === "string" && range.startsWith("npm:")) {
    const at = range.lastIndexOf("@");
    if (at <= "npm:".length) return null;
    range = range.slice(at + 1);
  }
  return stripRangePrefix(range).version;
}
