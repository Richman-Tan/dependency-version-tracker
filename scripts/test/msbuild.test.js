import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createMsbuildContext } from "../lib/msbuild.js";
import { extractNugetVersions } from "../lib/nuget-manifest.js";

/** Write a throwaway repo tree and return its root. */
function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "dvt-msbuild-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function project(body) {
  return `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>${body}</ItemGroup></Project>`;
}

function extract(root, names, manifest = "src/App/App.csproj", context) {
  return extractNugetVersions(root, manifest, names, context);
}

function only(root, name, manifest, context) {
  const { results } = extract(root, [name], manifest, context);
  assert.equal(results.length, 1, `expected exactly one result for ${name}`);
  return results[0];
}

test("central package management resolves the version from Directory.Packages.props", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog.AspNetCore" Version="8.0.1" />
      </ItemGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Serilog.AspNetCore" />`),
  });
  const result = only(root, "Serilog.AspNetCore");
  assert.equal(result.currentVersion, "8.0.1");
  assert.equal(result.unresolved, false);
  // The version is owned by the props file, so that is what the row points at.
  assert.equal(result.manifestPath, "Directory.Packages.props");
});

test("a version on the reference wins over the central one", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Octokit" Version="9.0.0" />
      </ItemGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Octokit" Version="14.0.0" />`),
  });
  const result = only(root, "Octokit");
  assert.equal(result.currentVersion, "14.0.0");
  assert.equal(result.manifestPath, "src/App/App.csproj");
});

test("VersionOverride wins over the central version", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Octokit" Version="9.0.0" />
      </ItemGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Octokit" VersionOverride="14.0.0" />`),
  });
  assert.equal(only(root, "Octokit").currentVersion, "14.0.0");
});

test("$(Property) expands from Directory.Build.props", () => {
  const root = tree({
    "Directory.Build.props": `<Project><PropertyGroup>
        <NpgsqlVersion>9.0.2</NpgsqlVersion>
      </PropertyGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Npgsql" Version="$(NpgsqlVersion)" />`),
  });
  const result = only(root, "Npgsql");
  assert.equal(result.currentVersion, "9.0.2");
  assert.equal(result.rawVersion, "9.0.2");
});

test("$(Property) expands from the csproj's own PropertyGroup", () => {
  const root = tree({
    "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><SerilogVersion>3.1.0</SerilogVersion></PropertyGroup>
        <ItemGroup><PackageReference Include="Serilog" Version="$(SerilogVersion)" /></ItemGroup>
      </Project>`,
  });
  assert.equal(only(root, "Serilog").currentVersion, "3.1.0");
});

test("a property declared in Directory.Packages.props resolves its own PackageVersion", () => {
  const root = tree({
    "Directory.Packages.props": `<Project>
        <PropertyGroup><SerilogVersion>8.0.0</SerilogVersion></PropertyGroup>
        <ItemGroup><PackageVersion Include="Serilog" Version="$(SerilogVersion)" /></ItemGroup>
      </Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Serilog" />`),
  });
  assert.equal(only(root, "Serilog").currentVersion, "8.0.0");
});

test("property names are matched case-insensitively, as MSBuild does", () => {
  const root = tree({
    "Directory.Build.props": `<Project><PropertyGroup><PkgVer>2.1.0</PkgVer></PropertyGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Thing" Version="$(PKGVER)" />`),
  });
  assert.equal(only(root, "Thing").currentVersion, "2.1.0");
});

test("the nearest Directory.Packages.props wins", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog" Version="1.0.0" />
      </ItemGroup></Project>`,
    "src/Nested/Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog" Version="2.0.0" />
      </ItemGroup></Project>`,
    "src/Nested/App/App.csproj": project(`<PackageReference Include="Serilog" />`),
  });
  const result = only(root, "Serilog", "src/Nested/App/App.csproj");
  assert.equal(result.currentVersion, "2.0.0");
  assert.equal(result.manifestPath, "src/Nested/Directory.Packages.props");
});

