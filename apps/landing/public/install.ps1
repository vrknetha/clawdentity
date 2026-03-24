$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$BinaryName = "clawdentity.exe"
$DefaultDownloadsBaseUrl = "https://downloads.clawdentity.com"
$DefaultSiteBaseUrl = "https://clawdentity.com"

$DryRun = $env:CLAWDENTITY_INSTALL_DRY_RUN -eq "1"
$NoVerify = $env:CLAWDENTITY_NO_VERIFY -eq "1"
$VersionInput = $env:CLAWDENTITY_VERSION
$InstallDir = $env:CLAWDENTITY_INSTALL_DIR
$DownloadsBaseUrl = $env:CLAWDENTITY_DOWNLOADS_BASE_URL
$ManifestUrlInput = $env:CLAWDENTITY_RELEASE_MANIFEST_URL
$SiteBaseUrlInput = $env:CLAWDENTITY_SITE_BASE_URL
$SkillUrlInput = $env:CLAWDENTITY_SKILL_URL

$script:Tag = ""
$script:Version = ""
$script:AssetBaseUrl = ""
$script:ChecksumsUrl = ""

function Write-Info {
  param([string]$Message)
  Write-Host "clawdentity installer: $Message"
}

function Write-WarnLine {
  param([string]$Message)
  Write-Warning "clawdentity installer: $Message"
}

function Fail {
  param([string]$Message)
  throw "clawdentity installer: $Message"
}

function Trim-TrailingSlash {
  param([string]$Value)

  return $Value.TrimEnd("/")
}

function Resolve-ManifestUrl {
  if (-not [string]::IsNullOrWhiteSpace($ManifestUrlInput)) {
    return $ManifestUrlInput
  }

  $baseUrl = if ([string]::IsNullOrWhiteSpace($DownloadsBaseUrl)) {
    $DefaultDownloadsBaseUrl
  }
  else {
    $DownloadsBaseUrl
  }

  return "$(Trim-TrailingSlash $baseUrl)/rust/latest.json"
}

function Resolve-LatestReleaseInfo {
  $manifestUri = Resolve-ManifestUrl
  if ($DryRun) {
    Write-Info "resolving latest release from $manifestUri"
  }

  $manifest = Invoke-RestMethod -Uri $manifestUri
  if ([string]::IsNullOrWhiteSpace($manifest.version)) {
    Fail "release manifest is missing version"
  }
  if ([string]::IsNullOrWhiteSpace($manifest.tag)) {
    Fail "release manifest is missing tag"
  }
  if ([string]::IsNullOrWhiteSpace($manifest.assetBaseUrl)) {
    Fail "release manifest is missing assetBaseUrl"
  }
  if ([string]::IsNullOrWhiteSpace($manifest.checksumsUrl)) {
    Fail "release manifest is missing checksumsUrl"
  }

  $script:Version = $manifest.version.Trim()
  $script:Tag = $manifest.tag.Trim()
  $script:AssetBaseUrl = $manifest.assetBaseUrl.Trim()
  $script:ChecksumsUrl = $manifest.checksumsUrl.Trim()
}

function Resolve-SkillUrl {
  if (-not [string]::IsNullOrWhiteSpace($SkillUrlInput)) {
    return $SkillUrlInput.Trim()
  }

  $siteBaseUrl = if ([string]::IsNullOrWhiteSpace($SiteBaseUrlInput)) {
    $DefaultSiteBaseUrl
  }
  else {
    $SiteBaseUrlInput
  }

  return "$(Trim-TrailingSlash $siteBaseUrl)/skill.md"
}

function Set-VersionInfo {
  param([string]$InputVersion)

  if ($InputVersion.StartsWith("rust/v")) {
    $script:Tag = $InputVersion
    $script:Version = $InputVersion.Substring(6)
    return
  }

  if ($InputVersion.StartsWith("v")) {
    $script:Version = $InputVersion.Substring(1)
    $script:Tag = "rust/v$($script:Version)"
    return
  }

  $script:Version = $InputVersion
  $script:Tag = "rust/v$($script:Version)"
}

function Invoke-Download {
  param(
    [string]$Url,
    [string]$OutFile
  )

  if ($DryRun) {
    Write-Info "[dry-run] download $Url -> $OutFile"
    return
  }

  Invoke-WebRequest -Uri $Url -OutFile $OutFile
}

