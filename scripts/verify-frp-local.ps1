param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BridgeUrl = "http://127.0.0.1:7419/health"
)

$ErrorActionPreference = "Stop"
$frpc = Join-Path $ProjectRoot "bin\frpc.exe"
$frpsFile = Get-ChildItem -Path (Join-Path $ProjectRoot "vendor") -Recurse -Filter "frps.exe" |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not (Test-Path -LiteralPath $frpc)) { throw "Missing frpc: $frpc" }
if (-not $frpsFile) { throw "Missing frps.exe under $ProjectRoot\vendor" }
$frps = $frpsFile.FullName

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

$runDir = Join-Path $ProjectRoot ("data\frp-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $runDir -Force | Out-Null
$controlPort = Get-FreePort
$vhostPort = Get-FreePort
$tokenBytes = New-Object byte[] 32
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
$token = ($tokenBytes | ForEach-Object { $_.ToString("x2") }) -join ""
$frpsConfig = Join-Path $runDir "frps.toml"
$frpcConfig = Join-Path $runDir "frpc.toml"
$domain = "cursor-bridge.test"

@"
bindAddr = "127.0.0.1"
bindPort = $controlPort
vhostHTTPPort = $vhostPort
auth.method = "token"
auth.token = "$token"
transport.tls.force = true
"@ | ForEach-Object { Write-Utf8NoBom $frpsConfig $_ }

@"
serverAddr = "127.0.0.1"
serverPort = $controlPort
auth.method = "token"
auth.token = "$token"
transport.tls.enable = true

[[proxies]]
name = "cursor-bridge-local-smoke"
type = "http"
localIP = "127.0.0.1"
localPort = 7419
customDomains = ["$domain"]
"@ | ForEach-Object { Write-Utf8NoBom $frpcConfig $_ }

& $frps verify -c $frpsConfig | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Generated frps configuration is invalid" }
& $frpc verify -c $frpcConfig | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Generated frpc configuration is invalid" }

$frpsProcess = $null
$frpcProcess = $null
try {
  $frpsProcess = Start-Process -FilePath $frps -ArgumentList @("-c", $frpsConfig) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runDir "frps.stdout.log") `
    -RedirectStandardError (Join-Path $runDir "frps.stderr.log")
  Start-Sleep -Milliseconds 300
  $frpcProcess = Start-Process -FilePath $frpc -ArgumentList @("-c", $frpcConfig) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runDir "frpc.stdout.log") `
    -RedirectStandardError (Join-Path $runDir "frpc.stderr.log")

  $deadline = (Get-Date).AddSeconds(15)
  $response = $null
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$vhostPort/health" `
        -Headers @{ Host = $domain } -TimeoutSec 2
    } catch {
      Start-Sleep -Milliseconds 300
    }
  } while (-not $response -and (Get-Date) -lt $deadline)

  if (-not $response) {
    throw "frp tunnel did not become reachable. Logs: $runDir"
  }
  $health = $response.Content | ConvertFrom-Json
  if (-not $health.ok) { throw "Bridge health check through frp failed" }

  [pscustomobject]@{
    Tunnel = "frpc -> frps -> HTTP vhost -> bridge"
    Domain = $domain
    ControlPort = $controlPort
    VhostPort = $vhostPort
    Runner = $health.runner
    LogDirectory = $runDir
  } | ConvertTo-Json
} finally {
  if ($frpcProcess -and -not $frpcProcess.HasExited) { $frpcProcess.Kill() }
  if ($frpsProcess -and -not $frpsProcess.HasExited) { $frpsProcess.Kill() }
}
