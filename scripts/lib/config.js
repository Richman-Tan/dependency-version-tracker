import { readFileSync } from "node:fs";

const PACKAGE_KEYS = new Set(["name", "manifests", "source"]);
const ROOT_KEYS = new Set(["npm", "nuget", "defaults"]);
const DEFAULT_KEYS = new Set(["npmManifests", "nugetManifests"]);

/**
 * Load and validate a tracked-packages.json config.
 *
 * Shape:
 * {
 *   "npm":   [ { "name": "react" }, { "name": "@sal/portal", "source": "private" } ],
 *   "nuget": [ { "name": "Npgsql", "manifests": ["src/Core/Core.csproj"] } ],
 *   "defaults": { "npmManifests": [...], "nugetManifests": [...] }
 * }
 *
 * Per-package `manifests` overrides the ecosystem default. Every validation
 * problem is collected and reported at once.
 */
export function loadConfig(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read config "${configPath}": ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config "${configPath}" is not valid JSON: ${err.message}`);
  }

  const errors = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`Config "${configPath}" must be a JSON object.`);
  }
  for (const key of Object.keys(data)) {
    if (!ROOT_KEYS.has(key)) errors.push(`Unknown top-level key "${key}".`);
  }
  const defaults = data.defaults ?? {};
  for (const key of Object.keys(defaults)) {
    if (!DEFAULT_KEYS.has(key)) errors.push(`Unknown defaults key "${key}".`);
  }

  const config = { npm: [], nuget: [] };
  for (const ecosystem of ["npm", "nuget"]) {
    const list = data[ecosystem] ?? [];
    if (!Array.isArray(list)) {
      errors.push(`"${ecosystem}" must be an array.`);
      continue;
    }
    const defaultManifests = defaults[`${ecosystem}Manifests`];
    list.forEach((entry, i) => {
      const label = `${ecosystem}[${i}]`;
      if (typeof entry !== "object" || entry === null) {
        errors.push(`${label} must be an object.`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!PACKAGE_KEYS.has(key)) errors.push(`${label} has unknown key "${key}".`);
      }
      if (typeof entry.name !== "string" || entry.name.trim() === "") {
        errors.push(`${label} is missing a non-empty "name".`);
        return;
      }
      if (entry.source !== undefined && entry.source !== "private") {
        errors.push(`${label} ("${entry.name}"): "source" must be "private" when present.`);
      }
      const manifests = entry.manifests ?? defaultManifests;
      if (!Array.isArray(manifests) || manifests.length === 0 || manifests.some((m) => typeof m !== "string")) {
        errors.push(
          `${label} ("${entry.name}") has no manifests and no defaults.${ecosystem}Manifests fallback.`
        );
        return;
      }
      config[ecosystem].push({
        name: entry.name.trim(),
        manifests,
        source: entry.source === "private" ? "private" : "public",
      });
    });
  }

  if (config.npm.length + config.nuget.length === 0 && errors.length === 0) {
    errors.push("Config tracks no packages — add entries under \"npm\" and/or \"nuget\".");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid config "${configPath}":\n- ${errors.join("\n- ")}`);
  }
  return config;
}
