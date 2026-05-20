<#
.SYNOPSIS
    Constellation setup script - installs the MCP profile management extension for GitHub Copilot CLI.

.DESCRIPTION
    This script:
    1. Checks prerequisites (Copilot CLI version, Node.js)
    2. Copies extension.mjs to ~/.copilot/extensions/constellation/
    3. Optionally scans mcp-config.json and populates profiles.yaml + mcp-manifest.yaml
    4. Creates a default "lean" profile if profiles.yaml doesn't exist

.NOTES
    Platform: Windows (PowerShell 5.1+)
    Mac/Linux support is planned for a future release.
#>

param(
    [switch]$SkipScan,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  [*] Constellation - MCP Profile Manager for GitHub Copilot CLI" -ForegroundColor Cyan
Write-Host ""

# -- Prerequisites -------------------------------------------------------------

Write-Host "Checking prerequisites..." -ForegroundColor Gray

# Check Copilot CLI
$cliVersion = $null
$copilotCmd = $null

# Try multiple known locations
$candidates = @(
    "copilot",
    "copilot.exe",
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe\copilot.exe"),
    (Join-Path $env:APPDATA "Code\User\globalStorage\github.copilot-chat\copilotCli\copilot.ps1")
)

foreach ($cmd in $candidates) {
    try {
        $cliOutput = (& $cmd --version 2>&1) | Out-String
        $m = [regex]::Match($cliOutput, '(\d+\.\d+\.\d+)')
        if ($m.Success) {
            $cliVersion = $m.Groups[1].Value
            $copilotCmd = $cmd
            break
        }
    } catch {}
}

if (-not $cliVersion) {
    Write-Host "  [ERROR] GitHub Copilot CLI not found. Install it first: https://docs.github.com/en/copilot/github-copilot-in-the-cli" -ForegroundColor Red
    exit 1
}

$minVersion = [version]"1.0.48"
$currentVersion = [version]$cliVersion
if ($currentVersion -lt $minVersion) {
    Write-Host "  [ERROR] Copilot CLI v$cliVersion detected - minimum required is v1.0.48. Run: copilot update" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Copilot CLI v$cliVersion detected (minimum: v1.0.48)" -ForegroundColor Green

# Check Node.js
$nodeVersion = $null
try {
    $nodeOutput = & node --version 2>&1
    if ($nodeOutput -match "v(\d+)") {
        $nodeVersion = $Matches[1]
    }
} catch {}

if (-not $nodeVersion) {
    Write-Host "  [WARN]  Node.js not found - the CLI runtime includes its own, but node is useful for debugging" -ForegroundColor Yellow
} else {
    Write-Host "  [OK] Node.js v$nodeOutput detected" -ForegroundColor Green
}

# -- Install Extension ---------------------------------------------------------

Write-Host ""
Write-Host "Installing extension..." -ForegroundColor Gray

$userHome = $env:USERPROFILE
$extensionDir = Join-Path $userHome ".copilot\extensions\constellation"
$profilesPath = Join-Path $userHome ".copilot\profiles.yaml"
$manifestPath = Join-Path $userHome ".copilot\mcp-manifest.yaml"
$mcpConfigPath = Join-Path $userHome ".copilot\mcp-config.json"
$scriptDir = $PSScriptRoot

if (-not (Test-Path $extensionDir)) {
    New-Item -Path $extensionDir -ItemType Directory -Force | Out-Null
}

$sourceMjs = Join-Path $scriptDir "extension.mjs"
if (-not (Test-Path $sourceMjs)) {
    Write-Host "  [ERROR] extension.mjs not found in script directory: $scriptDir" -ForegroundColor Red
    exit 1
}

$destMjs = Join-Path $extensionDir "extension.mjs"
if ((Test-Path $destMjs) -and -not $Force) {
    Write-Host "  [WARN]  extension.mjs already exists. Use -Force to overwrite." -ForegroundColor Yellow
} else {
    Copy-Item $sourceMjs $destMjs -Force
    Write-Host "  [OK] Installed: $destMjs" -ForegroundColor Green
}

# -- Scan MCP Configuration ---------------------------------------------------

if (Test-Path $profilesPath) {
    Write-Host ""
    Write-Host "  [INFO]  profiles.yaml already exists - skipping generation." -ForegroundColor Gray
    Write-Host "     Use profile_create, profile_update, and svr_register tools to modify." -ForegroundColor Gray
} elseif ($SkipScan) {
    Write-Host ""
    Write-Host "  Skipping MCP scan (-SkipScan). Creating minimal profiles.yaml..." -ForegroundColor Gray
    Copy-Item (Join-Path $scriptDir "profiles.yaml.example") $profilesPath
    Write-Host "  [OK] Created: $profilesPath (lean profile only)" -ForegroundColor Green

    if (-not (Test-Path $manifestPath)) {
        Copy-Item (Join-Path $scriptDir "mcp-manifest.yaml.example") $manifestPath
        Write-Host "  [OK] Created: $manifestPath (empty)" -ForegroundColor Green
    }
} else {
    Write-Host ""
    $mcpServers = @()
    if (Test-Path $mcpConfigPath) {
        try {
            $mcpConfig = Get-Content $mcpConfigPath -Raw | ConvertFrom-Json
            if ($mcpConfig.mcpServers) {
                $mcpServers = @($mcpConfig.mcpServers.PSObject.Properties.Name | Where-Object { $_ })
            }
        } catch {
            Write-Host "  [WARN]  Could not parse mcp-config.json" -ForegroundColor Yellow
        }
    }

    if ($mcpServers.Count -gt 0) {
        Write-Host "Scanning your MCP configuration..." -ForegroundColor Gray
        Write-Host "  Found $($mcpServers.Count) servers in mcp-config.json:" -ForegroundColor Gray
        Write-Host "    $($mcpServers -join ', ')" -ForegroundColor White
        Write-Host ""

        $response = Read-Host "  Register all $($mcpServers.Count) servers in Constellation? [Y/n]"
        if ($response -eq "" -or $response -match "^[Yy]") {
            # Build profiles.yaml with servers
            $serverList = ($mcpServers | ForEach-Object { "  - $_" }) -join "`n"
            $yamlContent = @"
# Constellation - Profile Definitions
# The single source of truth for Copilot CLI configuration profiles.
# Each profile controls which MCP servers are active per task domain.
# Layer 1: profile_switch (full replacement, user-only)
# Layer 2: svr_load/svr_unload (single-MCP, additive/subtractive, pipeline + user)

# All MCP servers registered ($($mcpServers.Count) total)
all_mcp_servers:
$serverList

# Always-on components (never disabled regardless of profile)
always_on:
  skills: []
  instructions: []

profiles:
  lean:
    description: "Minimal footprint for general tasks and quick questions"
    mcp_servers: []
    plugins: []
    working_dir: null
    hint: "Quick questions, general coding, starting a session"
"@
            $yamlContent | Out-File -FilePath $profilesPath -Encoding UTF8
            Write-Host "  [OK] Created: $profilesPath (lean profile + $($mcpServers.Count) registered MCPs)" -ForegroundColor Green

            # Build mcp-manifest.yaml with placeholder entries
            if (-not (Test-Path $manifestPath)) {
                $manifestLines = @(
                    "# MCP Capability Manifest"
                    "# Update descriptions and capabilities with svr_register or by editing this file."
                    ""
                    "servers:"
                )
                foreach ($server in $mcpServers) {
                    $manifestLines += @(
                        "  ${server}:"
                        "    description: `"$server MCP server`""
                        "    capabilities:"
                        "      - `"See server documentation`""
                        "    use_when: `"User needs $server capabilities`""
                        ""
                    )
                }
                ($manifestLines -join "`n") | Out-File -FilePath $manifestPath -Encoding UTF8
                Write-Host "  [OK] Created: $manifestPath ($($mcpServers.Count) server entries)" -ForegroundColor Green
            }

            Write-Host ""
            Write-Host "  [WARN]  Server capabilities are placeholders - update them with:" -ForegroundColor Yellow
            Write-Host "     svr_register to re-register with real descriptions, or" -ForegroundColor Yellow
            Write-Host "     edit $manifestPath directly" -ForegroundColor Yellow
        } else {
            Copy-Item (Join-Path $scriptDir "profiles.yaml.example") $profilesPath
            Write-Host "  [OK] Created: $profilesPath (lean profile only)" -ForegroundColor Green
            if (-not (Test-Path $manifestPath)) {
                Copy-Item (Join-Path $scriptDir "mcp-manifest.yaml.example") $manifestPath
                Write-Host "  [OK] Created: $manifestPath (empty)" -ForegroundColor Green
            }
        }
    } else {
        Write-Host "  No MCP servers found in mcp-config.json. Creating minimal config..." -ForegroundColor Gray
        Copy-Item (Join-Path $scriptDir "profiles.yaml.example") $profilesPath
        Write-Host "  [OK] Created: $profilesPath (lean profile only)" -ForegroundColor Green
        if (-not (Test-Path $manifestPath)) {
            Copy-Item (Join-Path $scriptDir "mcp-manifest.yaml.example") $manifestPath
            Write-Host "  [OK] Created: $manifestPath (empty)" -ForegroundColor Green
        }
    }
}

# -- Done ----------------------------------------------------------------------

Write-Host ""
Write-Host "Setup complete! Start a new Copilot CLI session to use Constellation." -ForegroundColor Green
Write-Host ""
Write-Host "Quick start:" -ForegroundColor Cyan
Write-Host "  profile_list          - see your profiles"
Write-Host "  profile_create        - create a new profile"
Write-Host "  svr_status            - see which MCPs are loaded"
Write-Host "  svr_register          - register a new MCP with capabilities"
Write-Host ""
