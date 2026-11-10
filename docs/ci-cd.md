---
status: stable
---

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

## Versioning

Semver, with the leading `0.` meaning what it usually means: the shell and the CLI contract have
been free to change between minors.

**The version is declared in three places and they must agree:** `package.json`'s `version`, and
`package-lock.json`'s `version` *and* `packages[""].version`. `npm run dist` refuses to build if
they do not (`scripts/check-version.mjs`), because the lockfile sat at `0.3.0` while `package.json`
shipped `0.4.0` through `0.13.0` — ten releases. Nothing broke, which is why nobody noticed: npm
does not read the lockfile's `version` for resolution, so the drift only surfaces when a packager,
an audit tool or a person tries to work out what a tree actually is.

Bump with the command that updates all three:

```sh
npm version <version> --no-git-tag-version
```

Hand-editing `package.json`'s one line is tempting, because a JSON round-trip can reformat the
compact arrays in the `build.files` block and leave reformatting churn in a release commit. If you
do it by hand, run `npm run check-version` before committing — that is what it is for.

### The next release is `1.0.0`

The V2 Team Floor overhaul ([`docs/designs/v2-team-floor/`](designs/v2-team-floor/)) is a major
version, not a minor one. It replaces the workspace tab strip with a team sidebar, makes the
worktree one isolation mode among four rather than the only unit of work, and turns the CLI into
the engine the UI sits on. Each of those three is a breaking change to something a user or an
external session depends on.

What that means in practice:

- **Anything merged before the overhaul goes out as `0.13.x` or `0.14.0`** — ordinary patch and
  feature releases, as now. The reserved `1.0.0` does not block normal work.
- **Breaking changes wait for `1.0.0`.** If a change must break the CLI contract, the connector
  grants or the persisted config shape, it belongs in the overhaul, not in a `0.x` release.
- **`1.0.0` carries a migration note in `CHANGELOG.md`**, not just a feature list: what moved,
  what a connector must change, and how to roll back. The design's migration ladder is written so
  each step is reversible by flipping one setting; the changelog must say which setting.
- **After `1.0.0`, breaking changes need a major.** The `0.` licence to break things expires with
  it, which is the real cost of the bump and the reason it is worth stating up front.

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
