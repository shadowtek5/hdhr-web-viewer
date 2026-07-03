@echo off
cd /d "%~dp0"
echo Starting HDHomeRun Web Viewer...
python server.py %*
pause
