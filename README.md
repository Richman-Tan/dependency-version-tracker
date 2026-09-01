# dependency-version-tracker

A reusable GitHub Actions workflow that reads a **curated list** of npm and NuGet
packages from a repo, compares each against the latest published version, and
overwrites a live table in a **Google Sheet** — plus **Dependabot** config for
automated upgrade PRs (automerge patch, review minor, report major).

New here? [ROLLOUT.md](ROLLOUT.md) has the status, the decisions behind it, and
a step-by-step for putting this on a repo.

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

## Consumer quick start

1. **Google (once per org)**
   - Create a GCP project → enable the **Google Sheets API**.
   - Create a **service account** (no roles needed) → create a **JSON key**.
   - Create the spreadsheet, note the ID from its URL, add a tab named
     `Dependencies` (or your own name), and **share the sheet with the service
     account's `client_email` as Editor**.
2. **Per consumer repo**
   - Add the secret `GOOGLE_SERVICE_ACCOUNT_KEY` (paste the entire JSON key).
   - Commit `tracked-packages.json` at the repo root
     (see [`examples/tracked-packages.json`](examples/tracked-packages.json)).
   - Commit [`examples/caller-workflow.yml`](examples/caller-workflow.yml) as
     `.github/workflows/dependency-report.yml`, filling in `<org>` and the
     sheet ID.
   - Run it once from the Actions tab with **dry-run: true**, check the step
     summary, then run live.

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

## Private feeds

To resolve latest versions from Azure Artifacts (or any private feed), set repo
**variables** `PRIVATE_NPM_REGISTRY_URL` (npm registry URL) and/or
`PRIVATE_NUGET_INDEX_URL` (NuGet V3 `index.json`), and pass the matching
`PRIVATE_NPM_TOKEN` / `PRIVATE_NUGET_TOKEN` secrets (an Azure DevOps PAT with
Packaging → Read). Keep the NuGet URL on **V3** — V2 feeds silently return
nothing for some APIs.

## Dependabot (automated upgrade PRs)

Dependabot is built into GitHub — nothing to install, no third-party app with
write access to your repos.

1. Copy [`examples/dependabot.yml`](examples/dependabot.yml) to
   `.github/dependabot.yml`, adjusting `directories` to the repo's layout.
   The `directories` key (plural) takes globs, so `"/apps/*/ClientApp"` covers
   every site without listing them.

   **If the repo already has a `.github/dependabot.yml`, merge into it — do
   not overwrite.** A repo can only have one, and an existing file usually
   carries private-feed `registries`, pattern-based `groups`, and PR limits
   that took someone real effort. Take three things from the example: the
   `ignore` block for majors (the policy), `directories` globs if the repo has
   several sites, and an `npm` entry if only `nuget` is configured. Leave
   everything else alone.
2. Copy [`examples/dependabot-automerge.yml`](examples/dependabot-automerge.yml)
   to `.github/workflows/`. Dependabot has no native automerge, so patch
   updates are merged by a small workflow using the GitHub CLI — this is the
   approach [GitHub's own docs](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions)
   prescribe.
3. Enable **Allow auto-merge** in Settings → General, and require your CI
   checks on the default branch. Without required checks a patch PR merges the
   moment the workflow runs, tests or no tests.

| Update | Behaviour |
| --- | --- |
| patch | automerged once required checks pass |
| minor | PR opened, labelled `needs-review` |
| major | **no PR** — reported in the sheet as `major` drift |

### Why majors are reported rather than PR'd

This is the one place Dependabot cannot express the intended policy.
Renovate holds major upgrades on a Dependency Dashboard until someone ticks a
box; Dependabot has no equivalent — majors either open PRs unprompted or are
ignored. Unprompted major PRs are how a repo accumulates stale branches nobody
wants to be the one to merge.

So majors are ignored in `dependabot.yml` and surface in the sheet instead,
where `major` sorts to the top. **The sheet is the dependency dashboard** —
which is what it was for in the first place. Drop the `ignore` block if you
would rather triage majors as PRs.

Why not AI for any of this? Extraction, comparison, and upgrade PRs are
deterministic; scripts plus Dependabot are cheaper, reproducible, and
debuggable. A future nice-to-have: a bot that summarises release notes on
major-drift rows.

### Renovate (alternative)

[`default.json`](default.json) is a Renovate preset expressing the same policy,
including the major-behind-approval rule that Dependabot cannot. It needs the
[Mend Renovate app](https://github.com/apps/renovate) or self-hosting. Kept for
teams that want the dashboard behaviour; see
[`examples/consumer-renovate.json`](examples/consumer-renovate.json).

**Do not run both.** They will open competing PRs for the same upgrades on
separate branches, and Dependabot ignores the Renovate preset entirely.

## Rolling this out

See [ROLLOUT.md](ROLLOUT.md) — what is proven, the decisions behind it, and a
step-by-step for putting it on a repo.

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
