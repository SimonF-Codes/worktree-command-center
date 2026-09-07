<!-- CI runs typecheck, unit tests, an esbuild bundle, and a CHANGELOG check on every PR. -->

## What & why

<!-- What does this change do, and what problem does it solve? -->

## Verification

<!-- How did you confirm it works? e.g. `npm test`, drove the affected flow in the app. -->

## Checklist

- [ ] `CHANGELOG.md` updated under `## Unreleased` (or the `skip-changelog` label applied for internal-only changes)
- [ ] `npm test` and `npx tsc -noEmit -skipLibCheck` pass locally
- [ ] No build artifacts committed (`dist/`, `release/`, `node_modules/` stay gitignored)
