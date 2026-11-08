@echo off
chcp 65001 >nul
node "%~dp0pull-latest.mjs" %*
echo.
pause
