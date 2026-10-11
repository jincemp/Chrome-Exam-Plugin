@cd /d "%TEMP%" 2>nul & "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0native-host.ps1" & exit /b
