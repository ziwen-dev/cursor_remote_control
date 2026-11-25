$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "选择 Cursor 工作区文件夹"
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  @{ cancelled = $false; path = $dialog.SelectedPath } | ConvertTo-Json -Compress
} else {
  @{ cancelled = $true; path = $null } | ConvertTo-Json -Compress
}
