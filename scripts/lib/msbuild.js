import { readFileSync } from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

/**
 * MSBuild-aware helpers shared by the NuGet manifest reader.
 *
 * Two MSBuild features decide the "current" version of a PackageReference and
 * neither lives in the csproj:
 *
 *   - Central Package Management: the csproj carries a bare
 *     `<PackageReference Include="X" />` and the version sits in
 *     `Directory.Packages.props` as `<PackageVersion Include="X" Version=".." />`.
 *   - Property indirection: `Version="$(SerilogVersion)"`, where the property
 *     is declared in a `<PropertyGroup>` in the csproj, `Directory.Build.props`,
 *     or `Directory.Packages.props`.
 *
 * Both are resolved statically here. `Condition` attributes are ignored — this
 * is a static read, not an MSBuild evaluation, so every declaration is treated
 * as active; for properties the last one wins, while conflicting package
 * versions are all reported rather than arbitrarily resolved. Only the *nearest*
 * Directory.*.props walking up from the project directory is read (matching the
 * SDK's default import), and one that fails to parse ends the walk with a
 * warning rather than falling through to an ancestor's versions.
 */

/**
 * Shared parser. `parseTagValue: false` keeps version strings as strings —
 * without it `<Version>8.0</Version>` would arrive as the number 8. Comments
 * are dropped by default, so commented-out references are never reported.
 */
export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
});

const PROPERTY_REF = /\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g;
const MAX_EXPANSION_PASSES = 5;

/**
 * Holds the parsed-document and per-directory caches for one run, so a repo
 * with 50 projects and 20 tracked packages parses each file once.
 * `warnings` accumulates props-file problems; drain it after extraction.
 */
export function createMsbuildContext(repoRoot) {
  return {
    repoRoot: path.resolve(repoRoot),
    docs: new Map(),
    scopes: new Map(),
    warnings: [],
  };
}

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

/**
 * Parse an XML file, caching the outcome. Returns { status, doc } where status
 * is "ok" | "missing" | "invalid".
 *
 * The three are kept distinct on purpose. "missing" and "invalid" both yield no
 * document, but they must not be conflated: a malformed file has to stop an
 * ancestor walk (an unreadable Directory.Packages.props must never fall through
 * to its grandparent and report that file's version), and a required file has
 * to report the reason it actually failed rather than whichever reason the
 * first probe happened to cache.
 */
export function readXmlDoc(context, absPath) {
  const cached = context.docs.get(absPath);
  if (cached !== undefined) return cached;

  let outcome;
  try {
    outcome = { status: "ok", doc: xmlParser.parse(readFileSync(absPath, "utf8")) };
  } catch (err) {
    if (MISSING_CODES.has(err.code)) {
      outcome = { status: "missing", doc: null };
    } else {
      outcome = { status: "invalid", doc: null, message: err.message };
      context.warnings.push(`Ignoring unparseable ${relative(context, absPath)}: ${err.message}`);
    }
  }
  context.docs.set(absPath, outcome);
  return outcome;
}

/**
 * Read a file the caller explicitly targeted. A missing one is reportable by
 * the caller (ENOENT); a malformed one is a hard error either way.
 */
export function readRequiredXmlDoc(context, absPath, label) {
  const outcome = readXmlDoc(context, absPath);
  if (outcome.status === "ok") return outcome.doc;
  if (outcome.status === "missing") {
    const err = new Error(`Manifest "${relative(context, absPath)}" does not exist.`);
    err.code = "ENOENT";
    throw err;
  }
  throw new Error(`Cannot parse ${label} "${relative(context, absPath)}": ${outcome.message}`);
}

function relative(context, absPath) {
  return path.relative(context.repoRoot, absPath).replaceAll("\\", "/");
}

/**
 * Resolve the MSBuild scope a project sits in: the properties visible to it and
 * the centrally managed package versions that apply. Cached per directory.
 *
 * Returns { properties, packageVersions, packagesPropsPath } — both maps keyed
 * lowercase (MSBuild identifiers are case-insensitive); packagesPropsPath is
 * the repo-relative Directory.Packages.props path, or null when there is none.
 */
export function getProjectScope(context, projectDir) {
  const dir = path.resolve(projectDir);
  if (context.scopes.has(dir)) return context.scopes.get(dir);

  const properties = new Map();
  const packageVersions = new Map();

  const buildProps = findNearest(context, dir, "Directory.Build.props");
  if (buildProps) collectProperties(buildProps.doc, properties);

  const packagesProps = findNearest(context, dir, "Directory.Packages.props");
  if (packagesProps) {
    collectProperties(packagesProps.doc, properties);
    collectPackageVersions(packagesProps.doc, packageVersions);
  }

  const scope = {
    properties,
    packageVersions,
    packagesPropsPath: packagesProps ? relative(context, packagesProps.absPath) : null,
  };
  context.scopes.set(dir, scope);
  return scope;
}

