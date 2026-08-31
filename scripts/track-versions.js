#!/usr/bin/env node
/**
 * Extract curated npm/NuGet package versions from a repo, look up latest
 * versions, and sync a Google Sheet (or print a table with --dry-run).
 *
 * Usage:
 *   node track-versions.js --config tracked-packages.json --repo-root . \
 *     [--sheet-id <id> --sheet-tab Dependencies] [--dry-run] [--summary-file <path>]
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  service-account JSON (required unless --dry-run)
 *   PRIVATE_NPM_REGISTRY_URL / PRIVATE_NPM_TOKEN      optional private npm feed
 *   PRIVATE_NUGET_INDEX_URL / PRIVATE_NUGET_TOKEN     optional private NuGet feed
 *
 * Exits non-zero only for config/manifest errors; individual registry
 * failures become "lookup-failed" rows and warnings.
 */
import { appendFileSync } from "node:fs";
import { loadConfig } from "./lib/config.js";
import { createMsbuildContext } from "./lib/msbuild.js";
import { extractNpmVersions } from "./lib/npm-manifest.js";
import { extractNugetVersions } from "./lib/nuget-manifest.js";
import { lookupNpmLatest } from "./lib/registry-npm.js";
import { lookupNugetLatest } from "./lib/registry-nuget.js";
import {
  buildRow,
  compareRows,
  dedupeEntries,
  HEADER,
  lookupKey,
  notFoundEntry,
} from "./lib/rows.js";
import { writeSheet } from "./lib/sheets.js";
import { resolveManifests } from "./lib/walk.js";

const LOOKUP_CONCURRENCY = 8;

main().catch((err) => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const warnings = [];

  const entries = extractAll(config, args.repoRoot, warnings);
  const latestByKey = await lookupLatestVersions(config, warnings);
  const checkedAt = new Date().toISOString().replace("T", " ").slice(0, 16);
  const rows = entries
    .map((e) => buildRow(e, latestByKey, checkedAt))
    .sort(compareRows);

  for (const warning of warnings) emitWarning(warning);

  const table = [HEADER, ...rows];
  printConsoleTable(table);
  if (args.summaryFile) {
    appendFileSync(args.summaryFile, markdownTable(table) + "\n");
  }

  if (args.dryRun) {
    console.log("\nDry run — sheet not updated.");
    return;
  }
  if (!args.sheetId) throw new Error("--sheet-id is required unless --dry-run is set.");
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var is required unless --dry-run is set.");
  let serviceAccountKey;
  try {
    serviceAccountKey = JSON.parse(keyJson);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.");
  }

  const footer = [`Last run: ${checkedAt} UTC${runUrl() ? ` (${runUrl()})` : ""}`];
  await writeSheet({
    serviceAccountKey,
    sheetId: args.sheetId,
    sheetTab: args.sheetTab,
    rows: [...table, [], footer],
  });
  console.log(`\nSheet updated: ${rows.length} package rows written to tab "${args.sheetTab}".`);
}

function parseArgs(argv) {
  const args = {
    config: "tracked-packages.json",
    repoRoot: ".",
    sheetId: null,
    sheetTab: "Dependencies",
    dryRun: false,
    summaryFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--config": args.config = argv[++i]; break;
      case "--repo-root": args.repoRoot = argv[++i]; break;
      case "--sheet-id": args.sheetId = argv[++i]; break;
      case "--sheet-tab": args.sheetTab = argv[++i]; break;
      case "--summary-file": args.summaryFile = argv[++i]; break;
      case "--dry-run": args.dryRun = true; break;
      default: throw new Error(`Unknown argument "${argv[i]}".`);
    }
  }
  return args;
}

/** Flatten config into one entry per (package, manifest) occurrence. */
function extractAll(config, repoRoot, warnings) {
  const msbuild = createMsbuildContext(repoRoot);
  const entries = [
    ...extractEcosystem("npm", config.npm, repoRoot, warnings, (manifestPath, names) =>
      extractNpmVersions(repoRoot, manifestPath, names)
    ),
    ...extractEcosystem("nuget", config.nuget, repoRoot, warnings, (manifestPath, names) =>
      extractNugetVersions(repoRoot, manifestPath, names, msbuild)
    ),
  ];
  warnings.push(...msbuild.warnings);
  return dedupeEntries(entries);
}

