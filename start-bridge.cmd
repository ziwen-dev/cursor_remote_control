@echo off
setlocal
set "BRIDGE_ROOT=%~dp0"
set "BRIDGE_PORT=7419"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root='%BRIDGE_ROOT%'; $port=%BRIDGE_PORT%; " ^
  "function Test-Bridge { try { $r=Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/health') -UseBasicParsing -TimeoutSec 2; return $r.StatusCode -eq 200 } catch { return $false } }; " ^
  "if (-not (Test-Bridge)) { " ^
  "  $task=Get-ScheduledTask -TaskName 'CursorRemoteBridge' -ErrorAction SilentlyContinue; " ^
  "  if ($task) { Start-ScheduledTask -TaskName $task.TaskName } " ^
  "  else { $log=Join-Path $root 'data\logs'; New-Item -ItemType Directory -Path $log -Force | Out-Null; $node=(Get-Command node.exe -ErrorAction Stop).Source; Start-Process -FilePath $node -ArgumentList 'src\server.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $log 'bridge.stdout.log') -RedirectStandardError (Join-Path $log 'bridge.stderr.log') } " ^
  "}; " ^
  "$deadline=(Get-Date).AddSeconds(45); while (-not (Test-Bridge) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }; " ^
  "if (Test-Bridge) { Start-Process ('http://127.0.0.1:' + $port + '/'); exit 0 } " ^
  "Write-Host 'Cursor Bridge did not become healthy. Check data\logs\bridge.log.' -ForegroundColor Red; exit 1"

if errorlevel 1 pause
endlocal
