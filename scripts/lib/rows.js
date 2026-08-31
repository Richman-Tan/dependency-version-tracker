import { classifyDrift } from "./versions.js";

export const HEADER = [
  "Ecosystem", "Package", "Manifest", "Current", "Latest", "Drift", "Checked (UTC)",
];

/** Sheet ordering: most actionable first, healthy rows last. */
export const DRIFT_ORDER = [
  "major", "minor", "patch", "floating", "range", "unresolved", "not-found",
  "lookup-failed", "unknown", "private", "up-to-date",
];

const COL = { ecosystem: 0, name: 1, manifest: 2, drift: 5 };

/** Placeholder entry for a tracked package that appears in no manifest. */
export function notFoundEntry(ecosystem, pkg) {
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

export function lookupKey(ecosystem, name) {
  return ecosystem === "npm" ? `npm:${name}` : `nuget:${name.toLowerCase()}`;
}

/** Turn one extracted entry plus its registry lookup into a sheet row. */
export function buildRow(entry, latestByKey, checkedAt) {
  const lookup = latestByKey.get(lookupKey(entry.ecosystem, entry.name)) ?? {
    error: "no lookup performed",
  };
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
    } else if (entry.unresolved) {
      drift = "unresolved";
    } else if (entry.currentVersion === null) {
      drift = "range";
    } else {
      drift = classifyDrift(entry.currentVersion, lookup.latest.replace(" (prerelease)", ""));
    }
  }
  return [entry.ecosystem, entry.name, entry.manifestPath, current, latest, drift, checkedAt];
}

/** Sort by drift severity, then ecosystem, package, and manifest path. */
export function compareRows(a, b) {
  const severity = DRIFT_ORDER.indexOf(a[COL.drift]) - DRIFT_ORDER.indexOf(b[COL.drift]);
  if (severity !== 0) return severity;
  if (a[COL.ecosystem] !== b[COL.ecosystem]) return a[COL.ecosystem] < b[COL.ecosystem] ? -1 : 1;
  const nameA = a[COL.name].toLowerCase();
  const nameB = b[COL.name].toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  if (a[COL.manifest] === b[COL.manifest]) return 0;
  return a[COL.manifest] < b[COL.manifest] ? -1 : 1;
}

/**
 * Collapse entries that describe the same cell of the report. Central Package
 * Management is the case that matters: every project in the tree resolves the
 * same package to the same Directory.Packages.props, which would otherwise be
 * one identical row per project.
 *
 * The version is part of the key, so only entries that agree on it are
 * duplicates. Two declarations of one package that disagree are exactly what
 * this tool exists to surface, and must survive as separate rows.
 */
export function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const version = entry.ecosystem === "npm" ? entry.rawRange : entry.rawVersion;
    const key = `${entry.ecosystem}|${entry.name.toLowerCase()}|${entry.manifestPath}|${version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
