import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRow,
  compareRows,
  dedupeEntries,
  DRIFT_ORDER,
  notFoundEntry,
  lookupKey,
} from "../lib/rows.js";

const CHECKED = "2026-09-01 06:00";
const DRIFT = 5;

function row(entry, lookups = {}) {
  const latestByKey = new Map(Object.entries(lookups));
  return buildRow({ ecosystem: "nuget", name: "Pkg", manifestPath: "a.csproj", ...entry }, latestByKey, CHECKED);
}

function nuget(entry, lookup) {
  return row(entry, { "nuget:pkg": lookup });
}

test("a behind version is classified by its highest differing part", () => {
  assert.equal(nuget({ rawVersion: "1.2.3", currentVersion: "1.2.3" }, { latest: "2.0.0" })[DRIFT], "major");
  assert.equal(nuget({ rawVersion: "1.2.3", currentVersion: "1.2.3" }, { latest: "1.3.0" })[DRIFT], "minor");
  assert.equal(nuget({ rawVersion: "1.2.3", currentVersion: "1.2.3" }, { latest: "1.2.4" })[DRIFT], "patch");
  assert.equal(nuget({ rawVersion: "1.2.3", currentVersion: "1.2.3" }, { latest: "1.2.3" })[DRIFT], "up-to-date");
});

test("the row carries ecosystem, package, manifest, current, latest and timestamp", () => {
  const built = nuget({ rawVersion: "1.2.3", currentVersion: "1.2.3" }, { latest: "2.0.0" });
  assert.deepEqual(built, ["nuget", "Pkg", "a.csproj", "1.2.3", "2.0.0", "major", CHECKED]);
});

test("npm rows show the declared range, not the reduced version", () => {
  const built = row(
    { ecosystem: "npm", name: "react", rawRange: "^19.2.0", currentVersion: "19.2.0" },
    { "npm:react": { latest: "19.2.8" } }
  );
  assert.equal(built[3], "^19.2.0");
  assert.equal(built[DRIFT], "patch");
});

test("a prerelease latest is compared on its version, and shown with its label", () => {
  const built = nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { latest: "2.0.0-beta.1 (prerelease)" });
  assert.equal(built[4], "2.0.0-beta.1 (prerelease)");
  assert.equal(built[DRIFT], "major");
});

test("floating, unresolved and range each keep their own drift", () => {
  const latest = { latest: "9.0.0" };
  assert.equal(nuget({ rawVersion: "7.*", currentVersion: null, floating: true }, latest)[DRIFT], "floating");
  assert.equal(
    nuget({ rawVersion: "$(Ver)", currentVersion: null, unresolved: true }, latest)[DRIFT],
    "unresolved"
  );
  assert.equal(nuget({ rawVersion: "[1,2)", currentVersion: null }, latest)[DRIFT], "range");
});

test("floating wins over unresolved when a package is somehow both", () => {
  const built = nuget(
    { rawVersion: "7.*", currentVersion: null, floating: true, unresolved: true },
    { latest: "9.0.0" }
  );
  assert.equal(built[DRIFT], "floating");
});

test("a private package is reported without a latest lookup", () => {
  const built = nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { private: true });
  assert.equal(built[4], "n/a (private)");
  assert.equal(built[DRIFT], "private");
});

test("a registry failure degrades to lookup-failed rather than dropping the row", () => {
  const built = nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { error: "timeout" });
  assert.equal(built[DRIFT], "lookup-failed");
  assert.equal(built[4], "n/a");
});

test("a missing lookup is lookup-failed, never a silent pass", () => {
  assert.equal(row({ rawVersion: "1.0.0", currentVersion: "1.0.0" })[DRIFT], "lookup-failed");
});

test("a tracked package found in no manifest is not-found and outranks the lookup", () => {
  const entry = { ...notFoundEntry("nuget", { name: "Ghost", source: "public" }), ecosystem: "nuget" };
  const built = buildRow(entry, new Map([["nuget:ghost", { latest: "1.0.0" }]]), CHECKED);
  assert.equal(built[DRIFT], "not-found");
  assert.equal(built[2], "—");
});

test("an unparseable current version is unknown, not a false up-to-date", () => {
  assert.equal(nuget({ rawVersion: "latest", currentVersion: "latest" }, { latest: "9.0.0" })[DRIFT], "unknown");
});

test("lookup keys fold NuGet case but keep npm case", () => {
  assert.equal(lookupKey("nuget", "Serilog.AspNetCore"), "nuget:serilog.aspnetcore");
  assert.equal(lookupKey("npm", "@sal/Portal"), "npm:@sal/Portal");
});

