# CI / CD

GitHub Actions guard every change and automate releases. Two workflows live in
`.github/workflows/`.

## `ci.yml` — on every PR to `main` and every push to `main`

Job **`verify`** (ubuntu):

1. `npm ci` — installs deps *and* fails on `package-lock.json` drift.
2. `tsc -noEmit -skipLibCheck` — typecheck.
3. `npm test` — the full vitest suite.
4. `node esbuild.config.mjs` — confirms the renderer + main bundles actually build.
5. Artifact guard — fails if `dist/`, `release/`, `release-private/`, or `node_modules/`
   ever get committed (they must stay gitignored).

The Electron binary download is skipped (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) — esbuild marks
`electron` and `node-pty` as `external`, and nothing under test needs the runtime, so CI stays
fast and avoids the flaky ~150 MB download. `node-pty` still loads from its checked-in prebuilds.

Job **`changelog`** (PRs only): fails unless the PR touches `CHANGELOG.md`. Genuinely
internal PRs opt out with a **`skip-changelog`** label instead of inventing an entry.

### Recommended branch protection

Make `verify` and `changelog` **required status checks** on `main` (Settings → Branches), so
nothing merges red. A PR template (`.github/pull_request_template.md`) reminds contributors of
the same checklist.

## `release.yml` — on pushing a `v*` tag

1. **`validate`** re-runs typecheck/test/build, then asserts the tag matches
   `package.json`'s `version` *and* that `CHANGELOG.md` has a matching `## <version>` section
   (not just `Unreleased`). A tag can't ship undocumented or unbuildable code.
2. **`windows-installer`** runs `npm run dist` (electron-builder NSIS — no signing cert
   needed) and publishes a GitHub Release with the `.exe` attached.

### Cutting a release

```sh
# 1. Promote the Unreleased notes to a dated version heading in CHANGELOG.md
# 2. Bump the version (keeps the lockfile in sync)
npm version 0.2.0 --no-git-tag-version
git commit -am "release: 0.2.0"
# 3. Tag and push — release.yml does the rest
git tag v0.2.0 && git push origin main v0.2.0
```

### Not wired yet

- **macOS installer.** The repo signs mac builds with a local self-signed cert; CI would need
  that cert + password as encrypted secrets before adding a `macos-latest` matrix leg. Until
  then, mac builds stay local (`npm run dist:mac`).
