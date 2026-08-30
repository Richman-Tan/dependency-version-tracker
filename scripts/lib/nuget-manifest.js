import { readFileSync } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Comments are dropped by default — commented-out <PackageReference> lines
  // must never be reported.
});

/**
 * Extract tracked NuGet packages from one .csproj.
 *
 * Reads every ItemGroup/PackageReference regardless of nesting or Condition.
 * The id comes from Include= or Update=; the version from the Version
 * attribute or a <Version> child element. Names match case-insensitively.
 *
 * Returns [{ name, manifestPath, rawVersion, currentVersion, floating }] —
 * rawVersion is the literal string ("7.*" stays "7.*"); currentVersion is
 * null for floating/missing versions.
 */
export function extractNugetVersions(repoRoot, manifestPath, trackedNames) {
  const abs = path.join(repoRoot, manifestPath);
  let doc;
  try {
    doc = parser.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Cannot parse csproj "${manifestPath}": ${err.message}`);
  }
  const trackedLower = new Map(trackedNames.map((n) => [n.toLowerCase(), n]));
  const results = [];

  for (const ref of collectPackageReferences(doc)) {
    const id = ref["@_Include"] ?? ref["@_Update"];
    if (typeof id !== "string") continue;
    const trackedName = trackedLower.get(id.toLowerCase());
    if (trackedName === undefined) continue;

    let version = ref["@_Version"] ?? ref.Version;
    if (version !== undefined && typeof version !== "string") version = String(version);
    const floating = typeof version === "string" && version.includes("*");
    results.push({
      name: trackedName,
      manifestPath,
      rawVersion: version ?? "(no version)",
      currentVersion: version !== undefined && !floating ? version : null,
      floating,
    });
  }
  return results;
}

function collectPackageReferences(doc) {
  const refs = [];
  const project = doc?.Project;
  if (!project) return refs;
  for (const group of toArray(project.ItemGroup)) {
    for (const ref of toArray(group?.PackageReference)) {
      if (typeof ref === "object" && ref !== null) refs.push(ref);
    }
  }
  return refs;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
