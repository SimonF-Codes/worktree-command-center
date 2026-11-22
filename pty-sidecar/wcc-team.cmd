@if not exist "%~dp0wcc-team.cjs" (echo wcc-team: %~dp0wcc-team.cjs is not built - run "npm run build" in the source first 1>&2 & exit /b 1)
@node "%~dp0wcc-team.cjs" %*
