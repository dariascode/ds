@echo off
set ROOT=C:\Users\Dasha\WebstormProjects\untitled2
echo 🚀 Запуск узла B (4 сервера)...

forever start %ROOT%\server.js %ROOT%\configs\nodeB\server1.json
forever start %ROOT%\server.js %ROOT%\configs\nodeB\server2.json
forever start %ROOT%\server.js %ROOT%\configs\nodeB\server3.json
forever start %ROOT%\server.js %ROOT%\configs\nodeB\server4.json
