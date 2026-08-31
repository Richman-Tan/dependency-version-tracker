import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveManifests } from "../lib/walk.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("plain paths pass through untouched", () => {
  assert.deepEqual(resolveManifests(fixtures, "package.sample.json"), ["package.sample.json"]);
});

test("**/*.csproj finds fixtures", () => {
  const found = resolveManifests(fixtures, "**/*.csproj");
  assert.deepEqual(found, ["Core.sample.csproj", "Web.sample.csproj"]);
});

test("node_modules, bin and obj are never walked", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dvt-walk-"));
  mkdirSync(path.join(root, "src", "App"), { recursive: true });
  mkdirSync(path.join(root, "src", "node_modules", "x"), { recursive: true });
  mkdirSync(path.join(root, "src", "App", "obj"), { recursive: true });
  writeFileSync(path.join(root, "src", "App", "App.csproj"), "<Project/>");
  writeFileSync(path.join(root, "src", "node_modules", "x", "x.csproj"), "<Project/>");
  writeFileSync(path.join(root, "src", "App", "obj", "gen.csproj"), "<Project/>");
  assert.deepEqual(resolveManifests(root, "src/**/*.csproj"), ["src/App/App.csproj"]);
});

test("unsupported glob shapes are rejected loudly", () => {
  assert.throws(() => resolveManifests(fixtures, "src/*/partial.csproj"), /Unsupported manifest pattern/);
});

test("missing directories yield zero manifests", () => {
  assert.deepEqual(resolveManifests(fixtures, "no-such-dir/**/*.csproj"), []);
});

test("equivalent spellings of one path normalise to a single manifest", () => {
  assert.deepEqual(resolveManifests(fixtures, "./package.sample.json"), ["package.sample.json"]);
  assert.deepEqual(resolveManifests(fixtures, "src//app/x.csproj"), ["src/app/x.csproj"]);
});

test("**/<filename> finds one manifest per site and ignores lookalikes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dvt-sites-"));
  for (const site of ["SecurityDashboard.Web", "CallerChecker.Web"]) {
    mkdirSync(path.join(root, "apps", site, "ClientApp"), { recursive: true });
    writeFileSync(path.join(root, "apps", site, "ClientApp", "package.json"), "{}");
    // Files a "*.json" glob would wrongly sweep up.
    writeFileSync(path.join(root, "apps", site, "ClientApp", "tsconfig.json"), "{}");
    writeFileSync(path.join(root, "apps", site, "ClientApp", "package-lock.json"), "{}");
  }
  assert.deepEqual(resolveManifests(root, "apps/**/package.json"), [
    "apps/CallerChecker.Web/ClientApp/package.json",
    "apps/SecurityDashboard.Web/ClientApp/package.json",
  ]);
});

test("node_modules is never walked for package.json", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dvt-nm-"));
  mkdirSync(path.join(root, "app", "node_modules", "react"), { recursive: true });
  writeFileSync(path.join(root, "app", "package.json"), "{}");
  // node_modules holds thousands of these; sweeping them in would be fatal.
  writeFileSync(path.join(root, "app", "node_modules", "react", "package.json"), "{}");
  assert.deepEqual(resolveManifests(root, "**/package.json"), ["app/package.json"]);
});

test("a bare filename glob with no prefix works from the repo root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dvt-root-"));
  mkdirSync(path.join(root, "web"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "web", "package.json"), "{}");
  assert.deepEqual(resolveManifests(root, "**/package.json"), ["package.json", "web/package.json"]);
});

test("extension globs still work alongside the filename form", () => {
  assert.deepEqual(resolveManifests(fixtures, "**/*.csproj"), [
    "Core.sample.csproj",
    "Web.sample.csproj",
  ]);
});

test("a glob with a wildcard mid-name is still rejected", () => {
  assert.throws(() => resolveManifests(fixtures, "src/**/pack*.json"), /Unsupported manifest pattern/);
});
