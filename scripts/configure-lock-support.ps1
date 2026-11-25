param(
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

$before = [pscustomobject]@{
  StandbyAc = (& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Out-String)
  HibernateAc = (& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE | Out-String)
}

if ($Apply) {
  & powercfg.exe /change standby-timeout-ac 0
  if ($LASTEXITCODE -ne 0) { throw "Failed to disable AC standby timeout" }
  & powercfg.exe /change hibernate-timeout-ac 0
  if ($LASTEXITCODE -ne 0) { throw "Failed to disable AC hibernate timeout" }
}

$after = [pscustomobject]@{
  StandbyAc = (& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Out-String)
  HibernateAc = (& powercfg.exe /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE | Out-String)
}

[pscustomobject]@{
  Applied = [bool]$Apply
  Before = $before
  After = $after
} | ConvertTo-Json -Depth 3
