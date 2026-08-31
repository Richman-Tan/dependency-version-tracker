import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractNugetVersions } from "../lib/nuget-manifest.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const WEB = "Web.sample.csproj";
const CORE = "Core.sample.csproj";

function extract(names, manifest = WEB) {
  return extractNugetVersions(fixtures, manifest, names).results;
}

test("reads Version attribute", () => {
  const results = extract(["Sandfield.Portal"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].currentVersion, "7.13.0");
  assert.equal(results[0].floating, false);
});

test("floating versions are flagged, not resolved", () => {
  const results = extract(["Sandfield.WebAPI"]);
  assert.equal(results[0].rawVersion, "7.*");
  assert.equal(results[0].currentVersion, null);
  assert.equal(results[0].floating, true);
});

test("commented-out PackageReference is never reported", () => {
  const results = extract(["Sandfield.WebRequest"]);
  assert.equal(results.length, 0);
});

test("4-part versions survive as strings", () => {
  const results = extract(["AWSSDK.BedrockAgentRuntime"]);
  assert.equal(results[0].currentVersion, "4.0.8.8");
});

test("Version attribute wins even with PrivateAssets children", () => {
  const results = extract(["GitVersion.MsBuild"]);
  assert.equal(results[0].currentVersion, "6.5.1");
});

test("<Version> child element form is read", () => {
  const results = extract(["ChildVersionPackage"]);
  assert.equal(results[0].currentVersion, "3.2.1");
});

test("Update= references and conditional ItemGroups are included", () => {
  assert.equal(extract(["UpdatedPackage"])[0].currentVersion, "1.0.0");
  assert.equal(extract(["Serilog.AspNetCore"])[0].currentVersion, "10.0.0");
});

test("missing version reports placeholder", () => {
  const results = extract(["NoVersionPackage"]);
  assert.equal(results[0].rawVersion, "(no version)");
  assert.equal(results[0].currentVersion, null);
});

test("name matching is case-insensitive, display name preserved", () => {
  const results = extract(["sandfield.portal"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "sandfield.portal");
});

test("same package differs across csproj files", () => {
  assert.equal(extract(["GitVersion.MsBuild"], WEB)[0].currentVersion, "6.5.1");
  assert.equal(extract(["GitVersion.MsBuild"], CORE)[0].currentVersion, "6.7.0");
});

test("single-reference ItemGroup (object, not array) is handled", () => {
  // Core.sample.csproj has exactly one ItemGroup with one PackageReference.
  const results = extract(["GitVersion.MsBuild"], CORE);
  assert.equal(results.length, 1);
});
