@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ClaudeTUI - deploy
cd /d "%~dp0.."

REM ---------------------------------------------------------------------------
REM Double-clickable deploy step for the owner's loop:
REM   agents commit -> merge -> Claude runs `npm run package` -> close the app ->
REM   double-click this -> it deploys and relaunches.
REM
REM Deploy ONLY. It never builds: `npm run package` writes dist\win-unpacked and
REM can run while the app is open, so the build is Claude's job and this is the
REM short close-window step. If dist is missing it says so rather than silently
REM shipping a stale tree.
REM
REM Target is whatever scripts\deploy-desktop.mjs writes (currently
REM %USERPROFILE%\Desktop\ClaudeTUI) - kept OUT of the OneDrive Desktop on
REM purpose so a few-hundred-MB Electron tree isn't cloud-synced every deploy.
REM ---------------------------------------------------------------------------

set "APPDIR=%USERPROFILE%\Desktop\ClaudeTUI"
set "APPEXE=%APPDIR%\ClaudeTUI.exe"

echo(
echo  ==========================================
echo    ClaudeTUI  -  deploy build to working copy
echo  ==========================================
echo(

if not exist "dist\win-unpacked\ClaudeTUI.exe" (
  echo  [X] dist\win-unpacked not found - there is nothing built to deploy.
  echo      Ask Claude to run:  npm run package
  echo(
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "VER=%%v"
for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "HASH=%%h"
echo  repo HEAD : !VER!  ^(!HASH!^)

REM --- freshness gate: refuse to silently ship a build older than the sources --
set "FRESHSTATE="
set "FRESHMSG="
for /f "tokens=1,*" %%a in ('node scripts\deploy-check.mjs 2^>^&1') do (
  set "FRESHSTATE=%%a"
  set "FRESHMSG=%%b"
)
echo  build     : !FRESHMSG!
echo(

if /I "!FRESHSTATE!"=="STALE" (
  echo  [warn] The packaged build is OLDER than your source files.
  echo      Nobody has run `npm run package` since the last change,
  echo      so deploying now would ship the PREVIOUS build.
  echo(
  echo      Ask Claude to run:  npm run package
  echo(
  choice /C YN /N /M "  Deploy the old build anyway?  [Y/N] "
  if errorlevel 2 (
    echo(
    echo  Cancelled - nothing was deployed.
    timeout /t 3 /nobreak >nul
    exit /b 1
  )
  echo(
)

REM --- wait for the app to be closed; it locks the folder we overwrite ---------
set /a TRIES=0
:waitclose
tasklist /FI "IMAGENAME eq ClaudeTUI.exe" 2>nul | find /I "ClaudeTUI.exe" >nul
if errorlevel 1 goto deploy
set /a TRIES+=1
if !TRIES! GEQ 40 (
  echo(
  echo  [X] ClaudeTUI is still running after 2 minutes - giving up.
  echo      Close it and run this again.
  echo(
  pause
  exit /b 1
)
if !TRIES! EQU 1 echo  [..] ClaudeTUI is still open - close it and I'll continue automatically.
timeout /t 3 /nobreak >nul
goto waitclose

:deploy
echo  [1/2] Deploying...
call npm run deploy:desktop
if errorlevel 1 (
  echo(
  echo  [X] Deploy FAILED - see the error above.
  echo(
  pause
  exit /b 1
)

echo(
echo  [2/2] Launching ClaudeTUI...
if not exist "%APPEXE%" (
  echo  [X] Deployed, but %APPEXE% is missing - launch manually.
  pause
  exit /b 1
)
start "" "%APPEXE%"

echo(
echo  [OK] Deployed !VER! ^(!HASH!^) and relaunched.
timeout /t 4 /nobreak >nul
exit /b 0
