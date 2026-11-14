@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================================
rem  build-music-manifest.bat
rem
rem  Scans music\menu\, music\campaign\, music\battle\ and rewrites
rem  music\manifest.json listing every audio file inside each category.
rem
rem  Usage:
rem    1. Put this file next to index.html (project root).
rem    2. Drop audio files into music\menu\, music\campaign\, music\battle\.
rem    3. Double-click this .bat (or run it from cmd).
rem    4. Commit + push. Cloudflare serves manifest.json as a static asset.
rem
rem  Supported extensions (case-insensitive):
rem    .mp3 .ogg .wav .m4a .flac .webm .opus
rem
rem  Sub-folders inside a category are NOT scanned — keep tracks flat in
rem  their category folder so manifest entries stay simple filenames.
rem  Re-run this script every time you add or remove a track.
rem ============================================================================

set "MUSIC_DIR=music"
set "OUT=%MUSIC_DIR%\manifest.json"

if not exist "%MUSIC_DIR%" (
    echo [error] "%MUSIC_DIR%" folder not found next to this script.
    echo         This .bat must live in the project root, beside index.html.
    exit /b 1
)

rem --- Build a JSON array string for each category --------------------
rem  The trailing commas after the menu/campaign lines are written by the
rem  echo below as literal text. Doing them through CALL arguments (as a
rem  previous version did) is unreliable — CALL's parser can eat a comma
rem  sitting alone in an argument list, which silently produced invalid
rem  JSON. Keeping the comma inside the echo text avoids that entirely.
call :build_array menu     MENU_ARR
call :build_array campaign CAMPAIGN_ARR
call :build_array battle   BATTLE_ARR

rem --- Write the manifest ----------------------------------------------
(
echo {
echo   "menu": [!MENU_ARR!],
echo   "campaign": [!CAMPAIGN_ARR!],
echo   "battle": [!BATTLE_ARR!]
echo }
) > "%OUT%"

echo Wrote "%OUT%"
call :count_report menu
call :count_report campaign
call :count_report battle
exit /b 0


rem ============================================================================
rem  :build_array <category> <out_varname>
rem
rem  Fills <out_varname> with a JSON array body: `"a.mp3", "b.mp3"`.
rem  Empty result when the folder is missing or has no recognised files.
rem  The surrounding brackets are NOT included — the caller's echo line
rem  supplies them so the comma layout stays readable.
rem ============================================================================
:build_array
setlocal enabledelayedexpansion
set "CAT=%~1"
set "OUTVAR=%~2"
set "DIR=%MUSIC_DIR%\%CAT%"
set "ARRAY="
set "SEP="
if exist "%DIR%" (
    for /f "delims=" %%F in ('dir /b /a-d "%DIR%" 2^>nul ^| findstr /i /e "\.mp3 \.ogg \.wav \.m4a \.flac \.webm \.opus"') do (
        set ARRAY=!ARRAY!!SEP!"%%F"
        set "SEP=, "
    )
)
endlocal & set "%OUTVAR%=%ARRAY%"
exit /b 0


rem ============================================================================
rem  :count_report <category>
rem  Prints "  <category>: N track(s)" to stdout after the write.
rem ============================================================================
:count_report
setlocal enabledelayedexpansion
set "CAT=%~1"
set "N=0"
if exist "%MUSIC_DIR%\%CAT%" (
    for /f %%K in ('dir /b /a-d "%MUSIC_DIR%\%CAT%" 2^>nul ^| findstr /i /e "\.mp3 \.ogg \.wav \.m4a \.flac \.webm \.opus" ^| find /c /v ""') do set "N=%%K"
)
echo   %CAT%: !N! track^(s^)
endlocal
exit /b 0