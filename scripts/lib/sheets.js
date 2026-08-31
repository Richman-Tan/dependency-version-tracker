import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/**
 * Overwrite a sheet tab with the given rows (array of arrays, header first).
 * Auth is a Google service account: the JSON key (client_email + private_key)
 * is used to self-sign an RS256 JWT and exchange it for an access token — no
 * googleapis dependency. The tab is cleared first so shrinking row counts
 * never leave stale rows behind.
 */
export async function writeSheet({ serviceAccountKey, sheetId, sheetTab, rows, fetchImpl = fetch }) {
  const token = await getAccessToken(serviceAccountKey, fetchImpl);
  const range = encodeURIComponent(`${quoteTab(sheetTab)}!A:Z`);

  const clearRes = await fetchImpl(`${SHEETS_BASE}/${sheetId}/values/${range}:clear`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!clearRes.ok) throw new Error(`Sheets clear failed: ${clearRes.status} ${await clearRes.text()}`);

  const startRange = encodeURIComponent(`${quoteTab(sheetTab)}!A1`);
  const updateRes = await fetchImpl(
    `${SHEETS_BASE}/${sheetId}/values/${startRange}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    }
  );
  if (!updateRes.ok) throw new Error(`Sheets update failed: ${updateRes.status} ${await updateRes.text()}`);
}

async function getAccessToken(serviceAccountKey, fetchImpl) {
  const { client_email: email, private_key: privateKey } = serviceAccountKey;
  if (!email || !privateKey) {
    throw new Error("Service account key must contain client_email and private_key.");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(privateKey).toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body.access_token) throw new Error("Google token exchange returned no access_token.");
  return body.access_token;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Quote a tab name for A1 notation. Unquoted names break as soon as they
 * contain a space ("My Deps!A:Z" is a parse error), so always quote and double
 * any embedded single quotes.
 */
export function quoteTab(sheetTab) {
  return `'${String(sheetTab).replaceAll("'", "''")}'`;
}
