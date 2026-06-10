param(
  [string]$PackageName,

  [string]$OutputDir,

  [switch]$IncludeExistingDist,

  [switch]$BuildWinX64,

  [string[]]$PkgFetchMirror,

  [switch]$KeepStage
)

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseDir = if ($OutputDir) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDir) } else { Join-Path $root "release" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$defaultName = if ($BuildWinX64) {
  "chaoxing-weixin-study-helper-win-x64-$stamp"
} elseif ($IncludeExistingDist) {
  "chaoxing-weixin-study-helper-with-dist-$stamp"
} else {
  "chaoxing-weixin-study-helper-source-$stamp"
}
$name = if ($PackageName) { $PackageName } else { $defaultName }
$stage = Join-Path $releaseDir $name
$zip = "$stage.zip"
$nativeDir = Join-Path $root "native-host"
$defaultPkgFetchMirrors = @(
  "https://ghfast.top/",
  "https://raw.ihtw.moe/",
  "https://ghproxy.vip/",
  "https://gh.zwy.one/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
  "https://mirror.ghproxy.com/"
)

function Assert-InRoot {
  param(
    [string]$Path,
    [string]$Base
  )

  $resolvedBase = [IO.Path]::GetFullPath($Base)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to touch path outside expected directory: $resolvedPath"
  }
}

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-PkgFetchMirrors {
  if ($PkgFetchMirror -and $PkgFetchMirror.Count -gt 0) {
    return $PkgFetchMirror
  }

  if ($env:PKG_FETCH_MIRRORS) {
    return $env:PKG_FETCH_MIRRORS -split "[,;]" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }
  }

  return $defaultPkgFetchMirrors
}

function Get-PkgCacheDir {
  if ($env:PKG_CACHE_PATH) {
    return $env:PKG_CACHE_PATH
  }
  return Join-Path $HOME ".pkg-cache"
}

function Invoke-NodeCheck {
  if (-not (Test-CommandExists "node")) {
    Write-Warning "Node.js was not found; skipping JavaScript syntax checks."
    return
  }

  $jsFiles = @(
    (Join-Path $root "extension\background\background.js"),
    (Join-Path $root "extension\popup\popup.js"),
    (Join-Path $nativeDir "host.mjs"),
    (Join-Path $nativeDir "src\host.mjs")
  )
  $jsFiles += Get-ChildItem (Join-Path $root "extension\content") -Filter "*.js" | Select-Object -ExpandProperty FullName

  foreach ($file in $jsFiles) {
    & node --check $file | Out-Null
  }
}

function Invoke-JsonCheck {
  $jsonFiles = @(
    (Join-Path $root "extension\manifest.json"),
    (Join-Path $nativeDir "package.json"),
    (Join-Path $nativeDir "package-lock.json")
  )

  if (Test-CommandExists "node") {
    foreach ($file in $jsonFiles) {
      & node -e "const fs=require('fs'); JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));" $file
    }
    return
  }

  foreach ($file in $jsonFiles) {
    if ((Split-Path $file -Leaf) -eq "package-lock.json") {
      Get-Content $file -Raw -Encoding UTF8 | Out-Null
      continue
    }
    Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
  }
}

function Copy-ProjectItem {
  param(
    [string]$RelativePath
  )

  $source = Join-Path $root $RelativePath
  if (-not (Test-Path $source)) {
    throw "Required package item not found: $source"
  }
  Copy-Item -LiteralPath $source -Destination $stage -Recurse -Force
}

