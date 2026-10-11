# Replaces this Quiz Answers folder's files with the latest from GitHub, in
# place. Run it by double-clicking "Update Quiz Answers.bat" in the folder.
#
# The Windows twin of update.sh - read that file for why it works this way. In
# short: Chrome knows an unpacked extension by its folder, and keeps the saved
# API key under that identity, so the folder must never move. This replaces
# what is inside it, one top-level entry at a time, keeps every old entry until
# the whole update has gone through, puts everything back if any step fails,
# and changes manifest.json last.
#
# Kept to plain ASCII: Windows PowerShell 5.1 reads a script without a byte
# order mark as the local code page, and mangles anything else.

# First, and in plain commands only. Where an App Control policy - Smart App
# Control, or one an organisation sets - has not approved this script, Windows
# runs it in a restricted mode in which most of what follows fails with an
# error that explains nothing. Say what is going on instead, and change nothing.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Host 'Windows only lets this updater run in a restricted mode on this PC,'
  Write-Host 'because Smart App Control (or a policy set by your organisation) has'
  Write-Host 'not approved it. Nothing was changed.'
  Write-Host ''
  Write-Host 'Update Quiz Answers by hand instead: see "Updating by hand" in the'
  Write-Host 'README at https://github.com/jincemp/Chrome-Exam-Plugin'
  Write-Host ''
  $null = Read-Host 'Press Enter to close this window'
  exit 1
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads many times slower in 5.1

$ZipUrl = if ($env:QUIZ_ANSWERS_ZIP_URL) { $env:QUIZ_ANSWERS_ZIP_URL } else { 'https://github.com/jincemp/Chrome-Exam-Plugin/archive/refs/heads/main.zip' }
$AppName = 'Quiz Answers'

$script:Dir = $null
$script:Work = $null
$script:Staging = $null
$script:Backup = $null
$script:Src = $null
$script:Swapped = New-Object System.Collections.ArrayList
$script:Count = 0
# Not "$script:Current": PowerShell names are case-insensitive, and that would
# be the same variable as $current, the installed version, clobbering it.
$script:EntryInProgress = $null

function Pause-ForReader {
  # Only when a person is at the window - never when run by a test.
  if (-not [Console]::IsInputRedirected) {
    Write-Host ''
    try { [void](Read-Host 'Press Enter to close this window') } catch { }
  }
}

function Read-Manifest([string]$folder) {
  $file = Join-Path $folder 'manifest.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-QuizAnswers([string]$folder) {
  $m = Read-Manifest $folder
  return ($null -ne $m) -and ($m.name -eq $AppName)
}

# Is version $a newer than version $b? Numeric per part, so 1.10 beats 1.9.
function Test-Newer([string]$a, [string]$b) {
  $pa = @($a -split '\.' | ForEach-Object { [int]("0" + ($_ -replace '[^0-9]', '')) })
  $pb = @($b -split '\.' | ForEach-Object { [int]("0" + ($_ -replace '[^0-9]', '')) })
  for ($i = 0; $i -lt 4; $i++) {
    $x = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
    $y = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
    if ($x -gt $y) { return $true }
    if ($x -lt $y) { return $false }
  }
  return $false
}

