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
