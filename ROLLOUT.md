# Dependency version tracker — status and rollout

**Status:** working and verified end to end. Not yet applied to a Sandfield repo.
**Version:** consumers pin `v1`, which moves forward with each release · 118 unit tests
**Repo:** https://github.com/Richman-Tan/dependency-version-tracker

This document covers both what was built and how to put it on a repo. Read
part 1 for context and decisions; part 2 is the practical checklist.

---

## 1. What this is

Three things, deliberately separate:

| Piece | What it does |
| --- | --- |
| **Reporting** | A reusable GitHub Actions workflow reads a curated list of npm and NuGet packages out of a repo, looks up the latest published version of each, and overwrites a tab in a Google Sheet with the drift. |
| **The sheet** | One row per (package, manifest). Sorted worst-first, so the top of the sheet is the work queue. |
| **Upgrade PRs** | Dependabot config plus a small workflow: patch automerges, minor waits for review, major is reported rather than PR'd. |

The reporting half answers *"what are we behind on?"*. The Dependabot half
acts on it. They are independent — you can adopt either without the other.

### What is proven, and how

Nothing below is inferred from configuration; each was observed running.

| Claim | Evidence |
| --- | --- |
| Extracts npm + NuGet versions from real projects | Run against `dotnet/eShop` — 28 projects, Central Package Management, 69 central `PackageVersion` entries |
| Resolves centrally managed versions and `$(Property)` indirection | `Aspire.Hosting.PostgreSQL` → `$(AspireVersion)` → `13.5.3`; `Duende.IdentityServer` → the literal `7.3.2`, not the stale `$(DuendeVersion)` = `7.3.1` |
| A version pinned in a csproj overrides the central one | `Grpc.Net.Client` `2.67.0` from `ClientApp.csproj` |
| Shows per-project drift | `Microsoft.Maui.Controls` `9.0.30` reported once per csproj |
| Writes the sheet | 13 rows written, then read back from the Sheets API rather than trusted from the job log |
| Catches config typos | A tracked package present in no manifest reports `not-found` |
| patch → automerged | `dotenv` `17.4.0` → `17.4.2`, merged by `github-actions`, **0 human reviews** |
| minor → held for review | PR labelled `needs-review`, not merged |
| Only Dependabot can trigger automerge | A manually-triggered run **skipped** on the actor guard |

### What is not proven

- **It has never run on a Sandfield repo.** Every test used public fixtures.
  The remaining unknowns are all in your repo layouts.
- **Automerge has never run with required status checks.** The test repo had
  no CI, so the patch PR merged instantly. See the risk in part 3.
- **Private feeds are untested.** Azure Artifacts lookups are implemented and
  documented but no private feed has been pointed at.

---

## 2. Decisions, and why

### No AI in the pipeline

Extraction, version comparison and upgrade PRs are deterministic problems.
A script plus Dependabot is cheaper, reproducible and debuggable; an LLM in
this loop would add cost and non-determinism for nothing. The one place AI
could earn its place later is summarising release notes on a major-drift row,
which is a genuinely fuzzy task.

### Dependabot rather than Renovate

The tool was originally designed around a Renovate preset. It moved to
Dependabot for one decisive reason: **the target repos already run Dependabot.**
A repo can have one dependency bot, not two — running both produces competing
PRs for the same upgrades on separate branches. Adopting Renovate would have
meant migrating every existing repo's config or living with duplicates.

Dependabot is also first-party: nothing to install, and no third-party app with
write access to Sandfield repos. That last point is worth a conscious decision
rather than a default, given what these repos are.

The Renovate preset (`default.json`) is kept as a documented alternative for
anyone who wants the behaviour described next, but **do not run both.**

### Majors are reported, not PR'd

This is the one place Dependabot cannot express the intended policy, so it is
worth understanding rather than discovering.

Renovate can hold a major upgrade on a Dependency Dashboard until someone ticks
a box. Dependabot has no equivalent: majors either open PRs unprompted, or are
ignored. Unprompted major PRs are how a repo accumulates stale branches nobody
wants to be the one to merge.

So `dependabot.yml` ignores majors, and they surface in the sheet as `major`
drift, which sorts to the top. **The sheet is the dependency dashboard** —
which is what it was for in the first place.

Change this by deleting the `ignore` block if you would rather triage majors
as PRs. It is a policy choice, not a technical constraint.

---

## 3. Rolling it out on a repo

