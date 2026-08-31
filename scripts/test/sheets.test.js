import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { writeSheet, quoteTab } from "../lib/sheets.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const KEY = {
  client_email: "tracker@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
};

/** Records every call and answers the token, clear, and update endpoints. */
function recordingFetch({ tokenStatus = 200, clearStatus = 200, updateStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options, range: decodeURIComponent(url.split("/values/")[1] ?? "") });
    const reply = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return reply(tokenStatus, tokenStatus < 400 ? { access_token: "test-token" } : { error: "nope" });
    }
    if (url.endsWith(":clear")) return reply(clearStatus, {});
    return reply(updateStatus, {});
  };
  impl.calls = calls;
  return impl;
}

const baseArgs = { serviceAccountKey: KEY, sheetId: "SHEET1", rows: [["Package"], ["react"]] };

test("clears the tab, then writes from A1 with the bearer token", async () => {
  const fetchImpl = recordingFetch();
  await writeSheet({ ...baseArgs, sheetTab: "Dependencies", fetchImpl });

  const [token, clear, update] = fetchImpl.calls;
  assert.equal(token.url, "https://oauth2.googleapis.com/token");

  assert.equal(clear.options.method, "POST");
  assert.match(clear.url, /\/spreadsheets\/SHEET1\/values\//);
  assert.equal(clear.range, "'Dependencies'!A:Z:clear");
  assert.equal(clear.options.headers.Authorization, "Bearer test-token");

  assert.equal(update.options.method, "PUT");
  assert.equal(update.range, "'Dependencies'!A1?valueInputOption=RAW");
  assert.equal(update.options.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(update.options.body), { values: baseArgs.rows });
});

test("a tab name with spaces is quoted, so the range still parses", async () => {
  const fetchImpl = recordingFetch();
  await writeSheet({ ...baseArgs, sheetTab: "Dep Versions", fetchImpl });
  assert.equal(fetchImpl.calls[1].range, "'Dep Versions'!A:Z:clear");
  assert.equal(fetchImpl.calls[2].range, "'Dep Versions'!A1?valueInputOption=RAW");
});

test("an apostrophe in the tab name is escaped by doubling", () => {
  assert.equal(quoteTab("Rich's Deps"), "'Rich''s Deps'");
});

test("the signed assertion is a verifiable RS256 JWT for the sheets scope", async () => {
  const fetchImpl = recordingFetch();
  await writeSheet({ ...baseArgs, sheetTab: "Dependencies", fetchImpl });

  const body = new URLSearchParams(fetchImpl.calls[0].options.body);
  assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = body.get("assertion").split(".");

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  const parsed = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(parsed.iss, KEY.client_email);
  assert.equal(parsed.scope, "https://www.googleapis.com/auth/spreadsheets");
  assert.equal(parsed.aud, "https://oauth2.googleapis.com/token");
  assert.equal(parsed.exp - parsed.iat, 3600);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
});

test("a key missing client_email or private_key fails before any request", async () => {
  const fetchImpl = recordingFetch();
  await assert.rejects(
    writeSheet({ ...baseArgs, serviceAccountKey: { client_email: "a@b.c" }, sheetTab: "D", fetchImpl }),
    /client_email and private_key/
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("a failed token exchange surfaces the status", async () => {
  await assert.rejects(
    writeSheet({ ...baseArgs, sheetTab: "D", fetchImpl: recordingFetch({ tokenStatus: 401 }) }),
    /Google token exchange failed: 401/
  );
});

test("a failed clear aborts before the write", async () => {
  const fetchImpl = recordingFetch({ clearStatus: 403 });
  await assert.rejects(
    writeSheet({ ...baseArgs, sheetTab: "D", fetchImpl }),
    /Sheets clear failed: 403/
  );
  assert.equal(fetchImpl.calls.length, 2); // token, clear — no update
});

test("a failed update surfaces the status", async () => {
  await assert.rejects(
    writeSheet({ ...baseArgs, sheetTab: "D", fetchImpl: recordingFetch({ updateStatus: 500 }) }),
    /Sheets update failed: 500/
  );
});
