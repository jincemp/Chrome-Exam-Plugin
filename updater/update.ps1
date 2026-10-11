# Replaces this Quiz Answers folder's files with the latest from GitHub, in
# place. Run it by double-clicking "Update Quiz Answers.bat" in the folder.
#
# The Windows twin of update.sh - read that file for why it works this way,
# and what its three scratch folders (.update-new, .update-old, .update-trash)
# are for. In short: Chrome knows an unpacked extension by its folder, and
# keeps the saved API key under that identity, so the folder must never move.
# This replaces what is inside it, one top-level entry at a time, keeps every
# old entry until the whole update has gone through, puts everything back if
# any step fails, and changes manifest.json last.
#
# Kept to plain ASCII: Windows PowerShell 5.1 reads a script without a byte
# order mark as the local code page, and mangles anything else.
#
# Test hooks, used only by tools/updater-test.mjs and inert unless set:
# QUIZ_ANSWERS_ZIP_URL, _FAIL_AFTER, _FAIL_UNDO, _QUIT_AFTER, _TRACE,
# _ONEDRIVE and _NATIVE_DIR.

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
# The name Quiz Answers asks Chrome for when its "Update now" button is pressed.
$HelperName = 'com.jincemp.quiz_answers'
$script:OnWindows = $env:OS -eq 'Windows_NT'