Do these in order. Steps 1–2 need no credentials and change nothing.

### Step 1 — Config, and a dry run

Commit a `tracked-packages.json` at the repo root naming only the packages you
care about:

```json
{
  "npm":   [{ "name": "@mui/material" }, { "name": "react" }, { "name": "typescript" }],
  "nuget": [{ "name": "Sandfield.Portal", "source": "private" }],
  "defaults": {
    "npmManifests":   ["**/package.json"],
    "nugetManifests": ["src/**/*.csproj"]
  }
}
```

Copy `examples/caller-workflow.yml` to `.github/workflows/dependency-report.yml`,
then run it from the Actions tab with **dry-run: true**. This needs no secrets
and writes nothing — it prints the table to the job summary.

**Check the `Manifest` column before going further.** It tells you which files
the globs actually matched. Wrong paths here are the most likely failure, and
this is the cheapest place to find them.

Prefer `**/package.json` over `**/*.json` — the latter also matches
`tsconfig.json`, `package-lock.json` and everything else. For a repo with one
site per folder, `apps/**/package.json` gives one row per (package, site).

### Step 2 — Read the drift values

| Value | Meaning |
| --- | --- |
| `major` / `minor` / `patch` | Behind by that much |
| `up-to-date` | Current ≥ latest |
| `unresolved` | Version could not be determined — usually an unresolvable `$(Property)` |
| `not-found` | Tracked name is in no manifest — probably a typo in your config |
| `range` / `floating` | Range too loose to pin (`*`, `[1.0,2.0)`, `7.*`) |
| `private` | Private-feed package, lookup skipped |
| `lookup-failed` | Registry error; the run still succeeds |

Two things that look like bugs but are not: a row attributed to
`Directory.Packages.props` is Central Package Management collapsing correctly,
and the same package appearing twice means two projects genuinely disagree.

### Step 3 — Live sheet

1. Create the sheet, add a tab named `Dependencies`.
2. Share it with the service account's `client_email` as **Editor**. Skipping
   this produces a confusing 403 rather than a clear error.
3. Add repo secret `GOOGLE_SERVICE_ACCOUNT_KEY` (the whole JSON key) and
   variable `DEPENDENCY_SHEET_ID`.
4. Re-run with dry-run off.

The tab is cleared and rewritten each run, so stale rows never linger. Other
tabs in the same spreadsheet are untouched.

### Step 4 — Dependabot

**If the repo already has `.github/dependabot.yml`, merge into it — do not
overwrite.** Existing files usually carry private-feed `registries`,
pattern-based `groups` and PR limits that took someone real effort, and a repo
can only have one. Take three things from `examples/dependabot.yml`:

- the `ignore` block for majors (the policy),
- `directories` globs if the repo has several sites,
- an `npm` entry if only `nuget` is configured.

Then copy `examples/dependabot-automerge.yml` into `.github/workflows/` and
enable **Allow auto-merge** in Settings → General.

---

## 4. Risks to sign off before going live

**Automerge without required status checks merges untested code.** Patch PRs
merge the moment the workflow runs. Branch protection requiring your CI on the
default branch is what makes this safe; without it, automerge is a liability
rather than a convenience. This is the item to decide deliberately.

**Grouping patch with minor silently disables automerge.** `fetch-metadata`
reports the *highest* update type in a grouped PR, so a patch bundled with a
minor reads as `minor` and never matches the automerge condition — a workflow
that looks correct and does nothing. Keep `npm-patch` and `npm-minor` as
separate groups.

**This repo must stay public**, or every consumer needs a `TOOLING_REPO_TOKEN`
secret to check out the scripts.

**Majors will not appear as PRs.** By design — see part 2. If nobody reads the
sheet, nobody will notice major drift. The report only works if someone looks
at it.

---

## 5. A note on how this was verified

Two adversarial review passes and one live testing session found **17 defects**
in code that looked correct: 13 in the version-resolution engine, 2 in the
automerge workflow, 1 Dependabot grouping flaw, and 1 broken test fixture.

Nearly all were invisible to schema validation and code review. Several would
have reported a specific, plausible, **wrong** version rather than failing
loudly — the worst outcome for a tool whose entire job is telling you what
version you are on.

The lesson worth carrying into the pilot: run it on one real repo with
`dry-run: true` and read the `Manifest` column carefully before trusting any of
it. The tool is proven against public fixtures, not against your layouts.
