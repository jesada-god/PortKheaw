[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Command,

  [ValidateRange(1, 86400)]
  [int]$TimeoutSeconds = 60,

  [ValidateNotNullOrEmpty()]
  [string]$LogDirectory = 'C:\tmp\portkheaw-qa',

  [ValidateRange(0, 1)]
  [int]$RetryCount = 0,

  [ValidateNotNullOrEmpty()]
  [string]$Step = 'bounded-command',

  [string]$RunId = '',

  [int[]]$RetryableExitCodes = @(75),

  [switch]$RetryOnTimeout
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ProcessStartUtc {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

  try {
    return $Process.StartTime.ToUniversalTime()
  } catch {
    return $null
  }
}

function Test-LockOwnerAlive {
  param([Parameter(Mandatory = $true)]$Record)

  if (-not $Record.runnerPid) {
    return $false
  }

  $owner = Get-Process -Id ([int]$Record.runnerPid) -ErrorAction SilentlyContinue
  if (-not $owner) {
    return $false
  }

  if (-not $Record.runnerStartTimeUtc) {
    return $true
  }

  $actualStart = Get-ProcessStartUtc -Process $owner
  if (-not $actualStart) {
    return $true
  }

  try {
    $recordedStart = [DateTime]::Parse(
      [string]$Record.runnerStartTimeUtc,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind
    ).ToUniversalTime()
    return [Math]::Abs(($actualStart - $recordedStart).TotalSeconds) -lt 2
  } catch {
    return $true
  }
}

function Read-LockRecord {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-TailText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Lines = 6
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return '(no log output)'
  }

  $tail = @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue)
  if ($tail.Count -eq 0) {
    return '(no log output)'
  }
  return ($tail -join [Environment]::NewLine)
}

function Complete-RedirectedProcess {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)][System.Threading.Tasks.Task]$StdoutTask,
    [Parameter(Mandatory = $true)][System.Threading.Tasks.Task]$StderrTask,
    [Parameter(Mandatory = $true)][System.IO.Stream]$StdoutStream,
    [Parameter(Mandatory = $true)][System.IO.Stream]$StderrStream
  )

  $Process.WaitForExit()
  $StdoutTask.GetAwaiter().GetResult()
  $StderrTask.GetAwaiter().GetResult()
  $StdoutStream.Flush()
  $StderrStream.Flush()
}

function Stop-OwnedProcessTree {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $root = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
  if (-not $root) {
    return "PID $RootProcessId already exited"
  }

  $output = @(& taskkill.exe /PID $RootProcessId /T /F 2>&1)
  $taskkillExit = $LASTEXITCODE
  $summary = ($output | ForEach-Object { [string]$_ }) -join ' | '
  if ($taskkillExit -ne 0) {
    throw "taskkill failed for owned PID $RootProcessId (exit $taskkillExit): $summary"
  }
  return $summary
}

if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
}
if ($RunId -notmatch '^[A-Za-z0-9._-]+$') {
  throw 'RunId may contain only letters, numbers, dot, underscore, and hyphen.'
}

$resolvedLogRoot = [IO.Path]::GetFullPath($LogDirectory)
$runDirectory = Join-Path $resolvedLogRoot $RunId
$lockPath = Join-Path $resolvedLogRoot '.portkheaw-qa.lock.json'
$runner = Get-Process -Id $PID
$runnerStartedUtc = Get-ProcessStartUtc -Process $runner
$ownsLock = $false
$spawnedProcess = $null
$spawnedPid = 0
$finalExitCode = 70

