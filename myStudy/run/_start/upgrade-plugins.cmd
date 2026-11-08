@echo off
chcp 65001 >nul
node "%~dp0upgrade-plugins.mjs" %*
echo.
pause
