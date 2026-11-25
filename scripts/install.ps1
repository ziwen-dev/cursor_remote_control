param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$CreateTasks
)

$ErrorActionPreference = "Stop"
$node = (Get-Command node.exe -ErrorAction Stop).Source
$configPath = Join-Path $ProjectRoot "config\bridge.config.json"
$serverPath = Join-Path $ProjectRoot "src\server.js"
$logDir = Join-Path $ProjectRoot "data\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $serverPath)) {
  throw "Missing server entrypoint: $serverPath"
}

$tokenPath = Join-Path $ProjectRoot "data\api-token.txt"
if (-not (Test-Path -LiteralPath $tokenPath)) {
  $tokenBytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
  $token = [Convert]::ToHexString($tokenBytes).ToLowerInvariant()
  [IO.File]::WriteAllText($tokenPath, $token, [Text.UTF8Encoding]::new($false))
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $tokenPath /inheritance:r /grant:r "${identity}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to restrict access to the bridge API token: $tokenPath"
}
$cursorAuthPath = Join-Path $HOME ".cursor\sdk\auth.json"
if (Test-Path -LiteralPath $cursorAuthPath) {
  & icacls.exe $cursorAuthPath /inheritance:r /grant:r "${identity}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to restrict access to the Cursor SDK credential: $cursorAuthPath"
  }
}

if ($CreateTasks) {
  $taskName = "CursorRemoteBridge"
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $port = [int]$config.port
  $launcher = Join-Path $ProjectRoot "scripts\run-bridge.vbs"
  $scriptHost = Join-Path $env:SystemRoot "System32\wscript.exe"
  $action = New-ScheduledTaskAction -Execute $scriptHost -Argument "//B //NoLogo `"$launcher`" `"$node`"" -WorkingDirectory $ProjectRoot
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval ([TimeSpan]::FromMinutes(1)) -StartWhenAvailable -MultipleInstances IgnoreNew
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $stopDeadline = (Get-Date).AddSeconds(10)
  do {
    $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
    if ($state -ne "Running") { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $stopDeadline)

  $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($bridgeProcess -and $bridgeProcess.CommandLine -match 'src[\\/]server\.js') {
      Stop-Process -Id $bridgeProcess.ProcessId -Force
    }
  }
  $portDeadline = (Get-Date).AddSeconds(10)
  do {
    $occupied = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if (-not $occupied) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $portDeadline)
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    throw "Port $port is still occupied after stopping the old bridge"
  }

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $logonTrigger -Principal $principal -Settings $settings -Description "Run Cursor Remote Bridge in the signed-in user's session" -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName

  $healthDeadline = (Get-Date).AddSeconds(45)
  $healthy = $false
  do {
    try {
      $health = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 -UseBasicParsing
      if ($health.StatusCode -eq 200) { $healthy = $true; break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $healthDeadline)
  if (-not $healthy) {
    throw "CursorRemoteBridge was registered but did not become healthy on port $port"
  }

}

[pscustomobject]@{
  ProjectRoot = $ProjectRoot
  Node = $node
  Config = $configPath
  StartedTask = [bool]$CreateTasks
} | ConvertTo-Json
