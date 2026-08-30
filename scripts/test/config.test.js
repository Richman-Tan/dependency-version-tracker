import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function tempConfig(data) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "dvt-")), "config.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
}

test("loads the sample config with defaults applied", () => {
  const config = loadConfig(path.join(fixtures, "tracked-packages.sample.json"));
  assert.equal(config.npm.length, 3);
  assert.equal(config.nuget.length, 2);
  const react = config.npm.find((p) => p.name === "react");
  assert.deepEqual(react.manifests, ["package.sample.json"]);
  assert.equal(react.source, "public");
  assert.equal(config.npm.find((p) => p.name === "@sal/portal").source, "private");
});

test("per-package manifests override defaults", () => {
  const config = loadConfig(
    tempConfig({
      nuget: [{ name: "Npgsql", manifests: ["src/Core/Core.csproj"] }],
      defaults: { nugetManifests: ["**/*.csproj"] },
    })
  );
  assert.deepEqual(config.nuget[0].manifests, ["src/Core/Core.csproj"]);
});

test("collects all validation errors at once", () => {
  const file = tempConfig({
    bogus: true,
    npm: [{ name: "" }, { name: "ok-but-no-manifests" }, { name: "react", source: "weird" }],
    defaults: { typo: [] },
  });
  assert.throws(
    () => loadConfig(file),
    (err) => {
      assert.match(err.message, /Unknown top-level key "bogus"/);
      assert.match(err.message, /Unknown defaults key "typo"/);
      assert.match(err.message, /npm\[0\] is missing a non-empty "name"/);
      assert.match(err.message, /npm\[1\].*no manifests/);
      assert.match(err.message, /"source" must be "private"/);
      return true;
    }
  );
});

test("empty config is rejected", () => {
  assert.throws(() => loadConfig(tempConfig({})), /tracks no packages/);
});

test("invalid JSON is a clear error", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "dvt-")), "bad.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => loadConfig(file), /not valid JSON/);
});
