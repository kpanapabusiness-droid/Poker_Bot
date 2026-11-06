# Poker Coach + dickreuter/poker setup. Run setup.bat (it calls this). Safe to run again.
$ErrorActionPreference = 'Continue'
$env:PYTHONIOENCODING = "utf-8"
$Base = Join-Path $env:USERPROFILE 'poker'
$Log  = Join-Path $Base 'setup-log.txt'
New-Item -ItemType Directory -Force -Path $Base | Out-Null
Start-Transcript -Path $Log -Force | Out-Null
$problems = @()

$LogDir = Join-Path $Base 'setup-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
# Packages dickreuter lists but the bot never uses: a failure here doesn't matter.
$Optional = @('fastapi_auth', 'jupyter', 'pylint', 'pydocstyle', 'pyinstaller==5.13.0', 'flask_jwt_extended', 'PyJWT==1.7.0', 'xlib')
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
# dickreuter's list leaves numpy, opencv and scipy unpinned, so pip picks versions built for numpy 2,
# which break its pinned pandas 2.0.3 and tensorflow 2.12 ("numpy.dtype size changed"). Pin a set that
# works together, and keep packages the bot never uses out of the main install.
$constraints = Join-Path $LogDir 'constraints.txt'
@"
numpy==1.23.5
opencv-python==4.8.1.78
scipy==1.11.4
contourpy==1.1.1
lmfit==1.2.2
"@ | Set-Content -Path $constraints -Encoding ASCII
$core = Join-Path $LogDir 'requirements-core.txt'
Get-Content dickreuter-poker\requirements_win.txt | Where-Object { $_.Trim() -and -not $_.StartsWith('#') -and ($Optional -notcontains $_.Trim()) } | Set-Content -Path $core -Encoding ASCII
& $Py -m pip install -r $core -c $constraints *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'pip.txt')
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Bulk install failed; trying packages one at a time...' -ForegroundColor Yellow
  foreach ($pkg in Get-Content $core) {
    & $Py -m pip install $pkg -c $constraints *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'pip.txt') -Append
    if ($LASTEXITCODE -ne 0) { $problems += "pip package failed: $pkg" }
  }
}
foreach ($pkg in $Optional) {
  & $Py -m pip install $pkg -c $constraints *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'pip-optional.txt') -Append
  if ($LASTEXITCODE -ne 0) { Write-Host "  (skipped ${pkg}, not needed by the bot)" }
}
& $Py -c "import numpy, pandas, cv2, scipy, lmfit, PIL, openpyxl, seaborn, uvicorn, fastapi, matplotlib; print('numpy', numpy.__version__, 'pandas', pandas.__version__, 'opencv', cv2.__version__)" *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'imports.txt')
if ($LASTEXITCODE -ne 0) { $problems += "dickreuter's main packages don't load together (see setup-logs\imports.txt)" }
& $Py -m pip install 'https://github.com/simonflueckiger/tesserocr-windows_build/releases/download/tesserocr-v2.6.0-tesseract-5.3.1/tesserocr-2.6.0-cp311-cp311-win_amd64.whl'
if ($LASTEXITCODE -ne 0) { $problems += 'tesserocr failed to install' }
# dickreuter's mouse code needs pywin32 (win32api), which its package list leaves out
& $Py -m pip install pywin32 -c $constraints *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'pip.txt') -Append
if ($LASTEXITCODE -ne 0) { $problems += 'pywin32 failed to install' }
# Load the bot's whole program (without opening its window) to catch any other missing piece
Push-Location dickreuter-poker
& $Py -c "import poker.main; print('dickreuter loads OK')" *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'dickreuter-import.txt')
if ($LASTEXITCODE -ne 0) { $problems += "dickreuter doesn't start: a package is missing (see setup-logs\dickreuter-import.txt)" }
Pop-Location

Step '5/7  Plug the coach brain into dickreuter'
& $Py poker_bot\integrations\dickreuter\install.py dickreuter-poker *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'install.txt')
if ($LASTEXITCODE -ne 0) { $problems += 'install.py failed' }
$Brain = Join-Path $Base 'poker_bot\integrations\dickreuter\brain.js'
[Environment]::SetEnvironmentVariable('POKER_COACH_BRAIN', $Brain, 'User')
$env:POKER_COACH_BRAIN = $Brain

Step '6/7  Tests'
$env:DICKREUTER_DIR = Join-Path $Base 'dickreuter-poker'
& $Py poker_bot\integrations\dickreuter\test_coach_decision.py *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'test_coach_decision.txt')
if ($LASTEXITCODE -ne 0) { $problems += 'bridge tests failed' }
& $Py poker_bot\integrations\dickreuter\test_local_server.py *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'test_local_server.txt')
if ($LASTEXITCODE -ne 0) { $problems += 'local database tests failed' }
node poker_bot\integrations\dickreuter\test_brain.js *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'test_brain.txt')
if ($LASTEXITCODE -ne 0) { $problems += 'opponent-learning tests failed' }
node poker_bot\test\test-solver.js *>&1 | Tee-Object -FilePath (Join-Path $LogDir 'test_solver.txt')
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
Write-Host "Full log: $Log  (command output in $LogDir)"
Stop-Transcript | Out-Null
Read-Host 'Press Enter to close'
