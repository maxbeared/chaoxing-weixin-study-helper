param(
  [string]$ExtensionId,

  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "Chrome",

  [string]$HostPath,

  [switch]$SkipNpmInstall,

  [switch]$Edge
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$extensionManifest = Join-Path $root "extension\manifest.json"
$nativeDir = Join-Path $root "native-host"
$hostRunner = if ($HostPath) { $HostPath } else { Join-Path $nativeDir "run-host.cmd" }

function Get-ExtensionIdFromManifestKey {
  param([string]$ManifestPath)

  if (-not (Test-Path $ManifestPath)) {
    throw "Extension manifest not found: $ManifestPath"
  }

  $manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $manifest.key) {
    throw "Extension manifest has no key. Pass -ExtensionId manually or add a stable manifest key."
  }

  $keyBytes = [Convert]::FromBase64String($manifest.key)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($keyBytes)
  }
  finally {
    $sha.Dispose()
  }

  $chars = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt 16; $i++) {
    [void]$chars.Append([char](97 + (($hash[$i] -shr 4) -band 15)))
    [void]$chars.Append([char](97 + ($hash[$i] -band 15)))
  }
  $chars.ToString()
}

if (-not (Test-Path $hostRunner)) {
  throw "Native host runner not found: $hostRunner"
}

if ($Edge) {
  $Browser = "Edge"
}

if (-not $ExtensionId) {
  $ExtensionId = Get-ExtensionIdFromManifestKey -ManifestPath $extensionManifest
}

if (-not $SkipNpmInstall) {
  Push-Location $nativeDir
  try {
    npm install
  }
  finally {
    Pop-Location
  }
}

function Register-NativeHost {
  param(
    [ValidateSet("Chrome", "Edge")]
    [string]$TargetBrowser
  )

  $templateName = if ($TargetBrowser -eq "Edge") { "com.audio_check.weixin_monitor.edge.json" } else { "com.audio_check.weixin_monitor.chrome.json" }
  $templatePath = Join-Path $nativeDir $templateName
  $manifestPath = Join-Path $nativeDir "com.audio_check.weixin_monitor.$($TargetBrowser.ToLowerInvariant()).generated.json"

  $resolvedHostPath = (Resolve-Path $hostRunner).Path
  $escapedHostPath = $resolvedHostPath.Replace("\", "\\")
  $content = Get-Content $templatePath -Raw -Encoding UTF8
  $content = $content.Replace("__HOST_PATH__", $escapedHostPath).Replace("__EXTENSION_ID__", $ExtensionId)
  Set-Content -Path $manifestPath -Value $content -Encoding UTF8

  $browserKey = if ($TargetBrowser -eq "Edge") {
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.audio_check.weixin_monitor"
  } else {
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.audio_check.weixin_monitor"
  }

  New-Item -Path $browserKey -Force | Out-Null
  Set-ItemProperty -Path $browserKey -Name "(default)" -Value $manifestPath

  Write-Host "Registered native host for $($TargetBrowser):"
  Write-Host "  $browserKey"
  Write-Host "  $manifestPath"
}

$targets = if ($Browser -eq "All") { @("Chrome", "Edge") } else { @($Browser) }
foreach ($target in $targets) {
  Register-NativeHost -TargetBrowser $target
}

Write-Host ""
Write-Host "Extension ID: $ExtensionId"
