@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\package.ps1" %*
set "PACKAGE_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%PACKAGE_EXIT_CODE%"=="0" (
  echo Source package failed with exit code %PACKAGE_EXIT_CODE%.
)
pause
exit /b %PACKAGE_EXIT_CODE%
