# The helper behind Quiz Answers' "Update now" button, on Windows. Chrome
# starts it through native-host.bat; read native-host.sh for what it is for.
#
# The protocol: Chrome writes a 4-byte little-endian length, then that many
# bytes of UTF-8 JSON; the reply goes back the same way. Nothing else may ever
# reach stdout - not even Write-Host, which goes there when output is a pipe.
#
# Kept to plain ASCII: Windows PowerShell 5.1 reads a script without a byte
# order mark as the local code page.

$ErrorActionPreference = 'Stop'
$HelperVersion = 1
$MaxMessage = 4096

function Read-Exactly($stream, [int]$count) {
  $buf = New-Object byte[] $count
  $got = 0
  while ($got -lt $count) {
    $n = $stream.Read($buf, $got, $count - $got)
    if ($n -le 0) { return $null }
    $got += $n
  }
  return ,$buf
}

function Read-Message {
  $in = [Console]::OpenStandardInput()
  $head = Read-Exactly $in 4
  if ($null -eq $head) { return $null }
  $len = [BitConverter]::ToInt32($head, 0)
  if ($len -le 0 -or $len -gt $MaxMessage) { return $null }
  $body = Read-Exactly $in $len
  if ($null -eq $body) { return $null }
  return [Text.Encoding]::UTF8.GetString($body)
}

function Write-Message([string]$json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $out = [Console]::OpenStandardOutput()
  $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

# Runs update.ps1 as its own process, with its own input and output, so nothing
# it prints can reach Chrome's pipe. Returns @(exit code, everything it printed).
function Invoke-Updater {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'update.ps1') + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return @($p.ExitCode, ($stdout.Result + $stderr))
}

try {
  $msg = Read-Message
  if ($null -eq $msg) { exit 1 }
  if ($msg -match '"type"\s*:\s*"update"') {
    $result = Invoke-Updater
    $code = [int]$result[0]
    $out = [string]$result[1]
    $summary = ($out -split "`r?`n" | Where-Object { $_ -match '^(Updated Quiz Answers|You already have|Update failed:|The last update did not finish|This does not look|This copy of Quiz Answers)' } | Select-Object -First 1)
    if ($out.Length -gt 3000) { $out = $out.Substring($out.Length - 3000) }
    $reply = @{ ok = ($code -eq 0); code = $code; summary = [string]$summary; output = $out }
  } else {
    $reply = @{ ok = $true; helper = $HelperVersion }
  }
  Write-Message ($reply | ConvertTo-Json -Compress)
} catch {
  # A reply Chrome can read is better than a pipe that just closes.
  try { Write-Message (@{ ok = $false; code = -1; summary = "The update helper failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress) } catch { }
  exit 1
}
