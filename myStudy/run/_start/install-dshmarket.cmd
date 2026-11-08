@echo off
chcp 65001 >nul
node "%~dp0install-dshmarket.mjs" %*
echo.
pause