function Remove-Scratch {
  foreach ($p in @($script:Work, $script:Staging, $script:Backup)) {
    if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Stop-WithFailure([string]$why) {
  Write-Host ''
  Write-Host "Update failed: $why"
  if ($script:Swapped.Count -gt 0) {
    # Undo-Swaps could not put everything back, and the backup holds the only
    # copy of what is missing. Keep it: the next run restores from it first.
    $script:Backup = $null
    Write-Host 'Some of the old files could not be put back yet. They are safe in the'
    Write-Host 'hidden ".update-old" folder inside Quiz Answers. Double-click'
    Write-Host '"Update Quiz Answers" again to finish.'
  } else {
    Write-Host 'Nothing was changed - Quiz Answers is exactly as it was.'
  }
  Remove-Scratch
  Pause-ForReader
  exit 1
}

# Undoes every swap so far, newest first. An entry that cannot be put back
# stays listed, which tells Stop-WithFailure to keep the backup.
function Undo-Swaps {
  for ($i = $script:Swapped.Count - 1; $i -ge 0; $i--) {
    $n = $script:Swapped[$i]
    try {
      $target = Join-Path $script:Dir $n
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      $saved = Join-Path $script:Backup $n
      if (Test-Path -LiteralPath $saved) { Move-Item -LiteralPath $saved -Destination $target }
      $script:Swapped.RemoveAt($i)
    } catch { }
  }
}

function Move-Into-Place([string]$n) {
  $script:EntryInProgress = $n
  if ($env:QUIZ_ANSWERS_FAIL_AFTER -and $script:Count -ge [int]$env:QUIZ_ANSWERS_FAIL_AFTER) {
    throw 'test hook' # test hook only: tools/updater-test.mjs uses it to prove rollback works
  }
  if ($env:QUIZ_ANSWERS_TRACE) { Add-Content -LiteralPath $env:QUIZ_ANSWERS_TRACE -Value $n } # test hook only
  $target = Join-Path $script:Dir $n
  if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination (Join-Path $script:Backup $n) }
  [void]$script:Swapped.Add($n)
  if ($env:QUIZ_ANSWERS_QUIT_AFTER -and $script:Count -ge [int]$env:QUIZ_ANSWERS_QUIT_AFTER) {
    Stop-Process -Id $PID -Force # test hook only: what closing the window right here does
  }
  Move-Item -LiteralPath (Join-Path $script:Src $n) -Destination $target
  $script:Count++
}

# A run cut off mid-swap can leave old entries only in the backup. Put back
# anything missing before the backup folder is cleared below.
function Restore-InterruptedRun {
  $old = Join-Path $script:Dir '.update-old'
  if (-not (Test-Path -LiteralPath $old)) { return }
  foreach ($item in @(Get-ChildItem -LiteralPath $old -Force)) {
    $target = Join-Path $script:Dir $item.Name
    if (-not (Test-Path -LiteralPath $target)) { Move-Item -LiteralPath $item.FullName -Destination $target }
  }
}

# Anything not handled below still gets explained, in a window that stays open
# long enough to read it. Without this, the window just closes. A trap covers
# the whole script but a function exists only once its definition has run, so
# nothing above this point may fail.
trap {
  Stop-WithFailure "something unexpected went wrong: $($_.Exception.Message)"
}

$script:Dir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath

if (-not (Test-QuizAnswers $script:Dir)) {
  Write-Host 'This does not look like the Quiz Answers folder:'
  Write-Host "  $($script:Dir)"
  Write-Host 'Keep "Update Quiz Answers" inside the extension folder and run it from there.'
  Pause-ForReader
  exit 1
}
if (Test-Path -LiteralPath (Join-Path $script:Dir '.git')) {
  Write-Host 'This copy of Quiz Answers is a git checkout. Update it with:  git pull'
  Pause-ForReader
  exit 1
}

# Files unzipped from a download carry Windows' "came from the internet" mark,
# which is why the first double-click asked for permission. An update swaps in
# unmarked copies, but when there is nothing to update these two would keep the
# mark and ask again next time. (Not available off Windows; nothing to do there.)
foreach ($f in @((Join-Path $script:Dir 'Update Quiz Answers.bat'), $PSCommandPath)) {
  try { Unblock-File -LiteralPath $f -ErrorAction SilentlyContinue } catch { }
}

Restore-InterruptedRun
$script:Staging = Join-Path $script:Dir '.update-new'
$script:Backup = Join-Path $script:Dir '.update-old'

$current = (Read-Manifest $script:Dir).version
Write-Host "$AppName $current"
Write-Host 'Checking for a newer version...'

# Windows PowerShell 5.1 can default to TLS 1.0/1.1, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

try {
  $script:Work = Join-Path ([IO.Path]::GetTempPath()) ('quiz-answers-update-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:Work | Out-Null
  $zip = Join-Path $script:Work 'latest.zip'
  Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
} catch {
  Stop-WithFailure 'could not download the latest version. Check your internet connection and try again.'
}

try {
  foreach ($p in @($script:Staging, $script:Backup)) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
    New-Item -ItemType Directory -Path $p | Out-Null
  }
} catch {
  Stop-WithFailure "could not write to $($script:Dir)."
}

try {
  # Unpacked beside the extension, so every swap below is a rename on one disk.
  Expand-Archive -LiteralPath $zip -DestinationPath $script:Staging -Force
} catch {
  Stop-WithFailure 'the download was damaged. Try again in a minute.'
}

$top = @(Get-ChildItem -LiteralPath $script:Staging -Directory)
if ($top.Count -lt 1 -or -not (Test-QuizAnswers $top[0].FullName)) { Stop-WithFailure 'the download does not look like Quiz Answers.' }
$script:Src = $top[0].FullName
$latest = (Read-Manifest $script:Src).version
if (-not $latest) { Stop-WithFailure 'the download has no version number.' }

if (-not (Test-Newer $latest $(if ($current) { $current } else { '0' }))) {
  Write-Host ''
  Write-Host "You already have the latest version ($current)."
  Remove-Scratch
  Pause-ForReader
  exit 0
}

Write-Host "Installing $latest..."

$names = @(Get-ChildItem -LiteralPath $script:Src -Force | ForEach-Object { $_.Name } |
  Where-Object { $_ -ne 'manifest.json' -and $_ -ne '.git' })
try {
  foreach ($n in $names) { Move-Into-Place $n }
  # Last, on purpose: the extension restarts itself when this file's version
  # changes, so it must not change until everything else is in place.
  Move-Into-Place 'manifest.json'
} catch {
  $what = if ($script:EntryInProgress) { $script:EntryInProgress } else { 'a file' }
  Undo-Swaps
  Stop-WithFailure "could not replace $what."
}

Remove-Scratch
Write-Host ''
Write-Host "Updated $AppName from $current to $latest."
Write-Host ''
Write-Host 'Your API key and settings are untouched: they live in Chrome, and this'
Write-Host 'folder stayed exactly where it was.'
Write-Host ''
Write-Host 'Last step: click the Quiz Answers icon in Chrome. It usually switches to'
Write-Host 'the new version by itself; if it shows "Restart to finish", click that.'
Write-Host 'Keep "Developer mode" on at chrome://extensions - Quiz Answers only runs'
Write-Host 'while it is on.'
Pause-ForReader
exit 0
