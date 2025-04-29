@echo off
echo 🧠 Переход в корень проекта...
cd /d "%~dp0\.."

echo 🚀 Запуск всех узлов (A, B, C)...

call scripts\start-nodeA.bat
call scripts\start-nodeB.bat
call scripts\start-nodeC.bat

echo ✅ Все узлы запущены!
