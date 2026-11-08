@echo off
chcp 65001 >nul
node "%~dp0sync-dsh-profile.mjs" %*
if errorlevel 1 echo.
echo.
pause
