param(
  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "All",

  [switch]$SkipOpen
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$extensionDir = Join-Path $root "extension"
$nativeDir = Join-Path $root "native-host"
$registerScript = Join-Path $PSScriptRoot "register-native-host.ps1"

function Test-Tool {
  param(
    [string]$Name,
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found. $InstallHint"
  }
}

function Test-NodeVersion {
  Test-Tool -Name "node" -InstallHint "Install Node.js 22 or newer, then run install.cmd again: https://nodejs.org/"
  $version = (& node --version).Trim()
  if ($version -notmatch "^v?(\d+)") {
    throw "Unable to read Node.js version: $version"
  }
  $major = [int]$Matches[1]
  if ($major -lt 22) {
    throw "Node.js $version is too old. Install Node.js 22 or newer, then run install.cmd again."
  }
}

function Get-CurrentArchName {
  switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    "X64" { "x64"; break }
    "Arm64" { "arm64"; break }
    default { [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() }
  }
}

function Find-PackagedHost {
  $arch = Get-CurrentArchName
  $candidates = @(
    (Join-Path $nativeDir "dist\win-$arch\chaoxing-weixin-native-host.exe"),
    (Join-Path $nativeDir "dist\chaoxing-weixin-native-host.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }
  return ""
}

function Get-ExtensionId {
  $manifestPath = Join-Path $extensionDir "manifest.json"
  $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
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

function Open-BrowserExtensionsPage {
  param(
    [ValidateSet("Chrome", "Edge")]
    [string]$TargetBrowser
  )

  $exe = if ($TargetBrowser -eq "Edge") { "msedge.exe" } else { "chrome.exe" }
  $url = if ($TargetBrowser -eq "Edge") { "edge://extensions" } else { "chrome://extensions" }

  try {
    Start-Process -FilePath $exe -ArgumentList $url
    Write-Host "Opened $TargetBrowser extensions page."
  }
  catch {
    Write-Host "Could not open $TargetBrowser automatically. Open this page manually: $url"
  }
}

$hostPath = Find-PackagedHost

if ($hostPath) {
  Write-Host "Using packaged native host:"
  Write-Host "  $hostPath"
  Write-Host "Registering browser native messaging..."
  & $registerScript -Browser $Browser -HostPath $hostPath -SkipNpmInstall
} else {
  Write-Host "Packaged native host was not found. Falling back to development mode with Node.js."
  Test-NodeVersion
  Test-Tool -Name "npm" -InstallHint "Install Node.js 22 or newer, then run install.cmd again: https://nodejs.org/"
  Write-Host "Installing native host dependencies and registering browser native messaging..."
  & $registerScript -Browser $Browser
}

$extensionId = Get-ExtensionId

if (-not $SkipOpen) {
  $targets = if ($Browser -eq "All") { @("Chrome", "Edge") } else { @($Browser) }
  foreach ($target in $targets) {
    Open-BrowserExtensionsPage -TargetBrowser $target
  }

  try {
    Set-Clipboard -Value $extensionDir
    Write-Host "Copied extension folder path to clipboard."
  }
  catch {
    Write-Host "Extension folder path: $extensionDir"
  }

  Start-Process -FilePath "explorer.exe" -ArgumentList "`"$extensionDir`""
}

Write-Host ""
Write-Host "Install finished."
Write-Host "Extension ID: $extensionId"
Write-Host "Extension folder: $extensionDir"
Write-Host ""
Write-Host "If the browser extension is not loaded yet:"
Write-Host "  1. Enable Developer mode on the extensions page."
Write-Host "  2. Click Load unpacked."
Write-Host "  3. Select the extension folder shown above."
