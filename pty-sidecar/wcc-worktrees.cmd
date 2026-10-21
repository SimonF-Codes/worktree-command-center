@if not exist "%~dp0wcc-worktrees.cjs" (echo wcc-worktrees: %~dp0wcc-worktrees.cjs is not built - run "npm run build" in the source first 1>&2 & exit /b 1)
@node "%~dp0wcc-worktrees.cjs" %*