test("props files above the repo root are never read", () => {
  const outer = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog" Version="1.0.0" />
      </ItemGroup></Project>`,
    "inner/src/App/App.csproj": project(`<PackageReference Include="Serilog" />`),
  });
  const result = only(path.join(outer, "inner"), "Serilog");
  assert.equal(result.currentVersion, null);
  assert.equal(result.unresolved, true);
});

test("an unresolvable property is reported, not silently mis-parsed", () => {
  const root = tree({
    "src/App/App.csproj": project(`<PackageReference Include="Npgsql" Version="$(Nowhere)" />`),
  });
  const result = only(root, "Npgsql");
  assert.equal(result.currentVersion, null);
  assert.equal(result.unresolved, true);
  assert.equal(result.rawVersion, "$(Nowhere)"); // shown verbatim so it can be traced
});

test("no version anywhere is unresolved, not a range", () => {
  const root = tree({ "src/App/App.csproj": project(`<PackageReference Include="Npgsql" />`) });
  const result = only(root, "Npgsql");
  assert.equal(result.rawVersion, "(no version)");
  assert.equal(result.unresolved, true);
  assert.equal(result.floating, false);
});

test("NuGet interval notation is a range, not a pinned version", () => {
  const root = tree({
    "src/App/App.csproj": project(`<PackageReference Include="Hangfire.Core" Version="[1.8.0,2.0.0)" />`),
  });
  const result = only(root, "Hangfire.Core");
  assert.equal(result.currentVersion, null);
  assert.equal(result.floating, false);
  assert.equal(result.unresolved, false);
});

test("a floating version behind a property is still detected as floating", () => {
  const root = tree({
    "Directory.Build.props": `<Project><PropertyGroup><Ver>7.*</Ver></PropertyGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Thing" Version="$(Ver)" />`),
  });
  const result = only(root, "Thing");
  assert.equal(result.floating, true);
  assert.equal(result.currentVersion, null);
});

test("two-segment versions stay strings rather than becoming numbers", () => {
  const root = tree({
    "src/App/App.csproj": project(`<PackageReference Include="Thing"><Version>8.0</Version></PackageReference>`),
  });
  assert.equal(only(root, "Thing").currentVersion, "8.0");
});

test("a malformed props file warns and is skipped; the run continues", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup><PackageVersion Include="Serilog"`,
    "src/App/App.csproj": project(`<PackageReference Include="Serilog" Version="3.0.0" />`),
  });
  const context = createMsbuildContext(root);
  const { results } = extract(root, ["Serilog"], "src/App/App.csproj", context);
  assert.equal(results[0].currentVersion, "3.0.0");
  assert.equal(context.warnings.length, 1);
  assert.match(context.warnings[0], /Directory\.Packages\.props/);
});

test("a malformed csproj is a hard error", () => {
  const root = tree({ "src/App/App.csproj": `<Project><ItemGroup><PackageReference Include=` });
  assert.throws(() => extract(root, ["Serilog"]), /Cannot parse csproj/);
});

test("a missing csproj warns instead of aborting the run", () => {
  const root = tree({ "src/App/App.csproj": project("") });
  const { results, warnings, missing } = extract(root, ["Serilog"], "src/Gone/Gone.csproj");
  assert.deepEqual(results, []);
  assert.equal(missing, true);
  assert.match(warnings[0], /does not exist/);
});

test("each file is parsed once, however many packages target it", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="A" Version="1.0.0" />
        <PackageVersion Include="B" Version="2.0.0" />
      </ItemGroup></Project>`,
    "src/App/App.csproj": project(
      `<PackageReference Include="A" /><PackageReference Include="B" />`
    ),
  });
  const context = createMsbuildContext(root);
  extract(root, ["A", "B"], "src/App/App.csproj", context);
  // csproj + the two props probes from src/App upward, cached either way.
  assert.equal(context.docs.size <= 7, true);
  assert.equal(context.scopes.size, 1);
});

// --- regressions found in review -------------------------------------------

