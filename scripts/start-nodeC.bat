@echo off
set ROOT=C:\Users\Dasha\WebstormProjects\untitled2
echo 🚀 Запуск узла C (4 сервера)...

forever start %ROOT%\server.js %ROOT%\configs\nodeC\server1.json
forever start %ROOT%\server.js %ROOT%\configs\nodeC\server2.json
forever start %ROOT%\server.js %ROOT%\configs\nodeC\server3.json
forever start %ROOT%\server.js %ROOT%\configs\nodeC\server4.json
