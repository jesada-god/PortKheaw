[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1024, 65535)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$BaseUrl,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$RunDirectory,

  [string]$StorageState = '',

  [string]$StorageStateSourceUrl = '',

  [string]$SaveStorageState = '',

  [switch]$SkipServer,

  [switch]$SkipAlertCreation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Get-LogTail {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return '(no log output)' }
  $lines = @(Get-Content -Tail 30 -LiteralPath $Path -ErrorAction SilentlyContinue)
  return $(if ($lines.Count) { $lines -join [Environment]::NewLine } else { '(no log output)' })
}

[IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($RunDirectory)) | Out-Null
$artifacts = Join-Path $RunDirectory 'browser'
$stopFile = Join-Path $RunDirectory 'server.stop.signal'
$serveHostOut = Join-Path $RunDirectory 'serve-host.stdout.log'
$serveHostError = Join-Path $RunDirectory 'serve-host.stderr.log'
$serverProcess = $null
$exitCode = 70

if (Test-Path -LiteralPath $stopFile) {
  Remove-Item -LiteralPath $stopFile -Force
}

try {
  if (-not $SkipServer) {
    $serveScript = (Join-Path $PSScriptRoot 'serve-for-qa.ps1').Replace("'", "''")
    $escapedStopFile = $stopFile.Replace("'", "''")
    $escapedRunDirectory = $RunDirectory.Replace("'", "''")
    $serveInvocation = "& '$serveScript' -Port $Port -StopFile '$escapedStopFile' -LogDirectory '$escapedRunDirectory' -ReadinessTimeoutSeconds 90"
    $serveEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($serveInvocation))
    $serverProcess = Start-Process `
      -FilePath 'powershell.exe' `
      -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', $serveEncoded
      ) `
      -WindowStyle Hidden `
      -RedirectStandardOutput $serveHostOut `
      -RedirectStandardError $serveHostError `
      -PassThru
    Write-Output ("QA_SERVER_HOST_START: PID={0}" -f $serverProcess.Id)

    $client = New-Object Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    $readyWatch = [Diagnostics.Stopwatch]::StartNew()
    $ready = $false
    try {
      while ($readyWatch.Elapsed.TotalSeconds -lt 90) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        try {
          $response = $client.GetAsync("$BaseUrl/auth/sign-in").GetAwaiter().GetResult()
          $status = [int]$response.StatusCode
          $response.Dispose()
          if ($status -ge 200 -and $status -lt 500) {
            $ready = $true
            break
          }
        } catch {
          # Retry on the fixed two-second cadence until the readiness deadline.
        }
        Start-Sleep -Seconds 2
      }
    } finally {
      $readyWatch.Stop()
      $client.Dispose()
    }

    if (-not $ready) {
      Write-Output ("QA_READINESS_FAILED: elapsed={0:n1}s" -f $readyWatch.Elapsed.TotalSeconds)
      Write-Output ("tail serve stdout:`n{0}" -f (Get-LogTail -Path $serveHostOut))
      Write-Output ("tail serve stderr:`n{0}" -f (Get-LogTail -Path $serveHostError))
      $exitCode = 75
      exit $exitCode
    }
    Write-Output ("QA_SERVER_READY: elapsed={0:n1}s url={1}" -f $readyWatch.Elapsed.TotalSeconds, $BaseUrl)
  }

  $nodeArguments = @(
    (Join-Path $PSScriptRoot 'price-alert-browser-qa.mjs'),
    '--base-url', $BaseUrl,
    '--output-dir', $artifacts,
    '--login-timeout-ms', '600000',
    '--viewport-timeout-ms', '300000',
    '--create-alert', $(if ($SkipAlertCreation) { 'false' } else { 'true' })
  )
  if ($StorageState -and (Test-Path -LiteralPath $StorageState)) {
    $nodeArguments += @('--storage-state', $StorageState)
  }
  if ($StorageStateSourceUrl) {
    $nodeArguments += @('--storage-state-source-url', $StorageStateSourceUrl)
  }
  if ($SaveStorageState) {
    $nodeArguments += @('--save-storage-state', $SaveStorageState)
  }

  & 'C:\Program Files\nodejs\node.exe' @nodeArguments
  $exitCode = $LASTEXITCODE
  Write-Output ("BROWSER_QA_EXIT: {0}" -f $exitCode)
} catch {
  [Console]::Error.WriteLine(("QA_ORCHESTRATOR_ERROR: {0}" -f $_.Exception.Message))
  $exitCode = 70
} finally {
  if ($serverProcess) {
    try {
      Set-Content -Encoding ascii -LiteralPath $stopFile -Value 'stop'
      $serverProcess.Refresh()
      if (-not $serverProcess.WaitForExit(20000)) {
        $taskkillOutput = @(& taskkill.exe /PID $serverProcess.Id /T /F 2>&1)
        Write-Output ("QA_SERVER_FORCE_CLEANUP: root={0}; {1}" -f $serverProcess.Id, (($taskkillOutput | ForEach-Object { [string]$_ }) -join ' | '))
        if ($LASTEXITCODE -ne 0 -and $exitCode -eq 0) { $exitCode = 70 }
      }
    } finally {
      $serverProcess.Dispose()
    }
  }
}

exit $exitCode
