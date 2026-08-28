[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('ci', 'policy', 'lint', 'test', 'build', 'build-mv2', 'build-mv3', 'pnpm')]
    [string]$Command = 'ci',
    [Parameter(ValueFromRemainingArguments)]
    [string[]]$CommandArguments,
    [switch]$Rebuild,
    [switch]$NoCache,
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$declaredSourceCommit = if ($env:VM_SOURCE_COMMIT) { [string]$env:VM_SOURCE_COMMIT } else { '' }
if ($declaredSourceCommit -and $declaredSourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'VM_SOURCE_COMMIT is not an exact lowercase 40-character Git SHA.'
}

$resolvedSourceCommit = (& git -C $RepoRoot rev-parse --verify HEAD 2>$null | Out-String).Trim()
$gitResolved = $LASTEXITCODE -eq 0 -and $resolvedSourceCommit -match '^[0-9a-f]{40}$'
if ($gitResolved) {
    if ($declaredSourceCommit -and $declaredSourceCommit -ne $resolvedSourceCommit) {
        throw 'Declared source commit does not match the checkout HEAD.'
    }
    $sourceCommit = $resolvedSourceCommit
}
elif ($env:ACT -eq 'true' -and $declaredSourceCommit) {
    $sourceCommit = $declaredSourceCommit
}
else {
    throw 'Unable to resolve an exact source commit for container evidence.'
}

$runtimeJson = & (Join-Path $PSScriptRoot 'runtime-detect.ps1')
if ($LASTEXITCODE -ne 0) {
    throw 'Container runtime detection failed.'
}
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

        $allArguments = @()
        if ($runtime.commandPrefix) {
            $allArguments += @($runtime.commandPrefix)
        }
        $allArguments += $Arguments

        if ($Quiet) {
            & $runtime.cli @allArguments *> $null
        }
        else {
            & $runtime.cli @allArguments
        }
        $code = $LASTEXITCODE
        if (-not $IgnoreExitCode -and $code -ne 0) {
            throw "Container engine command failed ($code): $($runtime.cli) $($allArguments -join ' ')"
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

    $distro = "$($runtime.wslDistro)"
    $converted = & wsl.exe -d $distro -- wslpath -a $Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to translate path for WSL2 runtime: $Path"
    }
    return (($converted | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Get-DependencyHash {
    $sha = [System.Security.Cryptography.IncrementalHash]::CreateHash(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    )
    try {
        foreach ($relative in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
            $path = Join-Path $RepoRoot $relative
            $bytes = [System.IO.File]::ReadAllBytes($path)
            $sha.AppendData($bytes)
            $sha.AppendData([byte[]](0))
        }
        return ([Convert]::ToHexString($sha.GetHashAndReset())).ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

$dependencyHash = Get-DependencyHash
$image = if ($env:VM_TOOLCHAIN_IMAGE) {
    $env:VM_TOOLCHAIN_IMAGE
}
else {
    "violentmonkey-toolchain:local-$($dependencyHash.Substring(0, 16))"
}

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $RepoRoot "artifacts\container\$Command"
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

$imageExists = $true
try {
    Invoke-Engine -Arguments @('image', 'inspect', $image) -Quiet | Out-Null
}
catch {
    $imageExists = $false
}

if ($Rebuild -or -not $imageExists) {
    $buildArguments = @('build')
    if ($NoCache) {
        $buildArguments += @('--no-cache', '--pull')
    }
    $buildArguments += @(
        '--tag', $image,
        '--file', (Convert-EnginePath (Join-Path $RepoRoot 'containers\toolchain\Dockerfile')),
        (Convert-EnginePath $RepoRoot)
    )
    Invoke-Engine -Arguments $buildArguments | Out-Null
}

if (Test-Path $OutputDirectory) {
    Remove-Item -Path $OutputDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$containerName = "vm-toolchain-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$PID"
$repoEnginePath = Convert-EnginePath $RepoRoot
$outputEnginePath = Convert-EnginePath $OutputDirectory

try {
    $createArguments = @(
        'create',
        '--name', $containerName,
        '--network', 'none',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--env', "VM_RUNTIME_KIND=$($runtime.kind)",
        '--env', "VM_RUNTIME_ENDPOINT=$($runtime.endpoint)",
        '--env', "SOURCE_COMMIT=$sourceCommit",
        $image,
        $Command
    )
    if ($CommandArguments) {
        $createArguments += $CommandArguments
    }
    Invoke-Engine -Arguments $createArguments -Quiet | Out-Null

    Invoke-Engine -Arguments @('cp', "$repoEnginePath/.", "${containerName}:/input") | Out-Null

    $exitCode = Invoke-Engine -Arguments @('start', '--attach', $containerName) -IgnoreExitCode

    try {
        Invoke-Engine -Arguments @('cp', "${containerName}:/output/.", $outputEnginePath) -IgnoreExitCode | Out-Null
    }
    catch {
        Write-Warning "Unable to copy container output: $($_.Exception.Message)"
    }

    $resultPath = Join-Path $OutputDirectory 'run-result.json'
    if (Test-Path $resultPath) {
        Get-Content -Path $resultPath -Raw
    }
    else {
        [ordered]@{
            schemaVersion = 1
            status = 'failure'
            exitCode = $exitCode
            message = 'container produced no run-result.json'
            runtime = $runtime
        } | ConvertTo-Json -Depth 8
    }

    if ($exitCode -ne 0) {
        exit $exitCode
    }
}
finally {
    try {
        Invoke-Engine -Arguments @('rm', '-f', $containerName) -IgnoreExitCode -Quiet | Out-Null
    }
    catch {
        Write-Warning "Unable to remove temporary container $containerName"
    }
}
