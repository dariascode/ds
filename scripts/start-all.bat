@echo off

cd /d C:\ds

echo

for %%N in (A B C) do (
    echo.
    echo  %%N
    for %%I in (1 2 3 4) do (
        echo    %%N  - %%I
        forever start server.js configs\node%%N\server%%I.json
        timeout /t 1 >nul
    )
)

echo.
echo
pause