try {
  [IO.Directory]::CreateDirectory($resolvedLogRoot) | Out-Null

  if (Test-Path -LiteralPath $lockPath) {
    $existingLock = Read-LockRecord -Path $lockPath
    if (-not $existingLock -or -not $existingLock.runnerPid) {
      throw 'QA_LOCKED: existing lock is unreadable, so its owner PID cannot be verified'
    }
    if (Test-LockOwnerAlive -Record $existingLock) {
      throw "QA_LOCKED: run $($existingLock.runId) is owned by live PID $($existingLock.runnerPid)"
    }
    Remove-Item -LiteralPath $lockPath -Force
    Write-Output 'STALE_LOCK_REMOVED'
  }

  $lockPayload = [ordered]@{
    runId = $RunId
    runnerPid = $PID
    runnerStartTimeUtc = if ($runnerStartedUtc) { $runnerStartedUtc.ToString('o') } else { $null }
    step = $Step
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  $lockBytes = [Text.Encoding]::UTF8.GetBytes($lockPayload)
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    } finally {
      $lockStream.Dispose()
    }
    $ownsLock = $true
  } catch [IO.IOException] {
    throw 'QA_LOCKED: another runner acquired the lock concurrently'
  }

  [IO.Directory]::CreateDirectory($runDirectory) | Out-Null
  $metadataPath = Join-Path $runDirectory 'run.json'
  [ordered]@{
    runId = $RunId
    step = $Step
    timeoutSeconds = $TimeoutSeconds
    retryCount = $RetryCount
    runnerPid = $PID
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $metadataPath

  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  $powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source

  for ($attempt = 0; $attempt -le $RetryCount; $attempt++) {
    $attemptNumber = $attempt + 1
    $stdoutPath = Join-Path $runDirectory ("stdout.attempt-{0}.log" -f $attemptNumber)
    $stderrPath = Join-Path $runDirectory ("stderr.attempt-{0}.log" -f $attemptNumber)
    $attemptStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $nextHeartbeatSeconds = 15
    $timedOut = $false
    $spawnedProcess = $null
    $spawnedPid = 0
    $stdoutStream = $null
    $stderrStream = $null
    $stdoutTask = $null
    $stderrTask = $null
    $streamsCompleted = $false

    try {
      $startInfo = [Diagnostics.ProcessStartInfo]::new()
      $startInfo.FileName = $powershellPath
      $startInfo.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
      $startInfo.UseShellExecute = $false
      $startInfo.CreateNoWindow = $true
      $startInfo.RedirectStandardOutput = $true
      $startInfo.RedirectStandardError = $true

      $spawnedProcess = [Diagnostics.Process]::new()
      $spawnedProcess.StartInfo = $startInfo
      if (-not $spawnedProcess.Start()) {
        throw "Failed to start bounded command for step $Step"
      }
      $spawnedPid = $spawnedProcess.Id
      $stdoutStream = [IO.File]::Open($stdoutPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      $stderrStream = [IO.File]::Open($stderrPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      $stdoutTask = $spawnedProcess.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
      $stderrTask = $spawnedProcess.StandardError.BaseStream.CopyToAsync($stderrStream)
      Write-Output ("START: step={0} attempt={1}/{2} PID={3} run-id={4}" -f $Step, $attemptNumber, ($RetryCount + 1), $spawnedPid, $RunId)

      [ordered]@{
        runId = $RunId
        step = $Step
        attempt = $attemptNumber
        spawnedPid = $spawnedPid
        stdout = $stdoutPath
        stderr = $stderrPath
        startedAtUtc = [DateTime]::UtcNow.ToString('o')
      } | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $runDirectory 'process.json')

      while ($true) {
        $spawnedProcess.Refresh()
        if ($spawnedProcess.HasExited) {
          break
        }

        if ($attemptStopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
          $timedOut = $true
          break
        }

        if ($attemptStopwatch.Elapsed.TotalSeconds -ge $nextHeartbeatSeconds) {
          Write-Output ("HEARTBEAT: step={0} elapsed={1:n0}s PID={2}" -f $Step, $attemptStopwatch.Elapsed.TotalSeconds, $spawnedPid)
          Write-Output ("tail stdout:`n{0}" -f (Get-TailText -Path $stdoutPath))
          Write-Output ("tail stderr:`n{0}" -f (Get-TailText -Path $stderrPath))
          $nextHeartbeatSeconds += 15
        }

        Start-Sleep -Milliseconds 250
      }

      if ($timedOut) {
        $treeResult = Stop-OwnedProcessTree -RootProcessId $spawnedPid
        Complete-RedirectedProcess -Process $spawnedProcess -StdoutTask $stdoutTask -StderrTask $stderrTask -StdoutStream $stdoutStream -StderrStream $stderrStream
        $streamsCompleted = $true
        $finalExitCode = 124
        $willRetry = $attempt -lt $RetryCount -and $RetryOnTimeout.IsPresent
        Write-Output ("TIMEOUT: {0}" -f $Step)
        Write-Output ("elapsed: {0:n1}s" -f $attemptStopwatch.Elapsed.TotalSeconds)
        Write-Output ("PID/tree closed: root={0}; {1}" -f $spawnedPid, $treeResult)
        Write-Output ("tail stdout:`n{0}" -f (Get-TailText -Path $stdoutPath -Lines 12))
        Write-Output ("tail stderr:`n{0}" -f (Get-TailText -Path $stderrPath -Lines 12))
        Write-Output ("retry/result: {0}" -f $(if ($willRetry) { "retry $($attemptNumber + 1)/$($RetryCount + 1)" } else { 'no retry; exit 124' }))
        if ($willRetry) {
          continue
        }
        break
      }

      Complete-RedirectedProcess -Process $spawnedProcess -StdoutTask $stdoutTask -StderrTask $stderrTask -StdoutStream $stdoutStream -StderrStream $stderrStream
      $streamsCompleted = $true
      $finalExitCode = $spawnedProcess.ExitCode
      Write-Output ("EXIT: step={0} elapsed={1:n1}s PID={2} code={3}" -f $Step, $attemptStopwatch.Elapsed.TotalSeconds, $spawnedPid, $finalExitCode)
      if ($finalExitCode -eq 0) {
        break
      }

      $retryable = $RetryableExitCodes -contains $finalExitCode
      $willRetry = $attempt -lt $RetryCount -and $retryable
      Write-Output ("tail stdout:`n{0}" -f (Get-TailText -Path $stdoutPath -Lines 12))
      Write-Output ("tail stderr:`n{0}" -f (Get-TailText -Path $stderrPath -Lines 12))
      Write-Output ("retry/result: {0}" -f $(if ($willRetry) { "retry $($attemptNumber + 1)/$($RetryCount + 1)" } else { "no retry; exit $finalExitCode" }))
      if (-not $willRetry) {
        break
      }
    } finally {
      $attemptStopwatch.Stop()
      if ($spawnedProcess) {
        $spawnedProcess.Refresh()
        if (-not $spawnedProcess.HasExited) {
          $cleanupResult = Stop-OwnedProcessTree -RootProcessId $spawnedPid
          Write-Output ("CLEANUP: root={0}; {1}" -f $spawnedPid, $cleanupResult)
        }
        if (-not $streamsCompleted -and $stdoutTask -and $stderrTask -and $stdoutStream -and $stderrStream) {
          Complete-RedirectedProcess -Process $spawnedProcess -StdoutTask $stdoutTask -StderrTask $stderrTask -StdoutStream $stdoutStream -StderrStream $stderrStream
        }
        if ($stdoutTask) { $stdoutTask.Dispose() }
        if ($stderrTask) { $stderrTask.Dispose() }
        if ($stdoutStream) { $stdoutStream.Dispose() }
        if ($stderrStream) { $stderrStream.Dispose() }
        $spawnedProcess.Dispose()
        $spawnedProcess = $null
        $spawnedPid = 0
      }
    }
  }
} catch {
  [Console]::Error.WriteLine(("ERROR: {0}" -f $_.Exception.Message))
  $finalExitCode = 70
} finally {
  if ($spawnedProcess) {
    try {
      $spawnedProcess.Refresh()
      if (-not $spawnedProcess.HasExited -and $spawnedPid -gt 0) {
        $cleanupResult = Stop-OwnedProcessTree -RootProcessId $spawnedPid
        Write-Output ("CLEANUP: root={0}; {1}" -f $spawnedPid, $cleanupResult)
      }
    } catch {
      [Console]::Error.WriteLine(("Cleanup failed for owned PID {0}: {1}" -f $spawnedPid, $_.Exception.Message))
    } finally {
      $spawnedProcess.Dispose()
    }
  }

  try {
    if ($ownsLock -and (Test-Path -LiteralPath $lockPath)) {
      $currentLock = Read-LockRecord -Path $lockPath
      if ($currentLock -and [string]$currentLock.runId -eq $RunId -and [int]$currentLock.runnerPid -eq $PID) {
        Remove-Item -LiteralPath $lockPath -Force
      }
    }
  } catch {
    [Console]::Error.WriteLine(("Lock cleanup failed for run {0}: {1}" -f $RunId, $_.Exception.Message))
    $finalExitCode = 70
  }
}

Write-Output ("RESULT: step={0} run-id={1} exit={2} logs={3}" -f $Step, $RunId, $finalExitCode, $runDirectory)
exit $finalExitCode
