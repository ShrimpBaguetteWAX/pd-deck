@echo off
rem Starts the Alcor loop bot and opens its control page.
cd /d "%~dp0.."
start "" http://127.0.0.1:5199
node --no-warnings bot\arb-bot.ts
pause