test("an unparseable nearest props file never falls through to an ancestor's versions", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Newtonsoft.Json" Version="9.0.1" />
      </ItemGroup></Project>`,
    // The governing file for src/A, but broken. Its real version is 13.0.3.
    "src/Directory.Packages.props": `<Project><!-- unclosed
        <ItemGroup><PackageVersion Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup></Project>`,
    "src/A/A.csproj": project(`<PackageReference Include="Newtonsoft.Json" />`),
  });
  const context = createMsbuildContext(root);
  const result = only(root, "Newtonsoft.Json", "src/A/A.csproj", context);
  // Reporting 9.0.1 here would be a plausible-looking lie.
  assert.equal(result.currentVersion, null);
  assert.equal(result.unresolved, true);
  assert.match(context.warnings[0], /src\/Directory\.Packages\.props/);
});

test("Update overrides an earlier Include for the same package", () => {
  const root = tree({
    "src/App/App.csproj": project(
      `<PackageReference Include="Npgsql" Version="1.0.0" />
       <PackageReference Update="Npgsql" Version="8.0.0" />`
    ),
  });
  assert.equal(only(root, "Npgsql").currentVersion, "8.0.0");
});

test("conflicting Include declarations are both reported, never silently dropped", () => {
  const root = tree({
    "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
        <ItemGroup Condition="'$(TargetFramework)'=='net48'">
          <PackageReference Include="Serilog" Version="2.10.0" />
        </ItemGroup>
        <ItemGroup Condition="'$(TargetFramework)'=='net8.0'">
          <PackageReference Include="Serilog" Version="4.0.0" />
        </ItemGroup>
      </Project>`,
  });
  const { results } = extract(root, ["Serilog"]);
  assert.deepEqual(results.map((r) => r.currentVersion).sort(), ["2.10.0", "4.0.0"]);
});

test("identical repeated declarations still collapse to one result", () => {
  const root = tree({
    "src/App/App.csproj": project(
      `<PackageReference Include="Serilog" Version="4.0.0" />
       <PackageReference Include="Serilog" Version="4.0.0" />`
    ),
  });
  assert.equal(extract(root, ["Serilog"]).results.length, 1);
});

test("a malformed file reports the same way whichever probe reaches it first", () => {
  const files = {
    "src/Directory.Packages.props": `<Project><!-- unclosed`,
    "src/A.csproj": project(`<PackageReference Include="Serilog" Version="1.0.0" />`),
  };
  // Probing it as a props file first must not cache it as "missing" and turn a
  // later required read into a bogus "does not exist".
  const viaScopeFirst = tree(files);
  const ctx = createMsbuildContext(viaScopeFirst);
  extract(viaScopeFirst, ["Serilog"], "src/A.csproj", ctx);
  assert.throws(
    () => extract(viaScopeFirst, ["Serilog"], "src/Directory.Packages.props", ctx),
    /Cannot parse MSBuild file .*Comment is not closed/
  );

  const direct = tree(files);
  assert.throws(
    () => extract(direct, ["Serilog"], "src/Directory.Packages.props"),
    /Cannot parse MSBuild file .*Comment is not closed/
  );
});

test("a directory where a csproj should be warns, as the npm side already did", () => {
  const root = tree({ "src/App/App.csproj": project("") });
  mkdirSync(path.join(root, "adirectory.csproj"));
  const { missing, warnings } = extract(root, ["Serilog"], "adirectory.csproj");
  assert.equal(missing, true);
  assert.match(warnings[0], /does not exist/);
});

test("an empty version, or a property with no value, is unresolved", () => {
  const root = tree({
    "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><Blank></Blank></PropertyGroup>
        <ItemGroup>
          <PackageReference Include="Serilog" Version="" />
          <PackageReference Include="Npgsql" Version="$(Blank)" />
        </ItemGroup>
      </Project>`,
  });
  for (const name of ["Serilog", "Npgsql"]) {
    const result = only(root, name);
    assert.equal(result.unresolved, true, `${name} should be unresolved`);
    assert.equal(result.rawVersion, "(no version)");
    assert.equal(result.currentVersion, null);
  }
});

test("a manifest reached via .. does not pick up props above the repo root", () => {
  const outer = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog" Version="1.0.0" />
      </ItemGroup></Project>`,
    "outside/O.csproj": project(`<PackageReference Include="Serilog" />`),
    "repo/.keep": "",
  });
  const result = only(path.join(outer, "repo"), "Serilog", "../outside/O.csproj");
  assert.equal(result.currentVersion, null);
  assert.equal(result.unresolved, true);
});

// --- regressions found in the second review ---------------------------------

const CENTRAL_999 = `<Project><ItemGroup>
    <PackageVersion Include="Serilog" Version="9.9.9" />
  </ItemGroup></Project>`;

