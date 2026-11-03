$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://127.0.0.1:14168/'
$statePath = Join-Path $base 'workspace/.secheur-agent/desktop-main/main-session.json'
function Test-SecHeurMainReady([int]$processId) {
    try {
        $null = Invoke-RestMethod ($url + 'status') -TimeoutSec 2
        if (-not (Test-Path $statePath)) { return $false }
        $state = Get-Content -Raw $statePath | ConvertFrom-Json
        if ($processId -gt 0 -and [int]$state.pid -ne $processId) { return $false }
        if ([int]$state.taskCount -ne 20 -or [string]::IsNullOrWhiteSpace($state.mainSessionId)) { return $false }
        $tools = Invoke-RestMethod ($url + 'session/' + $state.mainSessionId + '/tools') -TimeoutSec 5
        return @($tools.tools | Where-Object { $_ -like 'competition_*' }).Count -eq 12
    }
    catch { return $false }
}
$ready = $false
try { $ready = Test-SecHeurMainReady 0 } catch {}
if (-not $ready) {
    $existing = Get-NetTCPConnection -LocalPort 14168 -State Listen -ErrorAction SilentlyContinue
    $backend = $null
    if ($existing) {
        $backendPid = [int]($existing | Select-Object -First 1).OwningProcess
    }
    else {
        $env:SECHEUR_PROJECT_ROOT = Join-Path $base 'workspace'
        $env:SECHEUR_CONFIG_DIR = Join-Path $base 'workspace/.secheur-agent'
        $env:SECHEUR_AGENT_DIR = Join-Path $env:SECHEUR_CONFIG_DIR 'pi'
        $env:PI_CODING_AGENT_DIR = $env:SECHEUR_AGENT_DIR
        $env:SECHEUR_PYTHON = 'D:/SecHeur-Agent/workspace/.secheur-agent/python/Scripts/python.exe'
        $env:SECHEUR_MANAGED_SESSIONS = '0'
        $env:PI_OFFLINE = '1'
        $env:BRIDGE_HOST = '127.0.0.1'
        $env:BRIDGE_PORT = '14168'
        $env:SECHEUR_PRIVATE_PLATFORM_ACCESS = Join-Path $base 'competition-selected20/access.json'
        $node = Join-Path $base 'runtime/node.exe'
        $entry = Join-Path $base 'app/packages/secheur-agent/dist/desktop-main-cli.js'
        $backend = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory (Join-Path $base 'workspace') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $base 'logs/backend.stdout.log') -RedirectStandardError (Join-Path $base 'logs/backend.stderr.log') -PassThru
        $backendPid = $backend.Id
        [IO.File]::WriteAllText((Join-Path $base 'backend.pid'), [string]$backend.Id)
    }
    for ($attempt = 0; $attempt -lt 360; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($backend -and $backend.HasExited) { throw 'Backend failed; see logs/backend.stderr.log' }
        if (-not (Get-Process -Id $backendPid -ErrorAction SilentlyContinue)) { throw 'Backend exited during Main Agent initialization; see logs/backend.stderr.log' }
        if (Test-SecHeurMainReady $backendPid) { $ready = $true; break }
    }
    if (-not $ready) {
        if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
        throw 'Backend did not finish Main Agent initialization within 180 seconds; see logs/backend.stderr.log'
    }
}
$mainState = Get-Content -Raw $statePath | ConvertFrom-Json
try {
    $null = Invoke-RestMethod -Method Post -Uri ($url + 'session/' + $mainState.mainSessionId + '/activate') `
        -ContentType 'application/json' -Body '{}' -TimeoutSec 5
}
catch {
    Write-Warning 'Could not activate the Main Agent session; the frontend will open with the last active session.'
}
Start-Process -FilePath 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' -ArgumentList @('--app=' + $url, '--user-data-dir=' + $base + '/browser-profile', '--no-first-run')