test("every drift a row can carry has a defined sort position", () => {
  const produced = [
    nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { latest: "2.0.0" })[DRIFT],
    nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { latest: "1.1.0" })[DRIFT],
    nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { latest: "1.0.1" })[DRIFT],
    nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { latest: "1.0.0" })[DRIFT],
    nuget({ rawVersion: "7.*", currentVersion: null, floating: true }, { latest: "9.0.0" })[DRIFT],
    nuget({ rawVersion: "$(V)", currentVersion: null, unresolved: true }, { latest: "9.0.0" })[DRIFT],
    nuget({ rawVersion: "[1,2)", currentVersion: null }, { latest: "9.0.0" })[DRIFT],
    nuget({ rawVersion: "x", currentVersion: "x" }, { latest: "9.0.0" })[DRIFT],
    nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { private: true })[DRIFT],
    nuget({ rawVersion: "1.0.0", currentVersion: "1.0.0" }, { error: "boom" })[DRIFT],
    buildRow({ ...notFoundEntry("npm", { name: "g" }), ecosystem: "npm" }, new Map(), CHECKED)[DRIFT],
  ];
  for (const drift of produced) {
    assert.ok(DRIFT_ORDER.includes(drift), `"${drift}" is missing from DRIFT_ORDER`);
  }
});

test("rows sort by severity, then ecosystem, package, and manifest", () => {
  const rows = [
    ["nuget", "Zeta", "z.csproj", "1", "2", "up-to-date", CHECKED],
    ["nuget", "Alpha", "b.csproj", "1", "2", "minor", CHECKED],
    ["npm", "beta", "p.json", "1", "2", "major", CHECKED],
    ["nuget", "Alpha", "a.csproj", "1", "2", "minor", CHECKED],
    ["nuget", "alpha", "c.csproj", "1", "2", "major", CHECKED],
  ];
  assert.deepEqual(
    [...rows].sort(compareRows).map((r) => `${r[5]}/${r[0]}/${r[1]}/${r[2]}`),
    [
      "major/npm/beta/p.json",
      "major/nuget/alpha/c.csproj",
      "minor/nuget/Alpha/a.csproj",
      "minor/nuget/Alpha/b.csproj",
      "up-to-date/nuget/Zeta/z.csproj",
    ]
  );
});

test("sorting is a total order, so identical rows never swap between runs", () => {
  const a = ["nuget", "Pkg", "a.csproj", "1", "2", "minor", CHECKED];
  assert.equal(compareRows(a, [...a]), 0);
});

test("identical entries from different projects collapse to one row", () => {
  // Central Package Management: every project resolves to the same props file.
  const entries = ["src/A/A.csproj", "src/B/B.csproj", "src/C/C.csproj"].map(() => ({
    ecosystem: "nuget",
    name: "Serilog",
    manifestPath: "Directory.Packages.props",
    rawVersion: "8.0.0",
  }));
  assert.equal(dedupeEntries(entries).length, 1);
});

test("entries that disagree on the version are never collapsed", () => {
  const entries = [
    { ecosystem: "nuget", name: "Serilog", manifestPath: "a.csproj", rawVersion: "2.10.0" },
    { ecosystem: "nuget", name: "Serilog", manifestPath: "a.csproj", rawVersion: "4.0.0" },
  ];
  assert.deepEqual(dedupeEntries(entries).map((e) => e.rawVersion), ["2.10.0", "4.0.0"]);
});

test("the same package in different manifests stays as separate rows", () => {
  const entries = [
    { ecosystem: "nuget", name: "Serilog", manifestPath: "a.csproj", rawVersion: "8.0.0" },
    { ecosystem: "nuget", name: "Serilog", manifestPath: "b.csproj", rawVersion: "8.0.0" },
  ];
  assert.equal(dedupeEntries(entries).length, 2);
});

test("npm entries dedupe on their declared range", () => {
  const entries = [
    { ecosystem: "npm", name: "react", manifestPath: "package.json", rawRange: "^19.0.0" },
    { ecosystem: "npm", name: "react", manifestPath: "package.json", rawRange: "^19.0.0" },
    { ecosystem: "npm", name: "react", manifestPath: "package.json", rawRange: "^18.0.0" },
  ];
  assert.deepEqual(dedupeEntries(entries).map((e) => e.rawRange), ["^19.0.0", "^18.0.0"]);
});

test("npm and nuget packages of the same name do not collide", () => {
  const entries = [
    { ecosystem: "npm", name: "serilog", manifestPath: "m", rawRange: "1.0.0" },
    { ecosystem: "nuget", name: "Serilog", manifestPath: "m", rawVersion: "1.0.0" },
  ];
  assert.equal(dedupeEntries(entries).length, 2);
});