function Copy-NativeHost {
  $target = Join-Path $stage "native-host"
  New-Item -ItemType Directory -Force -Path $target | Out-Null

  foreach ($item in @(
    "host.mjs",
    "package.json",
    "package-lock.json",
    "run-host.cmd",
    "run-host.sh",
    "com.audio_check.weixin_monitor.chrome.json",
    "com.audio_check.weixin_monitor.edge.json"
  )) {
    Copy-Item -LiteralPath (Join-Path $nativeDir $item) -Destination $target -Force
  }

  Copy-Item -LiteralPath (Join-Path $nativeDir "src") -Destination $target -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $nativeDir "scripts") -Destination $target -Recurse -Force

  $dist = Join-Path $nativeDir "dist"
  if ($IncludeExistingDist -and (Test-Path $dist)) {
    Copy-Item -LiteralPath $dist -Destination $target -Recurse -Force
  }
}

function Remove-PackageExclusions {
  $patterns = @(
    "node_modules",
    ".state",
    ".git"
  )

  Get-ChildItem -LiteralPath $stage -Recurse -Force -Directory | Where-Object {
    $patterns -contains $_.Name
  } | Sort-Object FullName -Descending | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }

  Get-ChildItem -LiteralPath $stage -Recurse -Force -File | Where-Object {
    $_.Name -like "*.generated.json"
  } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
  }
}

function New-RootExtensionManifest {
  $sourceManifestPath = Join-Path $stage "extension\manifest.json"
  $rootManifestPath = Join-Path $stage "manifest.json"
  $manifest = Get-Content $sourceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

  if ($manifest.background.service_worker) {
    $manifest.background.service_worker = "extension/$($manifest.background.service_worker)"
  }

  foreach ($script in $manifest.content_scripts) {
    $prefixed = @()
    foreach ($js in $script.js) {
      $prefixed += "extension/$js"
    }
    $script.js = $prefixed
  }

  if ($manifest.action.default_popup) {
    $manifest.action.default_popup = "extension/$($manifest.action.default_popup)"
  }

  $manifest.description = "$($manifest.description) Packaged root manifest; loading this folder or the extension folder both work."
  $json = $manifest | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($rootManifestPath, $json, $utf8NoBom)
}

function Invoke-BuildWinX64 {
  Ensure-PkgBaseBinaryWinX64

  Push-Location $nativeDir
  try {
    npm run build:win:x64
  }
  finally {
    Pop-Location
  }

  $exe = Join-Path $nativeDir "dist\win-x64\chaoxing-weixin-native-host.exe"
  if (-not (Test-Path $exe)) {
    throw "Windows x64 native host build finished without expected output: $exe"
  }
}

function Invoke-FileDownload {
  param(
    [string]$Url,
    [string]$OutFile
  )

  if (Test-CommandExists "curl.exe") {
    & curl.exe --fail --location --retry 5 --retry-delay 2 --connect-timeout 30 --max-time 900 --output $OutFile $Url
    if ($LASTEXITCODE -ne 0) {
      throw "curl failed with exit code $LASTEXITCODE"
    }
    return
  }

  Invoke-WebRequest -Uri $Url -OutFile $OutFile -MaximumRedirection 8 -TimeoutSec 900 -UseBasicParsing
}

