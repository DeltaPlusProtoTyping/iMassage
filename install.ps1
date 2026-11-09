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

# --- config.json + SSH key + Mac link --------------------------------------------------------
$config = Join-Path $dir "config.json"
$cfg = if (Test-Path $config) { Get-Content $config -Raw | ConvertFrom-Json } else { Get-Content (Join-Path $dir "config.example.json") -Raw | ConvertFrom-Json }
if (-not $cfg.ssh_key -or $cfg.ssh_key -like "*\you\*") { $cfg.ssh_key = Join-Path $env:USERPROFILE ".ssh\id_ed25519" }
if (-not (Test-Path $cfg.ssh_key)) {
    New-Item -ItemType Directory -Force (Split-Path $cfg.ssh_key) | Out-Null
    ssh-keygen -q -t ed25519 -N '""' -f $cfg.ssh_key -C "imassage@$env:COMPUTERNAME"
    Write-Host "  Made an SSH key: $($cfg.ssh_key)"
}
if ($cfg.mac_host -eq "you@your-mac.local") { $cfg.mac_host = "" }
$cfg | ConvertTo-Json | Set-Content $config -Encoding ascii

$pub = (Get-Content "$($cfg.ssh_key).pub" -Raw).Trim()
$macCmd = "curl -fsSL https://raw.githubusercontent.com/DeltaPlusProtoTyping/iMassage/main/mac-setup.sh | bash -s -- `"$pub`""
$ErrorActionPreference = "Continue"  # ssh/ssh-keygen write to stderr; that isn't failure
for ($try = 1; ; $try++) {
    if ($cfg.mac_host) {
        ssh -i $cfg.ssh_key -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new $cfg.mac_host "true" 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "  [ok] SSH to $($cfg.mac_host) works" -ForegroundColor Green; break }
        if ($try -gt 3) { Write-Host "  [X] Still can't SSH to $($cfg.mac_host). Check the address and that the Mac is on, then run this again." -ForegroundColor Red; exit 1 }
        Write-Host "`n  Can't reach $($cfg.mac_host) yet." -ForegroundColor Yellow
    }
    Write-Host "`n  On the Mac, open Terminal and paste this (it's on your clipboard), then enter your Mac password once:`n" -ForegroundColor Yellow
    Write-Host "  $macCmd`n"
    Set-Clipboard $macCmd
    $ans = (Read-Host "  When it says 'Your Mac is ready', type the mac_host it printed$(if ($cfg.mac_host) { " [$($cfg.mac_host)]" })").Trim()
    if ($ans) { $cfg.mac_host = $ans.Trim('"'); $cfg | ConvertTo-Json | Set-Content $config -Encoding ascii }
}
$ErrorActionPreference = "Stop"

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