/**
 * Nearest ancestor file, from `startDir` up to and including repoRoot.
 *
 * A file that exists but does not parse ENDS the walk: it is the nearest one,
 * so falling through to its parent would report a version this project does not
 * actually use. The caller sees no props file and reports `unresolved`, which is
 * the honest answer, and the parse failure has already been warned about.
 */
function findNearest(context, startDir, fileName) {
  let dir = startDir;
  while (contains(context.repoRoot, dir)) {
    const absPath = path.join(dir, fileName);
    const { status, doc } = readXmlDoc(context, absPath);
    if (status === "ok") return { doc, absPath, dir };
    if (status === "invalid") return null;
    if (dir === context.repoRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root: repoRoot was not an ancestor
    dir = parent;
  }
  return null;
}

/** True if `dir` is repoRoot or sits underneath it. */
function contains(repoRoot, dir) {
  if (dir === repoRoot) return true;
  const rel = path.relative(repoRoot, dir);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Merge every PropertyGroup child into `into` (lowercased keys, last wins). */
export function collectProperties(doc, into) {
  for (const group of toArray(doc?.Project?.PropertyGroup)) {
    if (typeof group !== "object" || group === null) continue;
    for (const [key, value] of Object.entries(group)) {
      if (key.startsWith("@_")) continue;
      const text = scalarText(Array.isArray(value) ? value[value.length - 1] : value);
      if (text !== null) into.set(key.toLowerCase(), text);
    }
  }
}

/**
 * Merge every ItemGroup/PackageVersion into `into`, keyed by lowercased package
 * id. The value is the list of DISTINCT versions declared for that id: NuGet
 * rejects a duplicate PackageVersion outright (NU1506), so rather than picking
 * one arbitrarily the conflict is carried through and reported.
 */
export function collectPackageVersions(doc, into) {
  for (const group of toArray(doc?.Project?.ItemGroup)) {
    for (const item of toArray(group?.PackageVersion)) {
      if (typeof item !== "object" || item === null) continue;
      const id = item["@_Include"] ?? item["@_Update"];
      if (typeof id !== "string") continue;
      const version = readVersionAttribute(item);
      if (version === null) continue;
      const key = id.toLowerCase();
      const versions = into.get(key) ?? [];
      if (!versions.includes(version)) versions.push(version);
      into.set(key, versions);
    }
  }
}

/** The Version of an item: the attribute form, else the child-element form. */
export function readVersionAttribute(item, attribute = "Version") {
  const attr = scalarText(item[`@_${attribute}`]);
  if (attr !== null) return attr;
  return scalarText(item[attribute]);
}

/**
 * Substitute `$(Prop)` references until nothing more resolves. Unknown
 * properties are left verbatim so the caller can report them as unresolved.
 */
export function expandProperties(value, properties) {
  if (typeof value !== "string" || !value.includes("$(")) return value;
  let current = value;
  for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass++) {
    let replaced = false;
    const next = current.replace(PROPERTY_REF, (match, name) => {
      const found = properties.get(name.toLowerCase());
      if (found === undefined) return match;
      replaced = true;
      return found;
    });
    if (!replaced) return next;
    current = next;
    if (!current.includes("$(")) return current;
  }
  return current;
}

/**
 * True if a version string still carries an unresolved `$(...)` reference. Any
 * surviving `$(` counts, including MSBuild function syntax such as
 * `$([MSBuild]::Add(1,2))` and spaced forms like `$( Prop )` — reporting those
 * as unresolved is correct, and no real version contains the sequence.
 */
export function hasUnresolvedProperty(value) {
  return typeof value === "string" && value.includes("$(");
}

function scalarText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // A repeated child element (conditional <Version> forms) parses to an array.
  // MSBuild metadata is last-wins, and anything is better than reporting the
  // element as absent — that would silently fall through to a central version
  // the project does not use.
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const text = scalarText(value[i]);
      if (text !== null) return text;
    }
    return null;
  }
  // <Version Condition="..">1.0</Version> parses to an object with #text.
  if (typeof value === "object" && value !== null && typeof value["#text"] !== "undefined") {
    return scalarText(value["#text"]);
  }
  return null;
}

export function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
