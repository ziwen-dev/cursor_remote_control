param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$Workspace = $ProjectRoot
)

$ErrorActionPreference = "Stop"
$token = (Get-Content -LiteralPath (Join-Path $ProjectRoot "data\api-token.txt") -Raw).Trim()
$headers = @{ Authorization = "Bearer $token" }
$health = Invoke-RestMethod -Uri "http://127.0.0.1:7419/health"
if (-not $health.ok) { throw "Bridge health check failed" }

$body = @{
  workspace = $Workspace
  prompt = "Cursor Remote Bridge local verification " + [DateTime]::UtcNow.ToString("O")
  timeoutSeconds = 120
  idempotencyKey = [guid]::NewGuid().ToString()
} | ConvertTo-Json
$created = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7419/v1/jobs" -Headers $headers -ContentType "application/json" -Body $body
$jobId = $created.job.id
$deadline = (Get-Date).AddSeconds(130)
do {
  Start-Sleep -Milliseconds 500
  $job = (Invoke-RestMethod -Uri "http://127.0.0.1:7419/v1/jobs/$jobId" -Headers $headers).job
} while ($job.status -in @("queued", "running") -and (Get-Date) -lt $deadline)

[pscustomobject]@{
  Runner = $health.runner
  JobId = $jobId
  Status = $job.status
  ExitCode = $job.exitCode
  Artifacts = $job.artifacts -join ","
  RunDirectory = (Join-Path $ProjectRoot "data\jobs\$jobId")
} | ConvertTo-Json

if ($job.status -ne "succeeded") {
  throw "Verification job did not succeed"
}
