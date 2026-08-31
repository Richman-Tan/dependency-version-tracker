import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractNpmVersions } from "../lib/npm-manifest.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MANIFEST = "package.sample.json";

function extract(names) {
  return extractNpmVersions(fixtures, MANIFEST, names);
}

test("reads dependencies and devDependencies with range stripping", () => {
  const { results } = extract(["react", "typescript", "pinned-exact", "dayjs"]);
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName.react.currentVersion, "19.2.0");
  assert.equal(byName.react.rawRange, "^19.2.0");
  assert.equal(byName.typescript.currentVersion, "5.9.3");
  assert.equal(byName["pinned-exact"].currentVersion, "2.5.0");
  assert.equal(byName.dayjs.currentVersion, "1.11.19");
});

test("dependencies wins over devDependencies with a warning", () => {
  const { results, warnings } = extract(["dayjs"]);
  assert.equal(results[0].rawRange, "~1.11.19");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /both dependencies and devDependencies/);
});

test("npm: alias resolves to the aliased range", () => {
  const { results } = extract(["aliased-package"]);
  assert.equal(results[0].currentVersion, "4.1.0");
});

test("unresolvable ranges yield null currentVersion", () => {
  const { results } = extract(["wildcard-package"]);
  assert.equal(results[0].currentVersion, null);
  assert.equal(results[0].rawRange, "*");
});

test("prerelease ranges are preserved", () => {
  const { results } = extract(["@sal/authentication.react"]);
  assert.equal(results[0].currentVersion, "3.0.0-beta.1");
});

test("non-standard blocks are ignored", () => {
  const { results } = extract(["react-dayjs", "react-datepicker", "react-router"]);
  assert.equal(results.length, 0);
});

test("missing package returns no result", () => {
  const { results } = extract(["not-a-real-package"]);
  assert.equal(results.length, 0);
});

test("a missing manifest warns and is skipped, rather than aborting the run", () => {
  const { results, warnings, missing } = extractNpmVersions(fixtures, "client/package.json", ["react"]);
  assert.deepEqual(results, []);
  assert.equal(missing, true);
  assert.match(warnings[0], /does not exist/);
});

test("a malformed manifest is still a hard error", () => {
  assert.throws(
    () => extractNpmVersions(fixtures, "Web.sample.csproj", ["react"]),
    /Cannot parse npm manifest/
  );
});