function Ensure-PkgBaseBinaryWinX64 {
  $pkgFetchTag = "v3.6"
  $nodeBinaryName = "node-v22.22.3-win-x64"
  $cacheFileName = "fetched-v22.22.3-win-x64"
  $expectedHash = "3abbf32d427ea9ffcce92f8c9727daa02ab7e967c5e475ed22854a1bea8cdebb"
  $minimumBytes = 50MB
  $githubUrl = "https://github.com/yao-pkg/pkg-fetch/releases/download/$pkgFetchTag/$nodeBinaryName"
  $cacheDir = Join-Path (Get-PkgCacheDir) $pkgFetchTag
  $cacheFile = Join-Path $cacheDir $cacheFileName
  $downloadFile = "$cacheFile.downloading"

  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

  if (Test-Path $cacheFile) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $cacheFile).Hash.ToLowerInvariant()
    if ($hash -eq $expectedHash) {
      Write-Host "pkg base binary already exists in cache:"
      Write-Host "  $cacheFile"
      return
    }

    Write-Warning "Cached pkg base binary hash mismatch; deleting and re-downloading."
    Remove-Item -LiteralPath $cacheFile -Force
  }

  Remove-Item -LiteralPath $downloadFile -Force -ErrorAction SilentlyContinue

  $urls = @()
  foreach ($mirror in Get-PkgFetchMirrors) {
    $prefix = $mirror.Trim()
    if (-not $prefix) {
      continue
    }
    if (-not $prefix.EndsWith("/")) {
      $prefix = "$prefix/"
    }
    $urls += "$prefix$githubUrl"
  }
  $urls += $githubUrl

  $errors = @()
  foreach ($url in $urls) {
    Write-Host "Downloading pkg base binary:"
    Write-Host "  $url"
    try {
      Invoke-FileDownload -Url $url -OutFile $downloadFile
      $downloaded = Get-Item -LiteralPath $downloadFile
      if ($downloaded.Length -lt $minimumBytes) {
        throw "downloaded file is too small ($($downloaded.Length) bytes), probably an error page"
      }
      $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadFile).Hash.ToLowerInvariant()
      if ($hash -ne $expectedHash) {
        throw "SHA256 mismatch: expected $expectedHash, got $hash"
      }
      Move-Item -LiteralPath $downloadFile -Destination $cacheFile -Force
      Write-Host "Cached pkg base binary:"
      Write-Host "  $cacheFile"
      return
    }
    catch {
      $errors += "$url -> $($_.Exception.Message)"
      Remove-Item -LiteralPath $downloadFile -Force -ErrorAction SilentlyContinue
      Write-Warning "Download failed: $($_.Exception.Message)"
    }
  }

  throw "Unable to download pkg base binary from configured mirrors. Tried: $($errors -join ' | ')"
}

if ($BuildWinX64) {
  if (-not (Test-CommandExists "npm")) {
    throw "npm was not found. Install Node.js 22 or newer before building native host binaries."
  }
  Invoke-BuildWinX64
  $IncludeExistingDist = $true
}

Invoke-JsonCheck
Invoke-NodeCheck

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

if (Test-Path $stage) {
  Assert-InRoot -Path $stage -Base $releaseDir
  Remove-Item -LiteralPath $stage -Recurse -Force
}
if (Test-Path $zip) {
  Assert-InRoot -Path $zip -Base $releaseDir
  Remove-Item -LiteralPath $zip -Force
}

New-Item -ItemType Directory -Force -Path $stage | Out-Null

foreach ($item in @("extension", "scripts", "docs", "install.cmd", "install.sh", "README.md", "package.cmd", "package-source.cmd")) {
  Copy-ProjectItem -RelativePath $item
}
Copy-NativeHost
Remove-PackageExclusions
New-RootExtensionManifest

Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $zip
$entryCount = 0
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entryCount = $archive.Entries.Count
  $badEntries = $archive.Entries | Where-Object { $_.FullName -match "node_modules|\.state|generated\.json|/\.git|\\\.git" }
  if ($badEntries) {
    throw "Package contains excluded entries: $($badEntries.FullName -join ', ')"
  }
}
finally {
  $archive.Dispose()
}

if (-not $KeepStage) {
  Assert-InRoot -Path $stage -Base $releaseDir
  Remove-Item -LiteralPath $stage -Recurse -Force
}

Write-Host ""
Write-Host "Package created:"
Write-Host "  $zip"
Write-Host "Size:"
Write-Host "  $([Math]::Round((Get-Item $zip).Length / 1MB, 3)) MB"
Write-Host "SHA256:"
Write-Host "  $($hash.Hash)"
Write-Host "Entries:"
Write-Host "  $entryCount"

if (-not $IncludeExistingDist) {
  Write-Host ""
  Write-Host "Note: this is a source package. The target machine needs Node.js 22+ and npm; install.cmd will run npm install."
}
