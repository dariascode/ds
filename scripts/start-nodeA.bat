@echo off
echo 🚀 Запуск узла A (4 сервера)...

forever start ..\server.js ..\configs\nodeA\server1.json
forever start ..\server.js ..\configs\nodeA\server2.json
forever start ..\server.js ..\configs\nodeA\server3.json
forever start ..\server.js ..\configs\nodeA\server4.json
