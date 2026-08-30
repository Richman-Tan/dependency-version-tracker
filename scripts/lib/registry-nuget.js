import { parseVersion, compareVersions } from "./versions.js";

const PUBLIC_FLAT_CONTAINER = "https://api.nuget.org/v3-flatcontainer";
const TIMEOUT_MS = 10_000;

/**
 * Look up the latest version of a NuGet package via the V3 flat-container.
 *
 * Prereleases are excluded unless every published version is a prerelease, in
 * which case the max prerelease is returned flagged `(prerelease)`. Private
 * feeds pass `serviceIndexUrl` (a V3 index.json) and optionally `token`; the
 * PackageBaseAddress resource is resolved from the index.
 *
 * Returns { latest } or { error }.
 */
export async function lookupNugetLatest(name, { serviceIndexUrl, token, fetchImpl = fetch } = {}) {
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Basic ${Buffer.from(`.:${token}`).toString("base64")}`;
  }
  try {
    let flatContainer = PUBLIC_FLAT_CONTAINER;
    if (serviceIndexUrl) {
      flatContainer = await resolveFlatContainer(serviceIndexUrl, headers, fetchImpl);
    }
    const url = `${flatContainer.replace(/\/$/, "")}/${name.toLowerCase()}/index.json`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { error: `NuGet feed returned ${res.status} for ${name}` };
    const body = await res.json();
    const versions = Array.isArray(body?.versions) ? body.versions : [];
    if (versions.length === 0) return { error: `no versions listed for ${name}` };

    const stable = maxVersion(versions.filter((v) => !v.includes("-")));
    if (stable) return { latest: stable };
    const prerelease = maxVersion(versions);
    if (prerelease) return { latest: `${prerelease} (prerelease)` };
    return { error: `no parseable versions for ${name}` };
  } catch (err) {
    return { error: `NuGet lookup failed for ${name}: ${err.message}` };
  }
}

async function resolveFlatContainer(serviceIndexUrl, headers, fetchImpl) {
  const res = await fetchImpl(serviceIndexUrl, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`service index returned ${res.status}`);
  const index = await res.json();
  const resource = (index?.resources ?? []).find((r) =>
    typeof r?.["@type"] === "string" && r["@type"].startsWith("PackageBaseAddress/3.0.0")
  );
  if (!resource?.["@id"]) throw new Error("service index has no PackageBaseAddress resource");
  return resource["@id"];
}

function maxVersion(versions) {
  let best = null;
  let bestParsed = null;
  for (const v of versions) {
    const parsed = parseVersion(v);
    if (!parsed) continue;
    if (bestParsed === null || compareVersions(parsed, bestParsed) > 0) {
      best = v;
      bestParsed = parsed;
    }
  }
  return best;
}
