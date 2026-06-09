param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [switch]$Edge
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nativeDir = Join-Path $root "native-host"
$hostCmd = Join-Path $nativeDir "run-host.cmd"

if (-not (Test-Path $hostCmd)) {
  throw "Native host runner not found: $hostCmd"
}

Push-Location $nativeDir
try {
  npm install
}
finally {
  Pop-Location
}

$templateName = if ($Edge) { "com.audio_check.weixin_monitor.edge.json" } else { "com.audio_check.weixin_monitor.chrome.json" }
$templatePath = Join-Path $nativeDir $templateName
$manifestPath = Join-Path $nativeDir "com.audio_check.weixin_monitor.json"

$escapedHostPath = $hostCmd.Replace("\", "\\")
$content = Get-Content $templatePath -Raw
$content = $content.Replace("__HOST_PATH__", $escapedHostPath).Replace("__EXTENSION_ID__", $ExtensionId)
Set-Content -Path $manifestPath -Value $content -Encoding UTF8

$browserKey = if ($Edge) {
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.audio_check.weixin_monitor"
} else {
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.audio_check.weixin_monitor"
}

New-Item -Path $browserKey -Force | Out-Null
Set-ItemProperty -Path $browserKey -Name "(default)" -Value $manifestPath

Write-Host "Registered native host:"
Write-Host "  $browserKey"
Write-Host "  $manifestPath"
