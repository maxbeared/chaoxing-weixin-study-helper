@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%INSTALL_EXIT_CODE%"=="0" (
  echo Install failed with exit code %INSTALL_EXIT_CODE%.
)
pause
exit /b %INSTALL_EXIT_CODE%
