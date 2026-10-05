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
python3 -m zipfile -l release/journal-routines-0.5.0.zip
python3 -m zipfile -t release/journal-routines-0.5.0.zip
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

Current version is the unpublished `0.5.0` release candidate. No regular tag,
release or Marketplace PR is created by this preparation. The existing
`v0.5.0-alpha.2` GitHub prerelease was verified on 2026-10-05: it has one attached
installable ZIP, `journal-routines-0.5.0-alpha.2.zip` (356,345 bytes). Neither
alpha release/tag is modified. The regular release job and attachment must still
be verified after authorized publication; local tests do not prove they ran there.
CI uses the Ubuntu runner's preinstalled Google Chrome and fails
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
automatic update discovery. Marketplace submission is blocked as described below.

Before the first public `v0.5.0`: complete the Desktop gate in `NEXT_SESSION.md`,
review version/lockfile and release notes, and verify ZIP installation on disposable
data. After authorized publication/catalog acceptance, test installed **v0.5.0 → v0.5.1** in the
same supported installation path: existing graph content/completion, per-graph
preferences, native defaults, settings and IndexedDB safety markers must remain
intact across update/reload. Review existing dependency audit findings before
public release (high/critical SDK dependency advisories were previously recorded;
they were not re-audited, and no dependency/runtime changes are made by this preparation).
Do not erase storage or reuse an emptied graph path
to simulate a fresh install. Actual update preservation remains unverified.

## Marketplace preparation — 2026-10-05

Checked the [official Marketplace README](https://github.com/logseq/marketplace/blob/163e01061090d0ff1b56cdcf3418ed3c679230f1/README.md)
and example manifest at master commit `163e01061090d0ff1b56cdcf3418ed3c679230f1`.
The proposed manifest is [marketplace/packages/logseq-journal-routines/manifest.json](marketplace/packages/logseq-journal-routines/manifest.json).
Later copy it to `packages/logseq-journal-routines/manifest.json` in a Marketplace
fork. The proposal uses only official fields, targets Markdown file graphs and
does not request same-origin `effect` access. The package retains
`logseq.id = journal-routines`, `main = index.html` and its bundled icon. MIT
licensing is present in LICENSE and included in the release ZIP.

Required submission evidence:

- Attached installable release ZIP: verified for alpha.2; the regular v0.5.0 ZIP
  must be attached and verified after publication. The existing `release.yml`
  implements the build/ZIP/release flow requested by the official README's
  `publish.yml` guidance; do not introduce a second publishing workflow.
- Clear usage README: present, with setup, routine editing, sidebar/history,
  daily-template use, installation and supported graph requirements.
- Image/GIF showing actual use: **missing**. `icon.png` and `icon.svg` are logos,
  not action screenshots. Capture a real Logseq Desktop screenshot on a disposable
  Markdown graph showing the current weekly/monthly native sidebar panes with
  editable routine tasks, then commit the image and embed it in README. Do not
  substitute an invented image or a browser-fixture rendering.
- Manifest: proposed locally, not submitted. No Marketplace PR is open.

Marketplace preparation stops at the missing-image gate. Before tagging or
publishing, complete the existing Desktop gate, review the already-recorded
dependency findings, and add the real README screenshot. Then obtain explicit
publishing approval, publish the matching tag/ZIP, verify the attached asset and
only subsequently request authorization for the Marketplace PR. Real
v0.5.0 → v0.5.1 update validation follows supported installation; it is not a
claim made by this release preparation.

### Local release-candidate validation — 2026-10-05

The working tree was clean at the start (`d077af6`). Node 24.21.0, npm 11.19.0
and Python 3.12.3 were used with the existing locked dependencies. Persistent
Chrome for Testing was selected explicitly:

```sh
export CHROME_BIN=/home/worker1/.local/chrome-for-testing/chrome-linux64/chrome
export TMPDIR=/tmp/opencode
npm test                 # 736 passed; no failures or skips
npm run test:browser     # 26 assembled browser scenarios passed
npm run build            # passed; dist/index.js 344,114 bytes, unminified
npm run test:release     # 6 passed, including proposed Marketplace metadata
git diff --check         # passed
npm run release:package -- --tag v0.5.0
python3 -m zipfile -l release/journal-routines-0.5.0.zip
python3 -m zipfile -t release/journal-routines-0.5.0.zip
```

The local ZIP was built and integrity-checked with exactly the five allowlisted
files; it is Git-ignored and not attached to a public release. Passing `--tag`
checks version agreement only; it does not create a Git tag. Automated checks
do not close the Desktop gate or prove real v0.5.0 → v0.5.1 update preservation.
