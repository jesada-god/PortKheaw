[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1024, 65535)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$StopFile,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$LogDirectory,

  [ValidateRange(1, 300)]
  [int]$ReadinessTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Get-LogTail {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return '(no log output)'
  }
  $lines = @(Get-Content -Tail 20 -LiteralPath $Path -ErrorAction SilentlyContinue)
  return $(if ($lines.Count) { $lines -join [Environment]::NewLine } else { '(no log output)' })
}

[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($LogDirectory)) | Out-Null
$stdoutPath = Join-Path $LogDirectory 'server.stdout.log'
$stderrPath = Join-Path $LogDirectory 'server.stderr.log'
$pidPath = Join-Path $LogDirectory 'server.pid'
$server = $null
$http = $null
$exitCode = 75

try {
  $server = Start-Process `
    -FilePath 'C:\Program Files\nodejs\npm.cmd' `
    -ArgumentList @('run', 'start', '--', '-p', [string]$Port) `
    -WorkingDirectory (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  Set-Content -Encoding ascii -LiteralPath $pidPath -Value $server.Id
  Write-Output ("SERVER_START: PID={0} port={1}" -f $server.Id, $Port)

  $http = New-Object Net.Http.HttpClient
  $http.Timeout = [TimeSpan]::FromSeconds(2)
  $readiness = [Diagnostics.Stopwatch]::StartNew()
  $nextProbeAt = 0.0
  $ready = $false

  while ($readiness.Elapsed.TotalSeconds -lt $ReadinessTimeoutSeconds) {
    $server.Refresh()
    if ($server.HasExited) {
      break
    }

    if ($readiness.Elapsed.TotalSeconds -ge $nextProbeAt) {
      try {
        $response = $http.GetAsync("http://127.0.0.1:$Port/auth/sign-in").GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $response.Dispose()
        if ($status -ge 200 -and $status -lt 500) {
          $ready = $true
          break
        }
      } catch {
        # The server may still be compiling or binding. The outer deadline wins.
      }
      $nextProbeAt += 2
    }
    Start-Sleep -Milliseconds 200
  }
  $readiness.Stop()

  if (-not $ready) {
    Write-Output ("READINESS_FAILED: elapsed={0:n1}s PID={1}" -f $readiness.Elapsed.TotalSeconds, $server.Id)
    Write-Output ("tail stdout:`n{0}" -f (Get-LogTail -Path $stdoutPath))
    Write-Output ("tail stderr:`n{0}" -f (Get-LogTail -Path $stderrPath))
    $exitCode = 75
  } else {
    Write-Output ("SERVER_READY: elapsed={0:n1}s PID={1} url=http://127.0.0.1:{2}" -f $readiness.Elapsed.TotalSeconds, $server.Id, $Port)
    $exitCode = 0
    while (-not (Test-Path -LiteralPath $StopFile)) {
      $server.Refresh()
      if ($server.HasExited) {
        Write-Output 'SERVER_EXITED_BEFORE_STOP'
        Write-Output ("tail stdout:`n{0}" -f (Get-LogTail -Path $stdoutPath))
        Write-Output ("tail stderr:`n{0}" -f (Get-LogTail -Path $stderrPath))
        $exitCode = 75
        break
      }
      Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $StopFile) {
      Write-Output 'STOP_SIGNAL_RECEIVED'
    }
  }
} catch {
  [Console]::Error.WriteLine(("SERVER_ERROR: {0}" -f $_.Exception.Message))
  $exitCode = 75
} finally {
  if ($http) {
    $http.Dispose()
  }
  if ($server) {
    try {
      $server.Refresh()
      if (-not $server.HasExited) {
        $taskkillOutput = @(& taskkill.exe /PID $server.Id /T /F 2>&1)
        $taskkillExit = $LASTEXITCODE
        Write-Output ("SERVER_CLEANUP: root={0}; {1}" -f $server.Id, (($taskkillOutput | ForEach-Object { [string]$_ }) -join ' | '))
        if ($taskkillExit -ne 0) {
          [Console]::Error.WriteLine(("SERVER_CLEANUP_FAILED: root={0} exit={1}" -f $server.Id, $taskkillExit))
          if ($exitCode -eq 0) { $exitCode = 70 }
        }
      }
    } finally {
      $server.Dispose()
    }
  }
}

exit $exitCode
