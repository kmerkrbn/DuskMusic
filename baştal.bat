@echo off
cd /d "%~dp0"
node deploy-commands.js
node index.js
pause
