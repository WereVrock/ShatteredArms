@echo off
pushd "%~dp0"
echo Running from: %cd%
echo.
echo First run may take a moment - npx fetches wrangler if not cached.
echo.
call npx --yes wrangler pages dev . --port 8014
popd
pause