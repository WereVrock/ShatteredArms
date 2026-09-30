@echo off
title War Server
echo Starting War server on port 8014...

:: Switch to the folder containing this .bat file
cd /d "%~dp0"

:: Try python first
python -m http.server 8014 >nul 2>&1
if %errorlevel%==0 (
    start "War Server" python -m http.server 8014
    goto :open
)

:: Try py if python not found
py -m http.server 8014 >nul 2>&1
if %errorlevel%==0 (
    start "War Server" py -m http.server 8014
    goto :open
)

:: Try python3 if neither python nor py works
python3 -m http.server 8014 >nul 2>&1
if %errorlevel%==0 (
    start "War Server" python3 -m http.server 8014
    goto :open
)

:: If all fail
echo ==========================================
echo Python was not found. Please install it.
echo Alternatively, use VS Code Live Server.
echo ==========================================
pause
exit

:open
echo Waiting 2 seconds for server to initialize...
timeout /t 2 /nobreak >nul
start http://localhost:8014/index.html
echo Server is running in a separate window.
echo Close both windows when done.
pause
exit