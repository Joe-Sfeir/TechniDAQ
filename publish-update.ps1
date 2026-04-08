#Requires -Version 5.1
<#
.SYNOPSIS
    One-command OTA publish script for TechniDAQ.
    Run AFTER: pnpm tauri build --features cloud_sync
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─────────────────────────────────────────────
# STEP 1 — Read version
# ─────────────────────────────────────────────
$confPath = Join-Path $PSScriptRoot 'src-tauri\tauri.conf.json'
if (-not (Test-Path $confPath)) {
    Write-Error "tauri.conf.json not found at: $confPath"
    exit 1
}
$conf    = Get-Content $confPath -Raw | ConvertFrom-Json
$version = $conf.version

Write-Host ""
Write-Host "Publishing v$version — continue? (Y/N)" -ForegroundColor Cyan -NoNewline
Write-Host " " -NoNewline
$confirm = Read-Host
if ($confirm -notmatch '^[Yy]$') {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
}

# ─────────────────────────────────────────────
# STEP 2 — Locate build artifacts
# ─────────────────────────────────────────────
$nsisDir = Join-Path $PSScriptRoot 'src-tauri\target\release\bundle\nsis'

$exeFile = Get-ChildItem -Path $nsisDir -Filter '*setup.exe' -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -match '[-_]setup\.exe$' } |
           Select-Object -First 1

$sigFile = if ($exeFile) {
    Get-Item -Path "$($exeFile.FullName).sig" -ErrorAction SilentlyContinue
} else { $null }

if (-not $exeFile -or -not $sigFile) {
    Write-Host ""
    Write-Host "ERROR: Build artifacts not found." -ForegroundColor Red
    Write-Host "Did you run: pnpm tauri build --features cloud_sync?" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Installer : $($exeFile.Name)" -ForegroundColor DarkGray
Write-Host "  Signature : $($sigFile.Name)" -ForegroundColor DarkGray

# ─────────────────────────────────────────────
# STEP 3 — Read signature
# ─────────────────────────────────────────────
$signature = (Get-Content $sigFile.FullName -Raw).Trim()

# ─────────────────────────────────────────────
# STEP 4 — Prompt for release notes
# ─────────────────────────────────────────────
Write-Host ""
Write-Host "Enter release notes (or press Enter for default):" -ForegroundColor Cyan
$notes = Read-Host
if ([string]::IsNullOrWhiteSpace($notes)) {
    $notes = "TechniDAQ v$version"
}

# ─────────────────────────────────────────────
# STEP 5 — Generate latest.json
# ─────────────────────────────────────────────
$pubDate    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$exeName    = $exeFile.Name
$downloadUrl = "https://github.com/Joe-Sfeir/TechniDAQ/releases/download/v$version/$exeName"

$latestJson = [ordered]@{
    version  = $version
    notes    = $notes
    pub_date = $pubDate
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url       = $downloadUrl
        }
    }
} | ConvertTo-Json -Depth 5

$latestJsonPath = Join-Path $PSScriptRoot 'latest.json'
Set-Content -Path $latestJsonPath -Value $latestJson -Encoding UTF8
Write-Host ""
Write-Host "  latest.json written." -ForegroundColor DarkGray

# ─────────────────────────────────────────────
# Helper — resolve GitHub token
# ─────────────────────────────────────────────
function Get-GithubToken {
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }

    $tokenFile = Join-Path $HOME '.technidaq-github-token'
    if (Test-Path $tokenFile) {
        return (Get-Content $tokenFile -Raw).Trim()
    }

    Write-Host ""
    Write-Host "GitHub Personal Access Token not found." -ForegroundColor Yellow
    Write-Host "Enter your GitHub PAT (needs repo scope):" -ForegroundColor Cyan -NoNewline
    Write-Host " " -NoNewline
    $token = Read-Host

    Write-Host "Save token to $tokenFile for future use? (Y/N)" -ForegroundColor Cyan -NoNewline
    Write-Host " " -NoNewline
    $save = Read-Host
    if ($save -match '^[Yy]$') {
        Set-Content -Path $tokenFile -Value $token -Encoding UTF8
        Write-Host "  Token saved." -ForegroundColor DarkGray
    }
    return $token
}

# ─────────────────────────────────────────────
# Helper — resolve admin token
# ─────────────────────────────────────────────
function Get-AdminToken {
    if ($env:TECHNIDAQ_ADMIN_TOKEN) { return $env:TECHNIDAQ_ADMIN_TOKEN }

    $tokenFile = Join-Path $HOME '.technidaq-admin-token'
    if (Test-Path $tokenFile) {
        return (Get-Content $tokenFile -Raw).Trim()
    }

    Write-Host ""
    Write-Host "TechniDAQ admin JWT not found." -ForegroundColor Yellow
    Write-Host "Enter your MASTER JWT token:" -ForegroundColor Cyan -NoNewline
    Write-Host " " -NoNewline
    $token = Read-Host

    Write-Host "Save token to $tokenFile for future use? (Y/N)" -ForegroundColor Cyan -NoNewline
    Write-Host " " -NoNewline
    $save = Read-Host
    if ($save -match '^[Yy]$') {
        Set-Content -Path $tokenFile -Value $token -Encoding UTF8
        Write-Host "  Token saved." -ForegroundColor DarkGray
    }
    return $token
}

