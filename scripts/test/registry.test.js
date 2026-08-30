import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupNpmLatest } from "../lib/registry-npm.js";
import { lookupNugetLatest } from "../lib/registry-nuget.js";

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [prefix, response] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        if (response instanceof Error) throw response;
        return {
          ok: response.status === undefined || response.status < 400,
          status: response.status ?? 200,
          json: async () => response.body,
          text: async () => JSON.stringify(response.body),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
  impl.calls = calls;
  return impl;
}

test("npm lookup reads dist-tags.latest and encodes scoped names", async () => {
  const fetchImpl = fakeFetch({
    "https://registry.npmjs.org/@sal%2Fportal": { body: { "dist-tags": { latest: "7.5.0" } } },
  });
  const result = await lookupNpmLatest("@sal/portal", { fetchImpl });
  assert.deepEqual(result, { latest: "7.5.0" });
});

test("npm lookup surfaces HTTP errors as error results", async () => {
  const result = await lookupNpmLatest("ghost-package", { fetchImpl: fakeFetch({}) });
  assert.match(result.error, /404/);
});

test("npm private lookup uses registry URL and basic auth", async () => {
  const fetchImpl = fakeFetch({
    "https://feed.example/npm/registry/@sal%2Fportal": { body: { "dist-tags": { latest: "7.4.2" } } },
  });
  const result = await lookupNpmLatest("@sal/portal", {
    registryUrl: "https://feed.example/npm/registry/",
    token: "pat123",
    fetchImpl,
  });
  assert.deepEqual(result, { latest: "7.4.2" });
  assert.match(fetchImpl.calls[0].options.headers.Authorization, /^Basic /);
});

test("nuget lookup picks max stable version", async () => {
  const fetchImpl = fakeFetch({
    "https://api.nuget.org/v3-flatcontainer/npgsql/index.json": {
      body: { versions: ["9.0.0", "10.0.0-rc.1", "10.0.0", "10.0.2", "2.0.0"] },
    },
  });
  const result = await lookupNugetLatest("Npgsql", { fetchImpl });
  assert.deepEqual(result, { latest: "10.0.2" });
});

test("nuget lookup falls back to prerelease when nothing stable exists", async () => {
  const fetchImpl = fakeFetch({
    "https://api.nuget.org/v3-flatcontainer/beta.only/index.json": {
      body: { versions: ["1.0.0-beta.1", "1.0.0-beta.2"] },
    },
  });
  const result = await lookupNugetLatest("Beta.Only", { fetchImpl });
  assert.deepEqual(result, { latest: "1.0.0-beta.2 (prerelease)" });
});

test("nuget private lookup resolves flat container from service index", async () => {
  const fetchImpl = fakeFetch({
    "https://feed.example/nuget/v3/index.json": {
      body: {
        resources: [
          { "@id": "https://feed.example/nuget/v3/flat2/", "@type": "PackageBaseAddress/3.0.0" },
        ],
      },
    },
    "https://feed.example/nuget/v3/flat2/sandfield.portal/index.json": {
      body: { versions: ["7.13.0", "7.14.0"] },
    },
  });
  const result = await lookupNugetLatest("Sandfield.Portal", {
    serviceIndexUrl: "https://feed.example/nuget/v3/index.json",
    token: "pat123",
    fetchImpl,
  });
  assert.deepEqual(result, { latest: "7.14.0" });
});

test("network failures become error results, not throws", async () => {
  const fetchImpl = fakeFetch({ "https://api.nuget.org": new Error("socket hang up") });
  const result = await lookupNugetLatest("Anything", { fetchImpl });
  assert.match(result.error, /socket hang up/);
});
