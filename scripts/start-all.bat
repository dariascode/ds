@echo off
REM Переходим в корень проекта
cd /d C:\ds

echo 🚀 Запуск всех 12 серверов...

for %%N in (A B C) do (
    echo.
    echo ——— Запускаем узел %%N ———
    for %%I in (1 2 3 4) do (
        echo   • сервер %%N-%%I…
        forever start C:\ds\server.js configs\node%%N\server%%I.json
        timeout /t 1 >nul
    )
)

echo.
echo ✅ Все 12 серверов запущены!
pause

