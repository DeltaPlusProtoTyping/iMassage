# Sets up iMassage for the CURRENT user:
#  1. runtime\  - Electron (from the local Electron download cache; no download) with electron.exe
#                 renamed iMassage.exe and resources\app junctioned to desktop\
#  2. the "iMassage Server" task - server.py at logon, always on (the app also starts it if needed)
#  3. starts the app once; it adds the Start Menu shortcut (with its AppUserModelID, which Windows
#     needs for notifications) and its own start-at-login entry (tray menu > Open at Login).
$ErrorActionPreference = "Stop"
$dir      = $PSScriptRoot
$runtime  = Join-Path $dir "runtime"
$exe      = Join-Path $runtime "iMassage.exe"
$taskName = "iMassage Server"

$config = Join-Path $dir "config.json"
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $dir "config.example.json") $config
    Write-Host "  Created config.json - set mac_host (and ssh_key if not ~/.ssh/id_ed25519), then run this again." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $exe)) {
    $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache\*\electron-v*-win32-x64.zip" -ErrorAction SilentlyContinue |
           Sort-Object { [version]($_.Name -replace '^electron-v([\d.]+)-.*$', '$1') } -Descending | Select-Object -First 1
    if (-not $zip) { Write-Host "  [X] No Electron zip in $env:LOCALAPPDATA\electron\Cache - run 'npx electron --version' once to fetch one." -ForegroundColor Red; exit 1 }
    Write-Host "  Unpacking $($zip.Name)"
    Expand-Archive -Path $zip.FullName -DestinationPath $runtime -Force
    Rename-Item (Join-Path $runtime "electron.exe") "iMassage.exe"
}
$app = Join-Path $runtime "resources\app"
if (-not (Test-Path $app)) { New-Item -ItemType Junction -Path $app -Target (Join-Path $dir "desktop") | Out-Null }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Write-Host "  [X] python not found on PATH." -ForegroundColor Red; exit 1 }
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }

$action   = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$dir\server.py`"" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
            -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "iMassage: text from this PC through your Mac's Messages app (127.0.0.1:8766)" | Out-Null
if (-not (Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue)) { Start-ScheduledTask -TaskName $taskName }

Start-Process -FilePath $exe -WorkingDirectory $runtime

Write-Host ""
Write-Host "  [ok] iMassage is installed and running (tray icon; Start Menu > iMassage)." -ForegroundColor Green
Write-Host "  Server log: $dir\logs\server.log" -ForegroundColor DarkGray
Write-Host "  Remove:     quit from the tray, Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false," -ForegroundColor DarkGray
Write-Host "              delete the Start Menu shortcut, and untick Open at Login first (or delete HKCU\...\Run\Ben.iMassage)." -ForegroundColor DarkGray
