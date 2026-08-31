import { test } from "node:test";
import assert from "node:assert/strict";
import { formatError, formatWarning, runUrl } from "../lib/ci.js";

test("warnings use each host's annotation syntax", () => {
  assert.equal(formatWarning("x", { GITHUB_ACTIONS: "true" }), "::warning::x");
  assert.equal(formatWarning("x", { TF_BUILD: "True" }), "##vso[task.logissue type=warning]x");
  assert.equal(formatWarning("x", {}), "WARNING: x");
});

test("GitHub run URL is built from the Actions variables", () => {
  assert.equal(
    runUrl({
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "org/repo",
      GITHUB_RUN_ID: "123",
    }),
    "https://github.com/org/repo/actions/runs/123"
  );
});

test("Azure run URL encodes a project name containing spaces", () => {
  assert.equal(
    runUrl({
      SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/sandfield/",
      SYSTEM_TEAMPROJECT: "Security Dashboard",
      BUILD_BUILDID: "4821",
    }),
    "https://dev.azure.com/sandfield/Security%20Dashboard/_build/results?buildId=4821"
  );
});

test("a collection URI without a trailing slash still forms one path", () => {
  const url = runUrl({
    SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/sandfield",
    SYSTEM_TEAMPROJECT: "Proj",
    BUILD_BUILDID: "1",
  });
  assert.equal(url, "https://dev.azure.com/sandfield/Proj/_build/results?buildId=1");
  assert.ok(!url.includes("//Proj"));
});

test("GitHub wins when both hosts' variables are somehow present", () => {
  const url = runUrl({
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "org/repo",
    GITHUB_RUN_ID: "1",
    SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/x/",
    SYSTEM_TEAMPROJECT: "P",
    BUILD_BUILDID: "2",
  });
  assert.match(url, /^https:\/\/github\.com/);
});

test("no recognised CI yields no link, rather than a broken one", () => {
  assert.equal(runUrl({}), null);
  assert.equal(runUrl({ SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/x/" }), null);
  assert.equal(runUrl({ GITHUB_SERVER_URL: "https://github.com" }), null);
});

test("fatal errors use each host's annotation syntax too", () => {
  assert.equal(formatError("boom", { GITHUB_ACTIONS: "true" }), "::error::boom");
  assert.equal(formatError("boom", { TF_BUILD: "True" }), "##vso[task.logissue type=error]boom");
  assert.equal(formatError("boom", {}), "ERROR: boom");
});
