[CmdletBinding()]
param(
    [ValidateSet('auto', 'docker', 'wsl-docker', 'podman')]
    [string]$Runtime = $(if ($env:VM_CONTAINER_RUNTIME) { $env:VM_CONTAINER_RUNTIME } else { 'auto' }),
    [string]$DockerContext = $env:VM_DOCKER_CONTEXT,
    [string]$DockerHost = $env:VM_DOCKER_HOST,
    [string]$WslDistro = $env:VM_WSL_DISTRO
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StateDir = Join-Path $RepoRoot '.work\runtime'
$StateFile = Join-Path $StateDir 'runtime.json'
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

function Test-NativeCommand {
    param([Parameter(Mandatory)][string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Captured {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $output = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
    [pscustomobject]@{
        ExitCode = $code
        Output = (($output | ForEach-Object { "$_" }) -join "`n").Trim()
    }
}

function Get-DockerDescriptor {
    param(
        [string]$Context,
        [string]$HostEndpoint
    )

    if (-not (Test-NativeCommand docker)) {
        return $null
    }

    $prefix = @()
    if ($Context) {
        $prefix += @('--context', $Context)
    }

    $oldHost = $env:DOCKER_HOST
    try {
        if ($HostEndpoint) {
            $env:DOCKER_HOST = $HostEndpoint
        }
        $probe = Invoke-Captured docker ($prefix + @('version', '--format', '{{json .Server}}'))
        if ($probe.ExitCode -ne 0 -or -not $probe.Output) {
            return $null
        }
        $server = $probe.Output | ConvertFrom-Json

        $selectedContext = $Context
        if (-not $selectedContext -and -not $HostEndpoint) {
            $contextResult = Invoke-Captured docker @('context', 'show')
            $selectedContext = if ($contextResult.ExitCode -eq 0) { $contextResult.Output } else { 'default' }
        }

        $endpoint = $HostEndpoint
        if (-not $endpoint) {
            $inspect = Invoke-Captured docker @('context', 'inspect', $selectedContext, '--format', '{{.Endpoints.docker.Host}}')
            $endpoint = if ($inspect.ExitCode -eq 0) { $inspect.Output } else { 'unknown' }
        }

        $kind = 'DockerEngine'
        $remote = $false
        $operatingSystem = "$($server.Os)"
        if ($server.PSObject.Properties.Name -contains 'Platform' -and $server.Platform) {
            $operatingSystem = "$($server.Platform.Name)"
        }

        if ($selectedContext -eq 'desktop-linux' -or
            $endpoint -like 'npipe://*' -or
            $endpoint -like '*dockerDesktopLinuxEngine*' -or
            $operatingSystem -match 'Docker Desktop') {
            $kind = 'DockerDesktop'
        }
        elseif ($endpoint -match '^(ssh|tcp|http|https)://') {
            $kind = 'RemoteDocker'
            $remote = $true
        }
        elseif ($env:WSL_DISTRO_NAME) {
            $kind = 'WslEngine'
        }

        return [ordered]@{
            schemaVersion = 1
            kind = $kind
            cli = 'docker'
            commandPrefix = $prefix
            context = $selectedContext
            endpoint = $endpoint
            serverVersion = "$($server.Version)"
            serverOs = "$($server.Os)"
            serverArch = "$($server.Arch)"
            operatingSystem = $operatingSystem
            remote = $remote
            wslDistro = $null
            actCompatibility = 'supported'
            selectedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
    finally {
        $env:DOCKER_HOST = $oldHost
    }
}

function Get-WslDockerDescriptors {
    if (-not (Test-NativeCommand wsl.exe)) {
        return @()
    }

    $distrosResult = Invoke-Captured wsl.exe @('-l', '-q')
    if ($distrosResult.ExitCode -ne 0) {
        return @()
    }

    $distros = $distrosResult.Output.Replace([char]0, '') -split "`r?`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }

    $descriptors = @()
    foreach ($distro in $distros) {
        $probe = Invoke-Captured wsl.exe @(
            '-d', $distro, '--',
            'docker', 'version', '--format', '{{json .Server}}'
        )
        if ($probe.ExitCode -ne 0 -or -not $probe.Output) {
            continue
        }

        try {
            $server = $probe.Output | ConvertFrom-Json
        }
        catch {
            continue
        }

        $descriptors += [ordered]@{
            schemaVersion = 1
            kind = 'WslEngine'
            cli = 'wsl.exe'
            commandPrefix = @('-d', $distro, '--', 'docker')
            context = 'default'
            endpoint = "wsl://$distro"
            serverVersion = "$($server.Version)"
            serverOs = "$($server.Os)"
            serverArch = "$($server.Arch)"
            operatingSystem = "$($server.Os)"
            remote = $false
            wslDistro = $distro
            actCompatibility = 'supported'
            selectedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
    }
    return $descriptors
}

function Get-PodmanDescriptor {
    if (-not (Test-NativeCommand podman)) {
        return $null
    }

    $probe = Invoke-Captured podman @('info', '--format', 'json')
    if ($probe.ExitCode -ne 0 -or -not $probe.Output) {
        return $null
    }

    try {
        $info = $probe.Output | ConvertFrom-Json
    }
    catch {
        return $null
    }

    $versionResult = Invoke-Captured podman @('version', '--format', '{{.Server.Version}}')
    $version = if ($versionResult.ExitCode -eq 0) { $versionResult.Output } else { 'unknown' }

    $arch = if ($info.host.arch) { "$($info.host.arch)" } else { 'unknown' }
    $os = if ($info.host.os) { "$($info.host.os)" } else { 'unknown' }
    $rootless = if ($null -ne $info.host.security.rootless) { [bool]$info.host.security.rootless } else { $null }

    return [ordered]@{
        schemaVersion = 1
        kind = 'Podman'
        cli = 'podman'
        commandPrefix = @()
        context = $null
        endpoint = $(if ($env:DOCKER_HOST) { $env:DOCKER_HOST } else { 'podman-local' })
        serverVersion = $version
        serverOs = $os
        serverArch = $arch
        operatingSystem = $os
        remote = $false
        rootless = $rootless
        wslDistro = $null
        actCompatibility = 'experimental'
        selectedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
}

$selected = $null

switch ($Runtime) {
    'docker' {
        $selected = Get-DockerDescriptor -Context $DockerContext -HostEndpoint $DockerHost
        if (-not $selected) {
            throw 'The explicitly requested Docker endpoint is not healthy.'
        }
    }
    'wsl-docker' {
        $candidates = Get-WslDockerDescriptors
        if ($WslDistro) {
            $selected = $candidates | Where-Object { $_.wslDistro -eq $WslDistro } | Select-Object -First 1
        }
        elseif ($candidates.Count -eq 1) {
            $selected = $candidates[0]
        }
        elseif ($candidates.Count -gt 1) {
            throw "More than one WSL2 Docker Engine is healthy. Set VM_WSL_DISTRO. Candidates: $($candidates.wslDistro -join ', ')"
        }
        if (-not $selected) {
            throw 'No healthy Docker Engine was found in the requested WSL2 distribution.'
        }
    }
    'podman' {
        $selected = Get-PodmanDescriptor
        if (-not $selected) {
            throw 'The explicitly requested Podman endpoint is not healthy.'
        }
    }
    'auto' {
        $selected = Get-DockerDescriptor -Context $DockerContext -HostEndpoint $DockerHost
        if (-not $selected) {
            $wslCandidates = Get-WslDockerDescriptors
            if ($WslDistro) {
                $selected = $wslCandidates | Where-Object { $_.wslDistro -eq $WslDistro } | Select-Object -First 1
            }
            elseif ($wslCandidates.Count -eq 1) {
                $selected = $wslCandidates[0]
            }
            elseif ($wslCandidates.Count -gt 1) {
                throw "Multiple WSL2 Docker Engines are healthy. Set VM_WSL_DISTRO. Candidates: $($wslCandidates.wslDistro -join ', ')"
            }
        }
        if (-not $selected) {
            $selected = Get-PodmanDescriptor
        }
        if (-not $selected) {
            throw 'No healthy Docker Desktop, Docker Engine, WSL2 Docker Engine, remote Docker endpoint, or Podman endpoint was found.'
        }
    }
}

$json = $selected | ConvertTo-Json -Depth 8
$json | Set-Content -Path $StateFile -Encoding utf8NoBOM
$json