# PowerShell names are case-insensitive, so none of these may share a name
# with a variable used anywhere else in the script: $Latest and $latest would
# be one variable.
$script:Dir = $null
$script:Work = $null
$script:Staging = $null
$script:Backup = $null
$script:Trash = $null
$script:Src = $null
$script:Swapped = New-Object System.Collections.ArrayList
$script:Count = 0
$script:EntryInProgress = $null
$script:InstalledVersion = $null
$script:Recovered = $false

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
  # UTF-8 said outright: 5.1 would otherwise read it in the local code page.
  try { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
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

function Test-HasEntries([string]$folder) {
  if (-not $folder -or -not (Test-Path -LiteralPath $folder -PathType Container)) { return $false }
  return @(Get-ChildItem -LiteralPath $folder -Force).Count -gt 0
}

# Defender, the search indexer or OneDrive can hold a just-written file open for
# a moment, and a rename fails meanwhile. A few tries ride that out.
function Move-WithRetry([string]$from, [string]$to) {
  for ($try = 1; ; $try++) {
    try {
      Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop
      return
    } catch {
      if ($try -ge 20) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

# Moves a file or folder into the trash, under a name nothing else will use.
function Send-ToTrash([string]$path) {
  if (-not (Test-Path -LiteralPath $script:Trash)) { [void](New-Item -ItemType Directory -Path $script:Trash) }
  Move-WithRetry $path (Join-Path $script:Trash ([IO.Path]::GetFileName($path) + '.' + [Guid]::NewGuid().ToString('N')))
}

# Deletes a folder, or tries to; never throws. Windows PowerShell 5.1 cannot
# remove a OneDrive folder in one go - Documents often is one - but it can one
# file at a time and then the emptied folders, deepest first.
function Remove-Tree([string]$path) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return }
  try {
    if ($env:QUIZ_ANSWERS_ONEDRIVE) { throw 'test hook' } # test hook only: forces the slow path below
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
    return
  } catch { }
  try {
    Get-ChildItem -LiteralPath $path -Recurse -Force -File | ForEach-Object { $_.Attributes = 'Normal'; $_.Delete() }
    Get-ChildItem -LiteralPath $path -Recurse -Force -Directory |
      Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { $_.Delete() }
    (Get-Item -LiteralPath $path -Force).Delete()
  } catch { }
}

# Never throws: it also runs on the way out of a failure, from the trap.
function Remove-Scratch {
  foreach ($p in @($script:Work, $script:Staging, $script:Trash)) { Remove-Tree $p }
  # Only an empty backup goes. Anything still in it is the only copy of an old
  # entry, and the next run puts it back.
  try {
    if ($script:Backup -and (Test-Path -LiteralPath $script:Backup) -and -not (Test-HasEntries $script:Backup)) {
      Remove-Item -LiteralPath $script:Backup -Force -ErrorAction Stop
    }
  } catch { }
}

function Stop-WithFailure([string]$why) {
  Write-Host ''
  Write-Host "Update failed: $why"
  $kept = $true
  try { $kept = Test-HasEntries $script:Backup } catch { }
  if ($kept) {
    Write-Host 'Some of the old files could not be put back yet. They are safe in the'
    Write-Host 'hidden ".update-old" folder inside Quiz Answers. Double-click'
    Write-Host '"Update Quiz Answers" again: it puts them back first.'
  } elseif ($script:Recovered) {
    Write-Host "Quiz Answers is on version $($script:InstalledVersion) again, as before the update that did not finish."
  } else {
    Write-Host 'Nothing was changed - Quiz Answers is exactly as it was.'
  }
  Remove-Scratch
  Pause-ForReader
  exit 1
}

# Undoes every swap so far, newest first. An entry that cannot be put back
# stays in the backup, and the next run restores it.
function Undo-Swaps {
  for ($i = $script:Swapped.Count - 1; $i -ge 0; $i--) {
    $n = $script:Swapped[$i]
    if ($env:QUIZ_ANSWERS_FAIL_UNDO) { continue } # test hook only
    try {
      $target = Join-Path $script:Dir $n
      $saved = Join-Path $script:Backup $n
      if (Test-Path -LiteralPath $target) { Send-ToTrash $target }
      if (Test-Path -LiteralPath $saved) { Move-WithRetry $saved $target }
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
  if (Test-Path -LiteralPath $target) { Move-WithRetry $target (Join-Path $script:Backup $n) }
  [void]$script:Swapped.Add($n)
  if ($env:QUIZ_ANSWERS_QUIT_AFTER -and $script:Count -ge [int]$env:QUIZ_ANSWERS_QUIT_AFTER) {
    Stop-Process -Id $PID -Force # test hook only: what closing the window right here does
  }
  Move-WithRetry (Join-Path $script:Src $n) $target
  $script:Count++
}

# A backup found at the start belongs to a run that did not finish. Whatever
# that run left in the folder is some mix of two versions, and the backup
# holds the old half: put all of it back, so the folder is one whole version
# again before anything else happens. Returns $false if that is not possible.
function Restore-InterruptedRun {
  if (-not (Test-HasEntries $script:Backup)) {
    try { if (Test-Path -LiteralPath $script:Backup) { Remove-Item -LiteralPath $script:Backup -Force -ErrorAction Stop } } catch { }
    return $true
  }
  # Clutter from a run that did finish. Putting it back would undo that update.
  if (Test-Path -LiteralPath (Join-Path $script:Backup '.finished')) {
    try { Send-ToTrash $script:Backup } catch { Remove-Tree $script:Backup }
    return $true
  }
  Write-Host 'The last update did not finish. Putting the previous version back first...'
  try {
    foreach ($item in @(Get-ChildItem -LiteralPath $script:Backup -Force)) {
      $target = Join-Path $script:Dir $item.Name
      if (Test-Path -LiteralPath $target) { Send-ToTrash $target }
      Move-WithRetry $item.FullName $target
    }
  } catch {
    return $false
  }
  try { Remove-Item -LiteralPath $script:Backup -Force -ErrorAction Stop } catch { }
  $script:Recovered = $true
  return $true
}

# The ID Chrome gives an extension loaded unpacked from folder $path: the first
# half of the SHA-256 of the path, written with the letters a to p. Windows
# Chrome hashes the path as UTF-16 with the drive letter in capitals; Chrome
# elsewhere hashes the UTF-8 bytes.
function Get-ExtensionId([string]$path) {
  if ($script:OnWindows) {
    if ($path -match '^[a-z]:') { $path = $path.Substring(0, 1).ToUpper() + $path.Substring(1) }
    $bytes = [Text.Encoding]::Unicode.GetBytes($path)
  } else {
    $bytes = [Text.Encoding]::UTF8.GetBytes($path)
  }
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  $id = ''
  foreach ($b in $hash[0..15]) {
    $id += [string][char](97 + ($b -shr 4)) + [string][char](97 + ($b -band 15))
  }
  return $id
}

# The folder as Chrome's folder picker gives it: every name spelled as it is
# on disk, and long names rather than 8.3 ones such as QUIZAN~1. Chrome follows
# no junctions or links, so neither does this.
function Get-OnDiskPath([string]$path) {
  try {
    $full = [IO.Path]::GetFullPath($path)
    $root = [IO.Path]::GetPathRoot($full)
    $cur = $root
    foreach ($part in $full.Substring($root.Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
      $name = $part
      try {
        $hit = @(([IO.DirectoryInfo]$cur).GetDirectories($part)) | Select-Object -First 1
        if ($hit) { $name = $hit.Name }
      } catch { }
      $cur = [IO.Path]::Combine($cur, $name)
    }
    return $cur
  } catch {
    return $path
  }
}

# The IDs Chrome may have given this copy: from the path as this script was
# started, and as Chrome's folder picker would spell it. A spare ID does no
# harm, and a missing one means no button, so both are listed.
function Get-ExtensionIds([string]$path) {
  $ids = New-Object System.Collections.ArrayList
  foreach ($p in @($path, (Get-OnDiskPath $path))) {
    $id = Get-ExtensionId $p
    if (-not $ids.Contains($id)) { [void]$ids.Add($id) }
  }
  return ,$ids.ToArray()
}

# Registers updater\native-host.bat with Chrome, for this copy of Quiz Answers
# alone, so its "Update now" button can run this same update. Repeated after
# every successful run, which keeps it pointing at the helper in this folder.
# Never throws: no registration only means no button, and the double-click
# still works. Returns $true when registered.
function Install-Helper {
  try {
    $helper = Join-Path $script:Dir 'updater\native-host.bat'
    if (-not (Test-Path -LiteralPath $helper)) { return $false }
    try { Unblock-File -LiteralPath $helper -ErrorAction SilentlyContinue } catch { }
    try { Unblock-File -LiteralPath (Join-Path $script:Dir 'updater\native-host.ps1') -ErrorAction SilentlyContinue } catch { }
    $origins = @(Get-ExtensionIds $script:Dir | ForEach-Object { "chrome-extension://$_/" })
    # QUIZ_ANSWERS_NATIVE_DIR is a test hook; Windows has no folder Chrome
    # searches, only the registry entry that names this file.
    $where = if ($env:QUIZ_ANSWERS_NATIVE_DIR) { $env:QUIZ_ANSWERS_NATIVE_DIR } else { Join-Path $env:LOCALAPPDATA 'Quiz Answers' }
    [void](New-Item -ItemType Directory -Force -Path $where)
    $file = Join-Path $where "$HelperName.json"
    $manifest = [ordered]@{
      name = $HelperName
      description = 'Quiz Answers: updates itself when its Update now button is pressed'
      path = $helper
      type = 'stdio'
      allowed_origins = $origins
    }
    [IO.File]::WriteAllText($file, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    if ($script:OnWindows -and -not $env:QUIZ_ANSWERS_NATIVE_DIR) {
      $key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HelperName"
      [void](New-Item -Path $key -Force)
      Set-Item -Path $key -Value $file
    }
    return $true
  } catch {
    return $false
  }
}

# Registers the helper, and says what that means for next time.
function Show-HelperReady {
  if (Install-Helper) {
    Write-Host ''
    Write-Host 'From now on Quiz Answers can update itself: when a new version is out,'
    Write-Host 'click "Update now" in its window.'
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

$script:Staging = Join-Path $script:Dir '.update-new'
$script:Backup = Join-Path $script:Dir '.update-old'
$script:Trash = Join-Path $script:Dir '.update-trash'

if (-not (Restore-InterruptedRun)) {
  Write-Host ''
  Write-Host 'Update failed: the last update did not finish, and the files it moved'
  Write-Host 'aside could not be put back. They are safe in the hidden ".update-old"'
  Write-Host 'folder inside Quiz Answers. Nothing else was changed.'
  Remove-Scratch
  Pause-ForReader
  exit 1
}

$script:InstalledVersion = (Read-Manifest $script:Dir).version
Write-Host "$AppName $($script:InstalledVersion)"
Write-Host 'Checking for a newer version...'

# Windows PowerShell 5.1 can default to TLS 1.0/1.1, which GitHub refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

try {
  $script:Work = Join-Path ([IO.Path]::GetTempPath()) ('quiz-answers-update-' + [Guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $script:Work)
  $zip = Join-Path $script:Work 'latest.zip'
  Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
} catch {
  Stop-WithFailure 'could not download the latest version. Check your internet connection and try again.'
}

try {
  # A leftover the last run could not delete is moved aside, not fought with.
  if (Test-Path -LiteralPath $script:Staging) { Send-ToTrash $script:Staging }
  [void](New-Item -ItemType Directory -Path $script:Staging)
  [void](New-Item -ItemType Directory -Path $script:Backup)
} catch {
  Stop-WithFailure "could not write to $($script:Dir)."
}

try {
  # Unpacked beside the extension, so every swap below is a rename on one disk.
  # -DestinationPath takes wildcards, so a [ or ] in the folder's path must be
  # escaped or the unpack fails.
  Expand-Archive -LiteralPath $zip -DestinationPath ([WildcardPattern]::Escape($script:Staging)) -Force
} catch {
  Stop-WithFailure "the download was damaged. Try again in a minute. ($($_.Exception.Message))"
}

$top = @(Get-ChildItem -LiteralPath $script:Staging -Directory)
if ($top.Count -lt 1 -or -not (Test-QuizAnswers $top[0].FullName)) { Stop-WithFailure 'the download does not look like Quiz Answers.' }
$script:Src = $top[0].FullName
$downloaded = (Read-Manifest $script:Src).version
if (-not $downloaded) { Stop-WithFailure 'the download has no version number.' }

if (-not (Test-Newer $downloaded $(if ($script:InstalledVersion) { $script:InstalledVersion } else { '0' }))) {
  Write-Host ''
  Write-Host "You already have the latest version ($($script:InstalledVersion))."
  Remove-Scratch
  Show-HelperReady
  Pause-ForReader
  exit 0
}

Write-Host "Installing $downloaded..."

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

# Done: the old version is now only clutter. Mark it so before anything else,
# so that a backup that will not go away is never mistaken for an unfinished
# update. Then throw it away.
try { [void](New-Item -ItemType File -Path (Join-Path $script:Backup '.finished')) } catch { }
try { Send-ToTrash $script:Backup } catch { }
Remove-Scratch

Write-Host ''
Write-Host "Updated $AppName from $($script:InstalledVersion) to $downloaded."
Write-Host ''
Write-Host 'Your API key and settings are untouched: they live in Chrome, and this'
Write-Host 'folder stayed exactly where it was.'
Write-Host ''
Write-Host 'Last step: click the Quiz Answers icon in Chrome. It usually switches to'
Write-Host 'the new version by itself; if it shows "Restart to finish", click that.'
Write-Host 'Keep "Developer mode" on at chrome://extensions - Quiz Answers only runs'
Write-Host 'while it is on.'
Show-HelperReady
Pause-ForReader
exit 0
