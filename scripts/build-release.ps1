<#
Builds everything a release needs into release/:
  patcher.js, preload.js, renderer.js, renderer.css   Vencord (standalone) with the BBStream plugin
  BBStreamSetup.exe                                   the installer
  StreamerV2-win-x64.zip, streamer-version.txt        copied from -StreamerZip (built in the StreamerV2 repo)

The Vencord build reports this repo as its origin and this commit as its version, so Vencord's
own updater pulls new builds from this repo's latest release. Commit first: the release must be
named "... <short hash>" of a commit that is on GitHub.

  ./scripts/build-release.ps1 -StreamerZip path\to\StreamerV2-win-x64.zip -StreamerVersion 2026.10.27
  gh release create v0.1 --title "BBStream v0.1 <hash>" release/*
#>
[CmdletBinding()]
param(
    [string]$Vencord = (Join-Path $PSScriptRoot "..\.build\Vencord"),
    [string]$VencordRef = "v1.15.13",
    [string]$StreamerZip = "",
    [string]$StreamerVersion = ""
)

$ErrorActionPreference = "Stop"
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$out = Join-Path $repo "release"

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if (git -C $repo status --porcelain) { throw "Commit your changes first: the build is stamped with the current commit." }
$hash = (git -C $repo rev-parse --short HEAD).Trim()
New-Item -ItemType Directory -Force $out | Out-Null

# Vencord, pinned to a release so builds are reproducible.
$Vencord = [IO.Path]::GetFullPath($Vencord)
if (-not (Test-Path (Join-Path $Vencord "package.json"))) {
    Invoke-Checked git @("clone", "--depth", "1", "--branch", $VencordRef, "https://github.com/Vendicated/Vencord.git", $Vencord)
}
Push-Location $Vencord
try {
    if (-not (Test-Path "node_modules")) { Invoke-Checked pnpm @("install", "--frozen-lockfile") }

    # The plugin goes in as a userplugin. A copy, not a link: esbuild resolves links to their real
    # path, where Vencord's import aliases (@api, @webpack, …) don't apply.
    $plugin = Join-Path $Vencord "src\userplugins\bbStream"
    if (Test-Path $plugin) { Remove-Item $plugin -Recurse -Force }
    Copy-Item (Join-Path $repo "plugin\bbStream") $plugin -Recurse

    $env:VENCORD_REMOTE = "master0022/bbstream"
    $env:VENCORD_HASH = $hash
    Invoke-Checked pnpm @("build", "--standalone")
    foreach ($file in "patcher.js", "preload.js", "renderer.js", "renderer.css") {
        Copy-Item (Join-Path $Vencord "dist\$file") $out -Force
    }
} finally {
    Remove-Item Env:VENCORD_REMOTE, Env:VENCORD_HASH -ErrorAction SilentlyContinue
    Pop-Location
}

Invoke-Checked dotnet @("build", (Join-Path $repo "installer\BBStreamSetup.csproj"), "-c", "Release", "-o", (Join-Path $out "installer"))
Copy-Item (Join-Path $out "installer\BBStreamSetup.exe") $out -Force

if ($StreamerZip) {
    if (-not $StreamerVersion) { throw "-StreamerVersion is required with -StreamerZip (the installer re-downloads StreamerV2 only when it changes)." }
    if ((Resolve-Path $StreamerZip).Path -ne (Join-Path $out "StreamerV2-win-x64.zip")) {
        Copy-Item $StreamerZip (Join-Path $out "StreamerV2-win-x64.zip") -Force
    }
    Set-Content -NoNewline -Encoding ascii (Join-Path $out "streamer-version.txt") $StreamerVersion
}

Write-Host "Built $hash into $out. Release title must end with: $hash"
