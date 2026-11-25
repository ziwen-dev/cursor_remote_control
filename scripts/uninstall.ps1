$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName "CursorRemoteBridge" -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName "CursorRemoteBridge" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "CursorRemoteBridge" -Confirm:$false
}

Get-NetTCPConnection -LocalPort 7419 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

"CursorRemoteBridge scheduled task and bridge listener removed."
