# dependency-version-tracker

A reusable GitHub Actions workflow that reads a **curated list** of npm and NuGet
packages from a repo, compares each against the latest published version, and
overwrites a live table in a **Google Sheet**. The sheet is sorted worst-first,
so the top of it is the work queue.

```
Ecosystem  Package             Manifest                          Current   Latest   Drift
nuget      GitVersion.MsBuild  src/App.Core/App.Core.csproj      6.7.0     6.8.2    minor
nuget      GitVersion.MsBuild  src/App.Web/App.Web.csproj        6.5.1     6.8.2    minor
nuget      Serilog.AspNetCore  Directory.Packages.props          8.0.1     10.0.0   major
npm        react               src/App.Web/ClientApp/package.json ^19.2.0  19.2.8   patch
npm        @sal/portal         src/App.Web/ClientApp/package.json ^7.4.2   n/a (private)  private
```

## How it works

- The consumer repo commits a `tracked-packages.json` and a ~20-line caller
  workflow (cron + manual dispatch).
- The caller invokes the reusable workflow here, which checks out the consumer
  repo, checks out this repo's scripts (at the same ref the caller pinned),
  and runs `scripts/track-versions.js`.
- The script parses manifests statically (real XML parsing — commented-out
  `<PackageReference>` lines are never reported), resolves centrally managed
  versions and `$(Property)` references the way MSBuild would, queries
  registry.npmjs.org / api.nuget.org, and rewrites one sheet tab. The same
  table is written to the job's step summary.
- No `googleapis`, no `semver` — one dependency (`fast-xml-parser`), Google
  auth via a self-signed service-account JWT, and a version comparator that
  accepts NuGet 4-part versions (`4.0.8.8`).

## Putting it on a repo

Do these in order. Steps 1–3 need no credentials and write nothing.

### 1. Add the config

- Copy [`examples/tracked-packages.minimal.json`](examples/tracked-packages.minimal.json)
  into the consumer repo root as `tracked-packages.json`. The other configs in
  [`examples/`](examples/README.md) cover single-site, multi-site and Central
  Package Management layouts.