test("repeated <Version> children resolve locally, never fall through to central", () => {
  const root = tree({
    "Directory.Packages.props": CENTRAL_999,
    "src/App/App.csproj": project(`<PackageReference Include="Serilog">
        <Version Condition="'$(TF)'=='net8.0'">3.1.1</Version>
        <Version Condition="'$(TF)'=='net472'">2.12.0</Version>
      </PackageReference>`),
  });
  const result = only(root, "Serilog");
  // MSBuild metadata is last-wins. Reporting the central 9.9.9 would be a lie.
  assert.equal(result.currentVersion, "2.12.0");
  assert.equal(result.manifestPath, "src/App/App.csproj");
});

test("an Update before any Include matches nothing and is ignored", () => {
  const root = tree({
    "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
        <ItemGroup><PackageReference Update="Serilog" Version="2.0.0" /></ItemGroup>
        <ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup>
      </Project>`,
  });
  assert.equal(only(root, "Serilog").currentVersion, "3.1.1");
});

test("a metadata-only Update leaves the Include's version alone", () => {
  const root = tree({
    "Directory.Packages.props": CENTRAL_999,
    "src/App/App.csproj": project(
      `<PackageReference Include="Serilog" Version="1.0.0" />
       <PackageReference Update="Serilog" PrivateAssets="all" />`
    ),
  });
  const result = only(root, "Serilog");
  assert.equal(result.currentVersion, "1.0.0");
  assert.equal(result.manifestPath, "src/App/App.csproj");
});

test("with no Include at all, the last Update with a version wins", () => {
  const root = tree({
    "src/App/App.csproj": project(
      `<PackageReference Update="Serilog" Version="2.0.0" />
       <PackageReference Update="Serilog" Version="3.1.1" />`
    ),
  });
  assert.equal(only(root, "Serilog").currentVersion, "3.1.1");
});

test("duplicate PackageVersion entries are both reported, not silently resolved", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog" Version="2.0.0" />
        <PackageVersion Include="Serilog" Version="3.1.1" />
      </ItemGroup></Project>`,
    "src/App/App.csproj": project(`<PackageReference Include="Serilog" />`),
  });
  const { results } = extract(root, ["Serilog"]);
  assert.deepEqual(results.map((r) => r.currentVersion).sort(), ["2.0.0", "3.1.1"]);
});

test("row attribution does not depend on declaration order", () => {
  const central = `<Project><ItemGroup>
      <PackageVersion Include="Serilog" Version="3.1.1" />
    </ItemGroup></Project>`;
  const shapes = [
    `<PackageReference Include="Serilog" />
     <PackageReference Include="Serilog" VersionOverride="3.1.1" />`,
    `<PackageReference Include="Serilog" VersionOverride="3.1.1" />
     <PackageReference Include="Serilog" />`,
  ];
  const seen = shapes.map((body) => {
    const root = tree({ "Directory.Packages.props": central, "src/App/App.csproj": project(body) });
    return extract(root, ["Serilog"]).results.map((r) => r.manifestPath).sort();
  });
  assert.deepEqual(seen[0], seen[1]);
  assert.deepEqual(seen[0], ["Directory.Packages.props", "src/App/App.csproj"]);
});

test("a central version cannot see properties defined only in the csproj", () => {
  const root = tree({
    "Directory.Packages.props": `<Project><ItemGroup>
        <PackageVersion Include="Serilog" Version="$(OnlyInProject)" />
      </ItemGroup></Project>`,
    "src/App/App.csproj": `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OnlyInProject>1.2.3</OnlyInProject></PropertyGroup>
        <ItemGroup><PackageReference Include="Serilog" /></ItemGroup>
      </Project>`,
  });
  // MSBuild imports the props file before the project body, so 1.2.3 is not
  // visible there and inventing it would be a version MSBuild never produces.
  assert.equal(only(root, "Serilog").unresolved, true);
});

test("MSBuild function syntax is unresolved, not treated as a version", () => {
  const root = tree({
    "src/App/App.csproj": project(
      `<PackageReference Include="Serilog" Version="$([MSBuild]::Add(1,2))" />`
    ),
  });
  assert.equal(only(root, "Serilog").unresolved, true);
});

test("surrounding whitespace is not part of the version", () => {
  const root = tree({
    "src/App/App.csproj": project(`<PackageReference Include="Serilog" Version="  3.1.1  " />`),
  });
  const result = only(root, "Serilog");
  assert.equal(result.currentVersion, "3.1.1");
  assert.equal(result.rawVersion, "3.1.1");
});
