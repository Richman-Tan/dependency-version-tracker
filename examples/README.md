# Examples

Everything here is copy-and-edit; nothing is read by the tool at runtime.

| File | Use it when |
| --- | --- |
| `caller-workflow.yml` | Always. Copy to `.github/workflows/dependency-report.yml` in the consumer repo and fill in `<org>` and the sheet ID. |
| `tracked-packages.minimal.json` | First dry run: three packages, `package.json` at the root, every csproj. |
| `tracked-packages.json` | A typical single-site repo with a `ClientApp/package.json` under `src/`. |
| `tracked-packages.multi-site.json` | One `package.json` per site under `apps/`; produces one row per (package, site). Shows a per-package `manifests` override. |
| `tracked-packages.cpm.json` | Central Package Management: versions live in `Directory.Packages.props`, so NuGet rows collapse to that file instead of one per csproj. |

Whichever config you pick, commit it as `tracked-packages.json` at the repo
root (or point the `config-path` input at it) and run once with `dry-run: true`.
Check the `Manifest` column: it shows which files the globs actually matched.
