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
import { extractNpmVersions } from "./lib/npm-manifest.js";
import { extractNugetVersions } from "./lib/nuget-manifest.js";
import { lookupNpmLatest } from "./lib/registry-npm.js";
import { lookupNugetLatest } from "./lib/registry-nuget.js";
import { classifyDrift } from "./lib/versions.js";
import { writeSheet } from "./lib/sheets.js";
import { resolveManifests } from "./lib/walk.js";

const DRIFT_ORDER = [
  "major", "minor", "patch", "floating", "range", "not-found",
  "lookup-failed", "unknown", "private", "up-to-date",
];
const HEADER = ["Ecosystem", "Package", "Manifest", "Current", "Latest", "Drift", "Checked (UTC)"];
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
  const entries = [];

  for (const pkg of config.npm) {
    const found = [];
    for (const pattern of pkg.manifests) {
      for (const manifestPath of resolveManifests(repoRoot, pattern)) {
        const { results, warnings: w } = extractNpmVersions(repoRoot, manifestPath, [pkg.name]);
        warnings.push(...w);
        found.push(...results.map((r) => ({ ...r, ecosystem: "npm", source: pkg.source })));
      }
    }
    entries.push(...(found.length > 0 ? found : [notFound("npm", pkg)]));
  }

  for (const pkg of config.nuget) {
    const found = [];
    for (const pattern of pkg.manifests) {
      for (const manifestPath of resolveManifests(repoRoot, pattern)) {
        const results = extractNugetVersions(repoRoot, manifestPath, [pkg.name]);
        found.push(...results.map((r) => ({ ...r, ecosystem: "nuget", source: pkg.source })));
      }
    }
    entries.push(...(found.length > 0 ? found : [notFound("nuget", pkg)]));
  }
  return entries;
}

function notFound(ecosystem, pkg) {
  return {
    ecosystem,
    source: pkg.source,
    name: pkg.name,
    manifestPath: "—",
    rawRange: "—",
    rawVersion: "—",
    currentVersion: null,
    notFound: true,
  };
}

/** One latest-version lookup per distinct (ecosystem, name), capped concurrency. */
async function lookupLatestVersions(config, warnings) {
  const tasks = [];
  const seen = new Set();
  for (const pkg of config.npm) {
    if (!seen.has(`npm:${pkg.name}`)) {
      seen.add(`npm:${pkg.name}`);
      tasks.push({ key: `npm:${pkg.name}`, run: () => npmLookup(pkg) });
    }
  }
  for (const pkg of config.nuget) {
    const key = `nuget:${pkg.name.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      tasks.push({ key, run: () => nugetLookup(pkg) });
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

function buildRow(entry, latestByKey, checkedAt) {
  const key = entry.ecosystem === "npm" ? `npm:${entry.name}` : `nuget:${entry.name.toLowerCase()}`;
  const lookup = latestByKey.get(key) ?? { error: "no lookup performed" };
  const current = entry.ecosystem === "npm" ? entry.rawRange : entry.rawVersion;

  let latest = "n/a";
  let drift;
  if (entry.notFound) {
    drift = "not-found";
  } else if (lookup.private) {
    latest = "n/a (private)";
    drift = "private";
  } else if (lookup.error) {
    drift = "lookup-failed";
  } else {
    latest = lookup.latest;
    if (entry.floating) {
      drift = "floating";
    } else if (entry.currentVersion === null) {
      drift = "range";
    } else {
      drift = classifyDrift(entry.currentVersion, lookup.latest.replace(" (prerelease)", ""));
    }
  }
  return [entry.ecosystem, entry.name, entry.manifestPath, current, latest, drift, checkedAt];
}

function compareRows(a, b) {
  const severity = DRIFT_ORDER.indexOf(a[5]) - DRIFT_ORDER.indexOf(b[5]);
  if (severity !== 0) return severity;
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1].toLowerCase() < b[1].toLowerCase() ? -1 : 1;
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
