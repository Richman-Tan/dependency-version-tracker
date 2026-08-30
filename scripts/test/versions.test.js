import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  compareVersionStrings,
  stripRangePrefix,
  classifyDrift,
} from "../lib/versions.js";

test("parseVersion handles 1-4 part versions and prereleases", () => {
  assert.deepEqual(parseVersion("1.2.3"), { parts: [1, 2, 3], prerelease: null });
  assert.deepEqual(parseVersion("4.0.8.8"), { parts: [4, 0, 8, 8], prerelease: null });
  assert.deepEqual(parseVersion("10"), { parts: [10], prerelease: null });
  assert.deepEqual(parseVersion("3.0.0-beta.1"), { parts: [3, 0, 0], prerelease: "beta.1" });
  assert.deepEqual(parseVersion("v1.2.3"), { parts: [1, 2, 3], prerelease: null });
  assert.equal(parseVersion("7.*"), null);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(">=1 <2"), null);
});

test("compareVersionStrings orders numerically, not lexically", () => {
  assert.ok(compareVersionStrings("10.0.0", "9.9.9") > 0);
  assert.ok(compareVersionStrings("4.0.8.8", "4.0.8.10") < 0);
  assert.equal(compareVersionStrings("1.2.0", "1.2"), 0);
});

test("prerelease sorts below release, ordered per semver", () => {
  assert.ok(compareVersionStrings("3.0.0-beta.1", "3.0.0") < 0);
  assert.ok(compareVersionStrings("3.0.0-beta.2", "3.0.0-beta.1") > 0);
  assert.ok(compareVersionStrings("3.0.0-alpha", "3.0.0-beta") < 0);
  assert.ok(compareVersionStrings("3.0.0-beta.2", "3.0.0-beta.11") < 0);
  assert.ok(compareVersionStrings("3.0.0-1", "3.0.0-alpha") < 0);
});

test("stripRangePrefix reduces simple ranges", () => {
  assert.equal(stripRangePrefix("^19.2.0").version, "19.2.0");
  assert.equal(stripRangePrefix("~1.11.19").version, "1.11.19");
  assert.equal(stripRangePrefix(">=5.0.0").version, "5.0.0");
  assert.equal(stripRangePrefix("2.5.0").version, "2.5.0");
  assert.equal(stripRangePrefix("^3.0.0-beta.1").version, "3.0.0-beta.1");
  assert.equal(stripRangePrefix("*").version, null);
  assert.equal(stripRangePrefix(">=1 <2").version, null);
  assert.equal(stripRangePrefix("latest").version, null);
});

test("classifyDrift buckets by highest differing part", () => {
  assert.equal(classifyDrift("19.2.0", "19.2.0"), "up-to-date");
  assert.equal(classifyDrift("19.2.0", "19.2.5"), "patch");
  assert.equal(classifyDrift("19.2.0", "19.3.0"), "minor");
  assert.equal(classifyDrift("19.2.0", "21.0.0"), "major");
  assert.equal(classifyDrift("4.0.8.8", "4.0.8.10"), "patch");
  assert.equal(classifyDrift("20.0.0", "19.0.0"), "up-to-date");
  assert.equal(classifyDrift("7.*", "8.0.0"), "unknown");
});
