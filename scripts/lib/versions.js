/**
 * Version parsing and drift classification.
 *
 * Handles both npm semver (1.2.3, 1.2.3-beta.1) and NuGet versions, which may
 * have four numeric parts (4.0.8.8). Deliberately not the `semver` package —
 * it rejects four-part versions.
 */

/**
 * Parse a version string into { parts: number[], prerelease: string|null }.
 * Returns null if the string is not a plain (optionally prerelease) version.
 */
export function parseVersion(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  const match = /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!match) return null;
  return {
    parts: match[1].split(".").map(Number),
    prerelease: match[2] ?? null,
  };
}

function comparePrerelease(a, b) {
  // SemVer: a release (null prerelease) sorts above any prerelease.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1; // fewer segments sorts first
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn) {
      return -1; // numeric segments sort below alphanumeric
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two parsed versions. Negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a, b) {
  const len = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return x - y;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Compare two version strings; returns null if either fails to parse. */
export function compareVersionStrings(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  return compareVersions(pa, pb);
}

/**
 * Strip a simple range prefix from an npm range (^1.2.3, ~1.2.3, >=1.2.3, =1.2.3).
 * Returns { version, exact } where version is null when the range can't be
 * reduced to a single base version (e.g. "*", ">=1 <2", "latest").
 */
export function stripRangePrefix(range) {
  if (typeof range !== "string") return { version: null, exact: false };
  const trimmed = range.trim();
  const match = /^(\^|~|>=|=)?\s*(v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(trimmed);
  if (!match) return { version: null, exact: false };
  return { version: match[2], exact: !match[1] || match[1] === "=" };
}

/**
 * Classify how far `current` is behind `latest`.
 * Returns "up-to-date" | "patch" | "minor" | "major" | "unknown".
 * A difference only in the 4th (revision) part classifies as "patch".
 * A current version *ahead* of latest reports "up-to-date".
 */
export function classifyDrift(current, latest) {
  const pc = parseVersion(current);
  const pl = parseVersion(latest);
  if (!pc || !pl) return "unknown";
  if (compareVersions(pc, pl) >= 0) return "up-to-date";
  if ((pl.parts[0] ?? 0) !== (pc.parts[0] ?? 0)) return "major";
  if ((pl.parts[1] ?? 0) !== (pc.parts[1] ?? 0)) return "minor";
  return "patch";
}
