# Release Infrastructure v1

No release is published by local packaging. Desktop QA is still a public-release
gate; adding this workflow does not make the alpha production-ready.

## Build and inspect locally

Use Node **24.21.0**, npm (CI uses the npm bundled with that Node release), and
Python **3.12**. No new package dependencies are required.

```sh
npm ci
# npm test and test:browser require Chromium; set CHROME_BIN if not auto-detected.
npm test
npm run test:browser
npm run test:release
npm run release:package
python3 -m zipfile -l release/journal-routines-0.5.0-alpha.1.zip
python3 -m zipfile -t release/journal-routines-0.5.0-alpha.1.zip
```

Packaging always runs the existing production build and fails on a build error
or missing/empty input. Output is Git-ignored under `release/`. The ZIP has exactly
these files at its root (no containing directory):

```text
package.json
index.html
icon.png
dist/index.js
LICENSE
```

The original manifest is included, preserving `main`, version and
`logseq.id = journal-routines`. The SDK is bundled; installing does not require
`node_modules` or a build. Source, tests, lockfile, workflow, graph data and local
caches are not packaged. The ZIP uses fixed entry order, timestamp and permissions
and stores files without compression to avoid zlib-version differences. Identical
input file bytes produce identical ZIP bytes. Reproduce the build using the same
checkout, locked dependencies and toolchain; this is not a cross-toolchain promise.
Never upload an older local ZIP after a failed build.

For a built-release install, extract into a dedicated plugin directory and select
that directory via **Plugins → Load unpacked plugin**. No git or npm is needed.
Until Marketplace integration, manual updates mean replacing only these plugin
files in the **same directory**, then reloading; do not uninstall, clear plugin
storage/settings, or touch graph files. Same-directory updates are intended to
retain storage identity but still require Desktop validation.

## Future tag-to-release flow

1. Finish Desktop QA. Set the intended version (later `0.5.0`, then `0.5.1`)
   in both `package.json` and `package-lock.json`; keep the plugin ID unchanged.
2. Review/test and commit the release changes. Create an annotated version tag
   matching the manifest exactly, e.g. `v0.5.0`.
3. **Only after explicit publishing approval**, push that tag to GitHub. This
   triggers `.github/workflows/release.yml`: `npm ci` → existing Node/browser tests →
   packaging tests → production build → deterministic ZIP → matching GitHub Release.
   Failed tests/build/package validation prevent the release/upload step.
4. The attached asset is `journal-routines-<version>.zip`, not GitHub's automatic
   source ZIP. New tags containing a prerelease suffix create prereleases;
   stable tags create ordinary releases. An existing matching release receives
   the asset without changing its draft/prerelease status. Reruns replace the
   same-named asset. Only maintainers should create release tags.

Current version remains `0.5.0-alpha.1`. No tag, release or Marketplace submission
is created as part of implementing this infrastructure. GitHub Actions execution
and release attachment must be verified on GitHub later; local tests do not prove
they ran there. CI uses the Ubuntu runner's preinstalled Google Chrome and fails
if it is missing. Real Desktop checks remain separate from the tag job.

## Distribution and update gate

Authoritative sources checked for this format:

- [Official Marketplace instructions](https://github.com/logseq/marketplace/blob/master/README.md):
  attach a built ZIP in addition to the source archive; catalog submission is a
  separate manifest/PR process and requires usage documentation and an image/GIF.
- [Logseq Desktop 0.10.15 installer](https://github.com/logseq/logseq/blob/0.10.15/src/electron/electron/plugin.cljs):
  accepts root `package.json`, selects the first attached `.zip`, and uses GitHub's
  latest release for normal updates. Keep **one installable ZIP** on each release.

This implements compatible release assets, not a private updater or Marketplace
registration. Built-in Logseq updates require repository/catalog metadata through
the supported distribution path; merely loading an extracted ZIP does not promise
automatic update discovery. Marketplace submission and its metadata are deferred.

Before the first public `v0.5.0`: complete the Desktop gate in `NEXT_SESSION.md`,
review version/lockfile and release notes, verify the GitHub job and ZIP install,
and validate updates on disposable data. Test installed **v0.5.0 → v0.5.1** in the
same supported installation path: existing graph content/completion, per-graph
preferences, native defaults, settings and IndexedDB safety markers must remain
intact across update/reload. Review existing dependency audit findings before
public release (the current SDK dependency tree reports high/critical advisories;
no dependency/runtime changes are made by this infrastructure task).
Do not erase storage or reuse an emptied graph path
to simulate a fresh install. Actual update preservation remains unverified.
