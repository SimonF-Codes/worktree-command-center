@echo off
REM Launch the Worktree Command Center DEV build (runs from source via npm).
REM Double-click this file to start it. The window that opens is the build log —
REM keep it open while you use the app; close it to quit the app.
cd /d "%~dp0"
set DISABLE_AUTOUPDATER=1
echo Starting Worktree Command Center (dev build)...
call npm start
echo.
echo App exited. Press any key to close this window.
pause >nul
