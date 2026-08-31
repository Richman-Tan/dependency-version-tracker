import path from "node:path";
import {
  collectProperties,
  createMsbuildContext,
  expandProperties,
  getProjectScope,
  hasUnresolvedProperty,
  readVersionAttribute,
  readRequiredXmlDoc,
  toArray,
} from "./msbuild.js";

/**
 * Extract tracked NuGet packages from one .csproj.
 *
 * Reads every ItemGroup/PackageReference regardless of nesting or Condition.
 * The id comes from Include= or Update=. The version is resolved in MSBuild's
 * order of precedence:
 *
 *   1. VersionOverride on the reference (Central Package Management escape hatch)
 *   2. Version attribute, or a <Version> child element
 *   3. <PackageVersion> in the nearest Directory.Packages.props
 *
 * ...then `$(Property)` references are expanded against the csproj's own
 * PropertyGroups plus those in Directory.Build.props / Directory.Packages.props.
 * Names match case-insensitively.
 *
 * Returns { results, warnings, missing }. `missing` is true when the csproj
 * itself does not exist (the caller reports it, rather than the run dying).
 * Each result is { name, manifestPath, rawVersion, currentVersion, floating,
 * unresolved }: rawVersion is what a human would see in the file ("7.*" stays
 * "7.*", "$(SerilogVersion)" stays "$(SerilogVersion)"), currentVersion is the
 * resolved version or null when it cannot be pinned down. When the version came
 * from Directory.Packages.props, manifestPath points at that props file — that
 * is where the version would be changed, and it collapses one row per project
 * into a single row.
 */
export function extractNugetVersions(repoRoot, manifestPath, trackedNames, context) {
  const ctx = context ?? createMsbuildContext(repoRoot);
  const abs = path.resolve(repoRoot, manifestPath);
  const warnings = [];

  let doc;
  try {
    doc = readRequiredXmlDoc(ctx, abs, manifestPath.endsWith(".csproj") ? "csproj" : "MSBuild file");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { results: [], warnings: [`Manifest "${manifestPath}" does not exist; skipped.`], missing: true };
    }
    throw err;
  }

  const scope = getProjectScope(ctx, path.dirname(abs));
  // The project's own PropertyGroups layer over the directory scope and win.
  const properties = new Map(scope.properties);
  collectProperties(doc, properties);

  const trackedLower = new Map(trackedNames.map((n) => [n.toLowerCase(), n]));
  const results = [];

  for (const [id, refs] of groupReferencesById(doc, trackedLower)) {
    const seen = new Set();
    for (const declared of effectiveVersions(refs)) {
      // Only a reference with no version of its own falls back to the central
      // one — and a central version is evaluated in the props files' own
      // property scope, since MSBuild imports them before the project body.
      const central = declared === null ? scope.packageVersions.get(id) ?? null : null;
      const candidates = central ?? [declared];

      for (const candidate of candidates) {
        const classified = classifyVersion(candidate, central ? scope.properties : properties);
        const fromProps = central !== null && scope.packagesPropsPath !== null;
        const owner = fromProps ? scope.packagesPropsPath : manifestPath;
        // Keyed on both, so two references that agree on the version but are
        // maintained in different files each keep their row.
        const key = `${owner}|${classified.rawVersion}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          name: trackedLower.get(id),
          // A centrally managed version is owned by the props file, not the project.
          manifestPath: owner,
          ...classified,
        });
      }
    }
  }
  return { results, warnings, missing: false };
}

/**
 * The versions a package resolves to in one project, following MSBuild item
 * semantics in document order. `null` means "no version here" (fall back to a
 * central PackageVersion).
 *
 *   - `Include` declares the item; repeated Includes sit in ItemGroups with
 *     mutually exclusive Conditions, which a static read cannot evaluate, so
 *     each distinct version is kept rather than one being guessed at.
 *   - `Update` modifies an item that already exists, so one appearing BEFORE
 *     any Include matches nothing and is ignored.
 *   - An `Update` carrying no version (the common `PrivateAssets`-only form)
 *     changes other metadata and must leave the version alone.
 *   - An `Update` with a version replaces whatever the Includes declared.
 *   - With no Include at all the item comes from the SDK, and the last Update
 *     with a version wins.
 */
function effectiveVersions(refs) {
  const hasInclude = refs.some(isInclude);
  const versions = [];
  let declared = false;
  for (const ref of refs) {
    const version = readVersionAttribute(ref, "VersionOverride") ?? readVersionAttribute(ref);
    if (isInclude(ref)) {
      declared = true;
      versions.push(version);
      continue;
    }
    if (hasInclude && !declared) continue; // Update before Include: matches nothing
    if (version === null) continue; // metadata-only Update: version unchanged
    versions.length = 0;
    versions.push(version);
  }
  return versions.length > 0 ? versions : [null];
}

function isInclude(ref) {
  return ref["@_Update"] === undefined;
}

/** Tracked PackageReferences grouped by lowercased id, in document order. */
function groupReferencesById(doc, trackedLower) {
  const groups = new Map();
  for (const ref of collectPackageReferences(doc)) {
    const id = ref["@_Include"] ?? ref["@_Update"];
    if (typeof id !== "string") continue;
    const key = id.toLowerCase();
    if (!trackedLower.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ref);
  }
  return groups;
}

const NO_VERSION = { rawVersion: "(no version)", currentVersion: null, floating: false, unresolved: true };

function classifyVersion(rawVersion, properties) {
  // Padding around the version in the file is not part of the version.
  const declared = typeof rawVersion === "string" ? rawVersion.trim() : rawVersion;
  if (declared === null || declared === "") return { ...NO_VERSION };

  const expanded = expandProperties(declared, properties).trim();
  // An empty expansion (a property declared with no value) means no version,
  // not a version that happens to be blank.
  if (expanded === "") return { ...NO_VERSION };

  if (hasUnresolvedProperty(expanded)) {
    // Show the declaration verbatim so it can be traced back to its property.
    return { rawVersion: declared, currentVersion: null, floating: false, unresolved: true };
  }
  if (expanded.includes("*")) {
    return { rawVersion: expanded, currentVersion: null, floating: true, unresolved: false };
  }
  // NuGet interval notation, e.g. "[1.0,2.0)" — a range, not a pinned version.
  if (/^[[(]/.test(expanded)) {
    return { rawVersion: expanded, currentVersion: null, floating: false, unresolved: false };
  }
  return { rawVersion: expanded, currentVersion: expanded, floating: false, unresolved: false };
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