# ─────────────────────────────────────────────
# STEP 6 — Create GitHub Release and upload assets
# ─────────────────────────────────────────────
$ghToken = Get-GithubToken

$ghHeaders = @{
    Authorization  = "Bearer $ghToken"
    Accept         = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Write-Host ""
Write-Host "Creating GitHub release v$version ..." -ForegroundColor Cyan

$releaseBody = @{
    tag_name = "v$version"
    name     = "v$version"
    body     = $notes
    draft    = $false
    prerelease = $false
} | ConvertTo-Json

try {
    $release = Invoke-RestMethod `
        -Uri     'https://api.github.com/repos/Joe-Sfeir/TechniDAQ/releases' `
        -Method  POST `
        -Headers $ghHeaders `
        -Body    $releaseBody `
        -ContentType 'application/json'
} catch {
    Write-Host ""
    Write-Host "ERROR: Failed to create GitHub release." -ForegroundColor Red
    Write-Host ($_.ErrorDetails.Message) -ForegroundColor Red
    Remove-Item -Path $latestJsonPath -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "  Release created: $($release.html_url)" -ForegroundColor DarkGray

# Strip template suffix from upload_url
$uploadBase = $release.upload_url -replace '\{[^}]+\}', ''

# Upload installer .exe
Write-Host "Uploading installer ($exeName) ..." -ForegroundColor Cyan
try {
    Invoke-RestMethod `
        -Uri     "${uploadBase}?name=$([Uri]::EscapeDataString($exeName))" `
        -Method  POST `
        -Headers ($ghHeaders + @{ 'Content-Type' = 'application/octet-stream' }) `
        -InFile  $exeFile.FullName `
        | Out-Null
} catch {
    Write-Host ""
    Write-Host "ERROR: Failed to upload installer." -ForegroundColor Red
    Write-Host ($_.ErrorDetails.Message) -ForegroundColor Red
    Remove-Item -Path $latestJsonPath -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  Installer uploaded." -ForegroundColor DarkGray

# Upload latest.json
Write-Host "Uploading latest.json ..." -ForegroundColor Cyan
try {
    Invoke-RestMethod `
        -Uri     "${uploadBase}?name=latest.json" `
        -Method  POST `
        -Headers ($ghHeaders + @{ 'Content-Type' = 'application/octet-stream' }) `
        -InFile  $latestJsonPath `
        | Out-Null
} catch {
    Write-Host ""
    Write-Host "ERROR: Failed to upload latest.json." -ForegroundColor Red
    Write-Host ($_.ErrorDetails.Message) -ForegroundColor Red
    Remove-Item -Path $latestJsonPath -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "  latest.json uploaded." -ForegroundColor DarkGray

# ─────────────────────────────────────────────
# STEP 7 — Notify Cloud API
# ─────────────────────────────────────────────
$adminToken = Get-AdminToken

$cloudBody = @{
    version = $version
    notes   = $notes
    url     = $downloadUrl
} | ConvertTo-Json

Write-Host ""
Write-Host "Notifying cloud API ..." -ForegroundColor Cyan

try {
    Invoke-RestMethod `
        -Uri     'https://technicloudapi-production.up.railway.app/api/admin/publish-update' `
        -Method  POST `
        -Headers @{ Authorization = "Bearer $adminToken"; 'Content-Type' = 'application/json' } `
        -Body    $cloudBody `
        | Out-Null
    $cloudOk = $true
} catch {
    Write-Host ""
    Write-Host "WARNING: Cloud API notification failed (GitHub release is still live)." -ForegroundColor Yellow
    Write-Host ($_.ErrorDetails.Message) -ForegroundColor Yellow
    Write-Host "You can manually notify via the admin dashboard." -ForegroundColor Yellow
    $cloudOk = $false
}

# ─────────────────────────────────────────────
# Clean up local latest.json
# ─────────────────────────────────────────────
Remove-Item -Path $latestJsonPath -Force -ErrorAction SilentlyContinue

# ─────────────────────────────────────────────
# STEP 8 — Summary
# ─────────────────────────────────────────────
Write-Host ""
Write-Host "✅ Published TechniDAQ v$version" -ForegroundColor Green
Write-Host "   GitHub Release : https://github.com/Joe-Sfeir/TechniDAQ/releases/tag/v$version"
if ($cloudOk) {
    Write-Host "   Cloud API notified"
} else {
    Write-Host "   Cloud API       : ⚠ notification failed — notify manually via dashboard" -ForegroundColor Yellow
}
Write-Host "   Desktop apps will see the update on next ingest cycle"
Write-Host ""
