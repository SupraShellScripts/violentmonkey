[CmdletBinding()]
param(
    [ValidateSet('ci')]
    [string]$Job = 'ci',
    [string]$ActVersion = $(if ($env:VM_ACT_VERSION) { $env:VM_ACT_VERSION } else { '0.2.88' }),
    [string]$RunnerImage = $(if ($env:VM_ACT_RUNNER_IMAGE) { $env:VM_ACT_RUNNER_IMAGE } else { 'violentmonkey-act-runner:local' })
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceCommit = (& git -C $RepoRoot rev-parse --verify HEAD 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Unable to resolve an exact source commit for act parity.'
}

$runtimeJson = & (Join-Path $PSScriptRoot 'runtime-detect.ps1')
$runtime = $runtimeJson | ConvertFrom-Json

function Invoke-Engine {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$IgnoreExitCode,
        [switch]$Quiet
    )

    $oldDockerHost = $env:DOCKER_HOST
    try {
        if ($runtime.cli -eq 'docker' -and $runtime.kind -eq 'RemoteDocker' -and
            $runtime.endpoint -and -not $runtime.context) {
            $env:DOCKER_HOST = "$($runtime.endpoint)"
        }

        $all = @()
        if ($runtime.commandPrefix) {
            $all += @($runtime.commandPrefix)
        }
        $all += $Arguments

        if ($Quiet) {
            & $runtime.cli @all *> $null
        }
        else {
            & $runtime.cli @all
        }
        $code = $LASTEXITCODE
        if (-not $IgnoreExitCode -and $code -ne 0) {
            throw "Container engine command failed ($code): $($runtime.cli) $($all -join ' ')"
        }
        return $code
    }
    finally {
        $env:DOCKER_HOST = $oldDockerHost
    }
}

function Convert-EnginePath {
    param([Parameter(Mandatory)][string]$Path)
    if ($runtime.kind -ne 'WslEngine') {
        return $Path
    }
    $value = & wsl.exe -d $runtime.wslDistro -- wslpath -a $Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to translate path for WSL2: $Path"
    }
    return (($value | ForEach-Object { "$_" }) -join "`n").Trim()
}

$noCache = if ($env:VM_NO_CACHE) { $env:VM_NO_CACHE } else { '0' }
$rebuildToolchain = if ($env:VM_REBUILD_TOOLCHAIN) { $env:VM_REBUILD_TOOLCHAIN } else { '0' }

if ($runtime.kind -eq 'WslEngine') {
    $repoInWsl = Convert-EnginePath $RepoRoot
    $actProbe = & wsl.exe -d $runtime.wslDistro -- act --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "act $ActVersion must be available inside WSL distribution '$($runtime.wslDistro)'."
    }
    if (-not $env:VM_ACT_ALLOW_VERSION_DRIFT -and "$actProbe" -notmatch [regex]::Escape($ActVersion)) {
        throw "Expected act $ActVersion in WSL, found: $actProbe"
    }

    try {
        Invoke-Engine -Arguments @('image', 'inspect', $RunnerImage) -Quiet | Out-Null
    }
    catch {
        Invoke-Engine -Arguments @(
            'build',
            '--tag', $RunnerImage,
            '--file', (Convert-EnginePath (Join-Path $RepoRoot 'containers\act-runner\Dockerfile')),
            $repoInWsl
        ) | Out-Null
    }

    & wsl.exe -d $runtime.wslDistro -- sh -lc @"
set -eu
cd '$repoInWsl'
act workflow_dispatch \
  --workflows .github/workflows/ci.yml \
  --job '$Job' \
  --platform 'ubuntu-latest=$RunnerImage' \
  --env 'VM_NO_CACHE=$noCache' \
  --env 'VM_REBUILD_TOOLCHAIN=$rebuildToolchain' \
  --env 'VM_SOURCE_COMMIT=$sourceCommit' \
  --bind \
  --pull=false
"@
    exit $LASTEXITCODE
}

$actCommand = Get-Command act -ErrorAction SilentlyContinue
if (-not $actCommand) {
    throw "nektos/act $ActVersion is required as the local GitHub Actions orchestrator."
}

$actProbe = & act --version 2>&1
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to run act.'
}
if (-not $env:VM_ACT_ALLOW_VERSION_DRIFT -and "$actProbe" -notmatch [regex]::Escape($ActVersion)) {
    throw "Expected act $ActVersion, found: $actProbe"
}

try {
    Invoke-Engine -Arguments @('image', 'inspect', $RunnerImage) -Quiet | Out-Null
}
catch {
    Invoke-Engine -Arguments @(
        'build',
        '--tag', $RunnerImage,
        '--file', (Join-Path $RepoRoot 'containers\act-runner\Dockerfile'),
        $RepoRoot
    ) | Out-Null
}

$oldDockerHost = $env:DOCKER_HOST
try {
    switch ($runtime.kind) {
        'RemoteDocker' {
            $env:DOCKER_HOST = "$($runtime.endpoint)"
        }
        'Podman' {
            if (-not $env:VM_DOCKER_HOST) {
                throw 'act through Podman is experimental and requires VM_DOCKER_HOST to identify a Docker-compatible Podman socket.'
            }
            $env:DOCKER_HOST = $env:VM_DOCKER_HOST
        }
    }

    Push-Location $RepoRoot
    try {
        & act workflow_dispatch `
            --workflows .github/workflows/ci.yml `
            --job $Job `
            --platform "ubuntu-latest=$RunnerImage" `
            --env "VM_NO_CACHE=$noCache" `
            --env "VM_REBUILD_TOOLCHAIN=$rebuildToolchain" `
            --env "VM_SOURCE_COMMIT=$sourceCommit" `
            --bind `
            --pull=false
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:DOCKER_HOST = $oldDockerHost
}
