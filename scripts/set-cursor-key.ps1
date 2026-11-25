param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$dataDir = Join-Path $ProjectRoot "data"
$keyPath = Join-Path $dataDir "cursor-api-key.txt"
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$secureKey = Read-Host "Paste the Cursor API key" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ([string]::IsNullOrWhiteSpace($key)) {
    throw "The Cursor API key is empty"
  }
  [IO.File]::WriteAllText($keyPath, $key.Trim() + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $key = $null
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $keyPath /inheritance:r /grant:r "${identity}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to restrict access to $keyPath"
}

[pscustomobject]@{
  KeyFile = $keyPath
  RestrictedTo = $identity
} | ConvertTo-Json
