@echo off
chcp 65001 >nul
powershell -NoProfile -Command "$id=[Security.Principal.WindowsIdentity]::GetCurrent(); if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Start-Process -FilePath '%~f0' -Verb RunAs; exit 7 }"
if errorlevel 7 (
  echo 已请求管理员权限：请在 UAC 弹窗点"是"，然后在新的窗口里查看结果。
  timeout /t 3 >nul
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-system-path.ps1"
echo.
pause