/**
 * Extract one ecosystem, parsing each manifest exactly once for the union of
 * the names that target it — a repo with 50 projects and 20 tracked packages
 * would otherwise re-parse every csproj 20 times.
 */
function extractEcosystem(ecosystem, packages, repoRoot, warnings, extract) {
  const manifestsPerPackage = new Map();
  const namesPerManifest = new Map();
  for (const pkg of packages) {
    const resolved = new Set();
    for (const pattern of pkg.manifests) {
      for (const manifestPath of resolveManifests(repoRoot, pattern)) resolved.add(manifestPath);
    }
    manifestsPerPackage.set(pkg, resolved);
    for (const manifestPath of resolved) {
      if (!namesPerManifest.has(manifestPath)) namesPerManifest.set(manifestPath, new Set());
      namesPerManifest.get(manifestPath).add(pkg.name);
    }
  }

  const resultsPerManifest = new Map();
  for (const [manifestPath, names] of namesPerManifest) {
    const { results, warnings: extractWarnings } = extract(manifestPath, [...names]);
    warnings.push(...extractWarnings);
    const byName = new Map();
    for (const result of results) {
      if (!byName.has(result.name)) byName.set(result.name, []);
      byName.get(result.name).push(result);
    }
    resultsPerManifest.set(manifestPath, byName);
  }

  const entries = [];
  for (const pkg of packages) {
    const found = [];
    for (const manifestPath of manifestsPerPackage.get(pkg)) {
      const results = resultsPerManifest.get(manifestPath)?.get(pkg.name) ?? [];
      found.push(...results.map((r) => ({ ...r, ecosystem, source: pkg.source })));
    }
    entries.push(...(found.length > 0 ? found : [notFoundEntry(ecosystem, pkg)]));
  }
  return entries;
}


/** One latest-version lookup per distinct (ecosystem, name), capped concurrency. */
async function lookupLatestVersions(config, warnings) {
  const tasks = [];
  const seen = new Set();
  for (const [ecosystem, lookup] of [["npm", npmLookup], ["nuget", nugetLookup]]) {
    for (const pkg of config[ecosystem]) {
      const key = lookupKey(ecosystem, pkg.name);
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ key, run: () => lookup(pkg) });
    }
  }

  const results = new Map();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOOKUP_CONCURRENCY, tasks.length) }, async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        const outcome = await task.run();
        if (outcome?.error) warnings.push(outcome.error);
        results.set(task.key, outcome);
      }
    })
  );
  return results;
}

function npmLookup(pkg) {
  if (pkg.source === "private") {
    const registryUrl = process.env.PRIVATE_NPM_REGISTRY_URL;
    if (!registryUrl) return { private: true };
    return lookupNpmLatest(pkg.name, { registryUrl, token: process.env.PRIVATE_NPM_TOKEN });
  }
  return lookupNpmLatest(pkg.name);
}

function nugetLookup(pkg) {
  if (pkg.source === "private") {
    const serviceIndexUrl = process.env.PRIVATE_NUGET_INDEX_URL;
    if (!serviceIndexUrl) return { private: true };
    return lookupNugetLatest(pkg.name, { serviceIndexUrl, token: process.env.PRIVATE_NUGET_TOKEN });
  }
  return lookupNugetLatest(pkg.name);
}

function emitWarning(message) {
  console.warn(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`);
}

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function printConsoleTable(table) {
  const widths = table[0].map((_, col) => Math.max(...table.map((row) => String(row[col] ?? "").length)));
  for (const row of table) {
    console.log(row.map((cell, col) => String(cell ?? "").padEnd(widths[col])).join("  "));
  }
}

function markdownTable(table) {
  const [header, ...body] = table;
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.map((c) => String(c ?? "")).join(" | ")} |`),
  ];
  return lines.join("\n");
}
