@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Shattered Arms - Cloudflare Workers

rem ============================================================
rem Workers project name. Becomes <name>.<subdomain>.workers.dev.
rem Must match the name field in wrangler.toml.
rem ============================================================
set PROJECT_NAME=shattered-arms

:menu
cls
echo.
echo ====================================
echo Shattered Arms - Workers
echo ====================================
echo.
echo Project: %PROJECT_NAME%
echo URL: https://%PROJECT_NAME%.YOUR-SUBDOMAIN.workers.dev
echo.
echo [1] Deploy to Workers
echo [2] Test locally
echo [3] Log in to Cloudflare
echo [4] Exit
echo.
set /p "choice= Choose [1-4]: "

if "%choice%"=="1" goto deploy
if "%choice%"=="2" goto dev
if "%choice%"=="3" goto login
if "%choice%"=="4" goto end
goto menu

rem ------------------------------------------------------------

:check_node
where node >nul 2>nul
if errorlevel 1 (
echo.
echo [ERROR] Node.js is not installed.
echo Install it from https://nodejs.org and try again.
echo.
pause
exit /b 1
)
exit /b 0

:check_login
call :check_node
if errorlevel 1 exit /b 1

call npx wrangler whoami >nul 2>nul
if errorlevel 1 (
echo.
echo Not logged in to Cloudflare.
echo Opening browser so you can log in...
echo.
call npx wrangler login
if errorlevel 1 (
echo.
echo Login failed.
pause
exit /b 1
)
)
exit /b 0

rem ------------------------------------------------------------

:deploy
call :check_login
if errorlevel 1 goto menu

echo.
echo Deploying to Cloudflare Workers...
echo.
call npx wrangler deploy
if errorlevel 1 (
echo.
echo [ERROR] Deploy failed. See the output above.
) else (
echo.
echo Success! Your Worker is live at the URL printed above.
)
echo.
pause
goto menu

:dev
call :check_login
if errorlevel 1 goto menu

echo.
echo Starting local dev server. Press Ctrl+C to stop it.
echo Open the URL printed below in two browser tabs.
echo.
call npx wrangler dev
echo.
pause
goto menu

:login
call :check_node
if errorlevel 1 goto menu
echo.
call npx wrangler login
echo.
pause
goto menu

:end
endlocal
exit /b 0