- Edit the package names to ones the repo actually uses, and set the manifest
  paths to match its layout (see the [schema](#tracked-packagesjson-schema)).

### 2. Add the workflow

- Copy [`examples/caller-workflow.yml`](examples/caller-workflow.yml) into the
  consumer repo as `.github/workflows/dependency-report.yml`.
- Replace `<org>` with the GitHub org/user hosting this repo. Leave the sheet
  ID placeholder for now.
- Commit both files and push to the default branch. The workflow only appears
  in the Actions tab once it is on the default branch.

### 3. Dry run

- Actions tab → **Dependency version report** → **Run workflow** → tick
  **dry-run** → run.
- Open the job summary. You should see the table. **Check the `Manifest`
  column first**: it lists the files the globs matched. A package showing
  `not-found` means the name or the manifest path is wrong.
- Fix the config and re-run until the table looks right.

### 4. Google setup (once per org)

- In Google Cloud, create a project and enable the **Google Sheets API**.
- Create a **service account** with no roles, then create a **JSON key** and
  download it.

### 5. Create the sheet

- Create a spreadsheet and add a tab named `Dependencies` (or your own name,
  passed as `sheet-tab`).
- **Share the sheet with the service account's `client_email` as Editor.**
  Skipping this produces a 403 later rather than a clear error.
- Copy the spreadsheet ID from the URL — the long string between `/d/` and
  `/edit`.

### 6. Go live

- In the consumer repo, add a secret named `GOOGLE_SERVICE_ACCOUNT_KEY`
  containing the entire JSON key file.
- Put the spreadsheet ID into `dependency-report.yml` and push.
- Run the workflow again with dry-run off. The tab should now hold the table
  with a `Last run` footer.

### 7. Leave it running

The workflow runs on the cron in the caller file (weekdays, ~06:00 NZ time by
default). Each run clears and rewrites the tab, so stale rows never linger;
other tabs in the spreadsheet are untouched.

Packages on a private feed should be marked `"source": "private"` in the
config. They show as `private` drift until the variables and tokens in
[Private feeds](#private-feeds) are added.

## `tracked-packages.json` schema

```json
{
  "npm": [
    { "name": "react" },
    { "name": "@sal/portal", "source": "private" }
  ],
  "nuget": [
    { "name": "Npgsql", "manifests": ["src/App.Core/App.Core.csproj"] }
  ],
  "defaults": {
    "npmManifests": ["src/App.Web/ClientApp/package.json"],
    "nugetManifests": ["src/**/*.csproj"]
  }
}
```

- `manifests` (optional, per package) overrides the ecosystem default. Plain
  paths, `<prefix>/**/*.<ext>` globs, or `<prefix>/**/<filename>` globs;
  `node_modules`, `bin`, `obj`, `dist` are never walked.
- `source: "private"` marks packages on a private feed. By default their
  latest-version lookup is skipped (`n/a (private)`); see
  [Private feeds](#private-feeds) to enable it.
- NuGet names match case-insensitively. One sheet row per (package, csproj)
  pair, so version drift across projects is visible.
- Unknown keys are rejected, and every problem in the file is reported at once.

Worked configs for a single-site repo, a multi-site repo and a Central Package
Management repo are in [`examples/`](examples/README.md).

### Repos with several sites

A repo with one `package.json` per site is the common case, and
`apps/**/package.json` handles it — one row per (package, site), with the
`Manifest` column naming which site each row belongs to:

```
npm  @mui/material  apps/CallerChecker.Web/ClientApp/package.json      ^6.1.0   9.4.0  major
npm  @mui/material  apps/SecurityDashboard.Web/ClientApp/package.json  ^5.15.0  9.4.0  major
```

Prefer the `**/package.json` form over `**/*.json`: the latter also matches
`tsconfig.json`, `package-lock.json` and every other JSON file in the tree.
Because the tracked list is curated, adding a site adds rows only for packages
already being tracked — nothing else leaks in.

## Central Package Management and MSBuild properties

Where a NuGet version actually lives varies, so the version on a
`<PackageReference>` is resolved the way MSBuild would:

1. `VersionOverride` on the reference,
2. its `Version` attribute or `<Version>` child,
3. `<PackageVersion>` in the nearest `Directory.Packages.props`.

`$(SomeVersion)` references are then expanded against the `<PropertyGroup>`s in
the csproj itself, `Directory.Build.props`, and `Directory.Packages.props` — the
csproj wins, and names are matched case-insensitively. Only the *nearest*
`Directory.*.props` walking up from the project (stopping at the repo root) is
read, matching the SDK's default import. One that exists but fails to parse ends
the walk with a warning: it is the file that governs this project, so falling
through to its parent would report a version the project doesn't use.

Under Central Package Management the version has one home, so the row is
attributed to `Directory.Packages.props` and the twenty projects that share it
collapse into a single row. A reference whose version genuinely can't be pinned
down reports `unresolved` rather than a misleading version.

`Condition` attributes are ignored — this is a static read, not an MSBuild
evaluation — so declarations that a real build would treat as mutually exclusive
are all considered. Where that leaves genuine ambiguity the tool reports it
rather than guessing:

- A package `Include`d twice with **different** versions gets a row each, so the
  disagreement is visible. Identical duplicates collapse.
- Duplicate `<PackageVersion>` entries for one package likewise get a row each
  (NuGet itself rejects this with NU1506).
- Everything else follows MSBuild item semantics in document order: `Update`
  modifies an item declared earlier by `Include`, so an `Update` *before* any
  `Include` matches nothing and is ignored; a metadata-only `Update` (the common
  `PrivateAssets` form) leaves the version alone; an `Update` carrying a version
  replaces what the `Include`s declared; and with no `Include` at all the last
  `Update` with a version wins. Repeated `<Version>` child elements are metadata,
  so the last one wins.

Because MSBuild imports `Directory.Packages.props` *before* the project body, a
`$(Property)` inside a `<PackageVersion>` is expanded without the csproj's own
properties in scope — resolving it against them would produce a version no build
would ever generate.

## Workflow inputs and secrets

| Input | Default | Purpose |
| --- | --- | --- |
| `sheet-id` | *(required)* | Spreadsheet ID from the sheet URL |
| `sheet-tab` | `Dependencies` | Tab to overwrite each run |
| `config-path` | `tracked-packages.json` | Config location in the consumer repo |
| `tracker-repo` / `tracker-ref` | derived from the pinned workflow ref | Override where scripts come from |
| `node-version` | `22` | Node used to run the scripts |
| `dry-run` | `false` | Print the table, skip the sheet write |

| Secret | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | yes | Full service-account JSON key |
| `TOOLING_REPO_TOKEN` | if this repo is private | Read access for the scripts checkout |
| `PRIVATE_NPM_TOKEN` / `PRIVATE_NUGET_TOKEN` | no | Enable private-feed lookups |

## Drift legend

| Drift | Meaning |
| --- | --- |
| `major` / `minor` / `patch` | Latest differs in that part (4th-part NuGet revisions count as `patch`) |
| `up-to-date` | Current ≥ latest |
| `floating` | NuGet wildcard like `7.*` — static parse can't resolve it; latest is still shown |
| `range` | Range too complex to reduce — npm `*` / `>=1 <2`, or NuGet interval `[1.0,2.0)` — shown verbatim |
| `unresolved` | NuGet reference with no version anywhere, or a `$(Property)` that doesn't resolve |
| `private` | Private-source package, lookup skipped |
| `not-found` | Tracked name absent from every manifest (typo in the config?) |
| `lookup-failed` | Registry error/timeout — run still succeeds, warning emitted |
| `unknown` | Current version present but unparseable (e.g. `latest`) — never silently treated as up-to-date |

Rows are sorted worst-first in that order, so the top of the sheet is the work
queue. A manifest path that doesn't exist warns and drops those rows rather
than failing the run; malformed JSON/XML in a manifest is still a hard error.

Two things that look like bugs but are not: a row attributed to
`Directory.Packages.props` is Central Package Management collapsing correctly,
and the same package appearing twice means two projects genuinely disagree.

## Private feeds

To resolve latest versions from Azure Artifacts (or any private feed), set repo
**variables** `PRIVATE_NPM_REGISTRY_URL` (npm registry URL) and/or
`PRIVATE_NUGET_INDEX_URL` (NuGet V3 `index.json`), and pass the matching
`PRIVATE_NPM_TOKEN` / `PRIVATE_NUGET_TOKEN` secrets (an Azure DevOps PAT with
Packaging → Read). Keep the NuGet URL on **V3** — V2 feeds silently return
nothing for some APIs.

## Caveats

- **This repo must stay public**, or every consumer needs a
  `TOOLING_REPO_TOKEN` secret to check out the scripts.
- **Private feeds are untested.** Azure Artifacts lookups are implemented and
  documented but no private feed has been pointed at yet.
- **The sheet only works if someone reads it.** Nothing here opens PRs or
  otherwise acts on drift; it is a report.
- The tool is proven against public fixtures, not your layouts. Run the first
  pass on a real repo with `dry-run: true` and read the `Manifest` column
  before trusting the numbers.

## Local development

```bash
cd scripts
npm ci
npm test                       # node --test, no network needed
node track-versions.js --config ../examples/tracked-packages.json \
  --repo-root /path/to/consumer-repo --dry-run
```

A live sheet write locally: set `GOOGLE_SERVICE_ACCOUNT_KEY` to the key JSON
and pass `--sheet-id <id>` without `--dry-run`.

## Versioning

Consumers pin `@v1`. Non-breaking changes move the `v1` tag forward; breaking
input/schema changes get a `v2` tag. The scripts checkout automatically follows
the ref the caller pinned, so workflow and scripts never skew.
