# Poker Coach + dickreuter/poker setup. Run setup.bat (it calls this). Safe to run again.
$ErrorActionPreference = 'Continue'
$env:PYTHONIOENCODING = "utf-8"
$Base = Join-Path $env:USERPROFILE 'poker'
$Log  = Join-Path $Base 'setup-log.txt'
New-Item -ItemType Directory -Force -Path $Base | Out-Null
Start-Transcript -Path $Log -Force | Out-Null
$problems = @()

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Step '1/7  Git and Node.js'
foreach ($t in @(@{cmd='git'; id='Git.Git'}, @{cmd='node'; id='OpenJS.NodeJS.LTS'})) {
  if (Have $t.cmd) { Write-Host "$($t.cmd) already installed" }
  else {
    Write-Host "Installing $($t.id) with winget..."
    winget install --id $t.id -e --silent --accept-package-agreements --accept-source-agreements
    RefreshPath
    if (-not (Have $t.cmd)) { $problems += "$($t.cmd) didn't install. Install it by hand, then run setup.bat again."; }
  }
}
if ($problems.Count) { $problems; Stop-Transcript | Out-Null; Read-Host 'Press Enter to close'; exit 1 }

Step '2/7  Download the code'
Set-Location $Base
if (Test-Path 'dickreuter-poker\.git') { git -C dickreuter-poker pull --ff-only }
else { git clone --depth 1 https://github.com/dickreuter/poker dickreuter-poker }
if (Test-Path 'poker_bot\.git') { git -C poker_bot fetch origin dickreuter-brain; git -C poker_bot checkout dickreuter-brain; git -C poker_bot pull --ff-only }
else { git clone -b dickreuter-brain https://github.com/kpanapabusiness-droid/poker_bot poker_bot }

Step '3/7  Python 3.11'
$Py = Join-Path $Base 'py311\python.exe'
if (-not (Test-Path $Py)) {
  $conda = Join-Path $env:USERPROFILE 'miniconda3\Scripts\conda.exe'
  if (Test-Path $conda) {
    & $conda create -y -p (Join-Path $Base 'py311') python=3.11
  } else {
    winget install --id Python.Python.3.11 -e --silent --accept-package-agreements --accept-source-agreements
    RefreshPath
    & py -3.11 -m venv (Join-Path $Base 'py311-venv')
    $Py = Join-Path $Base 'py311-venv\Scripts\python.exe'
  }
}
if (-not (Test-Path $Py)) { $Py = Join-Path $Base 'py311-venv\Scripts\python.exe' }
& $Py --version

Step '4/7  dickreuter requirements (this is the slow one: 5-15 min)'
& $Py -m pip install --upgrade pip
& $Py -m pip install -r dickreuter-poker\requirements_win.txt
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Bulk install failed; trying packages one at a time...' -ForegroundColor Yellow
  foreach ($line in Get-Content dickreuter-poker\requirements_win.txt) {
    $pkg = $line.Trim(); if (-not $pkg -or $pkg.StartsWith('#')) { continue }
    & $Py -m pip install $pkg
    if ($LASTEXITCODE -ne 0) { $problems += "pip package failed: $pkg" }
  }
}
& $Py -m pip install 'https://github.com/simonflueckiger/tesserocr-windows_build/releases/download/tesserocr-v2.6.0-tesseract-5.3.1/tesserocr-2.6.0-cp311-cp311-win_amd64.whl'
if ($LASTEXITCODE -ne 0) { $problems += 'tesserocr failed to install' }

Step '5/7  Plug the coach brain into dickreuter'
& $Py poker_bot\integrations\dickreuter\install.py dickreuter-poker
if ($LASTEXITCODE -ne 0) { $problems += 'install.py failed' }
$Brain = Join-Path $Base 'poker_bot\integrations\dickreuter\brain.js'
[Environment]::SetEnvironmentVariable('POKER_COACH_BRAIN', $Brain, 'User')
$env:POKER_COACH_BRAIN = $Brain

Step '6/7  Tests'
$env:DICKREUTER_DIR = Join-Path $Base 'dickreuter-poker'
& $Py poker_bot\integrations\dickreuter\test_coach_decision.py
if ($LASTEXITCODE -ne 0) { $problems += 'bridge tests failed' }
& $Py poker_bot\integrations\dickreuter\test_local_server.py
if ($LASTEXITCODE -ne 0) { $problems += 'local database tests failed' }
node poker_bot\integrations\dickreuter\test_brain.js
if ($LASTEXITCODE -ne 0) { $problems += 'opponent-learning tests failed' }
node poker_bot\test\test-solver.js
if ($LASTEXITCODE -ne 0) { $problems += 'solver tests failed' }
& $Py -c "import sys; sys.path.insert(0, r'$Base\dickreuter-poker'); import poker.decisionmaker.coach_decision as c; print('coach_decision imports inside dickreuter:', c.Decision.__name__)"
if ($LASTEXITCODE -ne 0) { $problems += "dickreuter's code doesn't import (a requirement is missing)" }

Step '7/7  Desktop shortcuts'
$start = @"
@echo off
rem Starts the local database (keeps everything on this PC), then the bot.
cd /d "$Base\dickreuter-poker"
set POKER_COACH_BRAIN=$Brain
set DICKREUTER_DIR=$Base\dickreuter-poker
start "Poker local database" /min "$Py" "$Base\poker_bot\integrations\dickreuter\local_server.py" --dickreuter "$Base\dickreuter-poker"
timeout /t 2 /nobreak >nul
"$Py" -m poker.main
pause
"@
$report = @"
@echo off
"$Py" "$Base\poker_bot\integrations\dickreuter\report.py"
pause
"@
Set-Content -Path (Join-Path $Base 'bot-report.bat') -Value $report -Encoding ASCII
Set-Content -Path (Join-Path $Base 'start-bot.bat') -Value $start -Encoding ASCII
$desk = [Environment]::GetFolderPath('Desktop')
Copy-Item (Join-Path $Base 'start-bot.bat') (Join-Path $desk 'Start Poker Bot.bat') -Force
Copy-Item (Join-Path $Base 'bot-report.bat') (Join-Path $desk 'Poker Bot Report.bat') -Force

Write-Host ''
if ($problems.Count) {
  Write-Host 'Finished with problems:' -ForegroundColor Yellow; $problems | ForEach-Object { Write-Host " - $_" -ForegroundColor Yellow }
} else {
  Write-Host 'All done. Double-click "Start Poker Bot" on your desktop.' -ForegroundColor Green
}
Write-Host "Full log: $Log"
Stop-Transcript | Out-Null
Read-Host 'Press Enter to close'
