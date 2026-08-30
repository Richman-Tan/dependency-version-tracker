const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;

/**
 * Look up the latest published version of an npm package.
 *
 * Public packages read dist-tags from registry.npmjs.org. Private packages
 * need `registryUrl` (and usually `token` — Azure Artifacts accepts a PAT as
 * basic-auth password) and read dist-tags from the packument.
 *
 * Returns { latest } or { error }.
 */
export async function lookupNpmLatest(name, { registryUrl, token, fetchImpl = fetch } = {}) {
  const encoded = name.replace("/", "%2F");
  const base = (registryUrl ?? PUBLIC_REGISTRY).replace(/\/$/, "");
  const url = `${base}/${encoded}`;
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Basic ${Buffer.from(`.:${token}`).toString("base64")}`;
  }
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `npm registry returned ${res.status} for ${name}` };
    const body = await res.json();
    const latest = body?.["dist-tags"]?.latest;
    if (typeof latest !== "string") return { error: `no dist-tags.latest for ${name}` };
    return { latest };
  } catch (err) {
    return { error: `npm lookup failed for ${name}: ${err.message}` };
  }
}