function Get-ChecksumForAsset {
  param(
    [string]$ChecksumsPath,
    [string]$AssetName
  )

  $line = Get-Content -Path $ChecksumsPath |
    Where-Object {
      $parts = $_ -split "\s+", 2
      if ($parts.Count -lt 2) {
        return $false
      }

      $fileName = $parts[1].Trim().TrimStart("*")
      return $fileName -eq $AssetName
    } |
    Select-Object -First 1

  if ([string]::IsNullOrWhiteSpace($line)) {
    return $null
  }

  return ($line -split "\s+", 2)[0].Trim().ToLowerInvariant()
}

$isWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindowsPlatform) {
  Fail "install.ps1 supports Windows only"
}

$platform = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
  "X64" { "windows-x86_64" }
  "Arm64" { "windows-aarch64" }
  default { Fail "unsupported architecture: $($_.ToString()) (supported: X64, Arm64)" }
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Join-Path $HOME "bin"
}

if (-not [string]::IsNullOrWhiteSpace($VersionInput)) {
  Set-VersionInfo -InputVersion $VersionInput
  $baseUrl = if ([string]::IsNullOrWhiteSpace($DownloadsBaseUrl)) {
    $DefaultDownloadsBaseUrl
  }
  else {
    $DownloadsBaseUrl
  }
  $script:AssetBaseUrl = "$(Trim-TrailingSlash $baseUrl)/rust/v$Version"
  $script:ChecksumsUrl = "$script:AssetBaseUrl/clawdentity-$Version-checksums.txt"
}
else {
  Resolve-LatestReleaseInfo
}

$assetName = "clawdentity-$Version-$platform.zip"
$checksumName = "clawdentity-$Version-checksums.txt"
$assetUrl = "$script:AssetBaseUrl/$assetName"
$checksumUrl = $script:ChecksumsUrl
$targetPath = Join-Path $InstallDir $BinaryName
$skillUrl = Resolve-SkillUrl

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("clawdentity-" + [Guid]::NewGuid().ToString("N"))
$assetPath = Join-Path $tempDir $assetName
$checksumPath = Join-Path $tempDir $checksumName
$extractDir = Join-Path $tempDir "extract"

Write-Info "tag: $Tag"
Write-Info "platform: $platform"
Write-Info "install dir: $InstallDir"
Write-Info "download: $assetUrl"

try {
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  }

  Invoke-Download -Url $assetUrl -OutFile $assetPath

  if ($NoVerify) {
    Write-WarnLine "checksum verification disabled (CLAWDENTITY_NO_VERIFY=1)"
  }
  else {
    Invoke-Download -Url $checksumUrl -OutFile $checksumPath

    if ($DryRun) {
      Write-Info "[dry-run] would verify SHA256 for $assetName"
    }
    else {
      $expected = Get-ChecksumForAsset -ChecksumsPath $checksumPath -AssetName $assetName
      if ([string]::IsNullOrWhiteSpace($expected)) {
        Fail "could not find checksum for $assetName in $checksumName"
      }

      $actual = (Get-FileHash -Path $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $expected) {
        Fail "checksum mismatch for $assetName"
      }
      Write-Info "checksum verified"
    }
  }

  if ($DryRun) {
    Write-Info "[dry-run] expand archive '$assetPath' -> '$extractDir'"
    Write-Info "[dry-run] install binary to '$targetPath'"
    Write-Info "[dry-run] next step: use the onboarding prompt in $skillUrl"
    Write-Info "[dry-run] complete"
    exit 0
  }

  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Expand-Archive -Path $assetPath -DestinationPath $extractDir -Force

  $binary = Get-ChildItem -Path $extractDir -Filter $BinaryName -File -Recurse | Select-Object -First 1
  if ($null -eq $binary) {
    Fail "could not find $BinaryName inside $assetName"
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item -Path $binary.FullName -Destination $targetPath -Force

  Write-Info "installed $BinaryName to $targetPath"
  Write-Info "next step: use the onboarding prompt in $skillUrl"

  $pathEntries = $env:Path -split ";"
  $normalizedInstall = $InstallDir.TrimEnd("\")
  $hasPathEntry = $pathEntries |
    Where-Object { $_.TrimEnd("\") -ieq $normalizedInstall } |
    Select-Object -First 1

  if ($null -eq $hasPathEntry) {
    Write-WarnLine "$InstallDir is not on PATH; add it to your user PATH to run clawdentity globally"
  }
}
finally {
  if (-not $DryRun -and (Test-Path -Path $tempDir)) {
    Remove-Item -Path $tempDir -Recurse -Force
  }
}
