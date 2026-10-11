[CmdletBinding()]
param(
    [string]$ThreadId = $env:CODEX_THREAD_ID,
    [string]$SshHost = 'wsl',
    [switch]$Background,
    [string]$RunDirectory,
    [string]$CodexWrapper = (Join-Path $env:USERPROFILE '.codex/scripts/codex-internal.ps1')
)

$ErrorActionPreference = 'Stop'
if ($ThreadId -notmatch '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') {
    throw 'Pass the requesting Codex thread UUID with -ThreadId or CODEX_THREAD_ID.'
}
if ([string]::IsNullOrWhiteSpace($SshHost)) { throw 'An SSH host is required for the full suite.' }
$CodexWrapper = (Resolve-Path -LiteralPath $CodexWrapper).Path
$repoRoot = Split-Path -Parent $PSScriptRoot
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
if (-not $RunDirectory) {
    $runId = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N')
    $RunDirectory = Join-Path $repoRoot ".test-runs/$runId"
}
$RunDirectory = [IO.Path]::GetFullPath($RunDirectory)
if (Test-Path -LiteralPath $RunDirectory) {
    throw "Run directory already exists; refusing to rerun: $RunDirectory"
}

if ($Background) {
    function Literal([string]$value) { return "'" + $value.Replace("'", "''") + "'" }
    $workerCommand = '& ' + (Literal $PSCommandPath) + ' -ThreadId ' + (Literal $ThreadId) +
        ' -SshHost ' + (Literal $SshHost) + ' -RunDirectory ' + (Literal $RunDirectory) +
        ' -CodexWrapper ' + (Literal $CodexWrapper) + '; exit $LASTEXITCODE'
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($workerCommand))
    $worker = Start-Process -FilePath powershell.exe -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    ) -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    [ordered]@{ runDirectory = $RunDirectory; pid = $worker.Id; threadId = $ThreadId } | ConvertTo-Json
    return
}

New-Item -ItemType Directory -Path $RunDirectory -ErrorAction Stop | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
function Save-Json([string]$path, $value) {
    [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 8), $utf8)
}
$logPath = Join-Path $RunDirectory 'test.log'
$resultPath = Join-Path $RunDirectory 'result.json'
$queuePath = Join-Path $RunDirectory 'notification.json'
$startedAt = [DateTime]::UtcNow.ToString('o')
Save-Json (Join-Path $RunDirectory 'started.json') ([ordered]@{
    threadId = $ThreadId; startedAt = $startedAt; pid = $PID
    command = 'npm test'; sshHost = $SshHost
})
$testExitCode = 1
$testError = $null
$oldSshHost = $env:CLINE_SDK_TEST_SSH_HOST
Push-Location -LiteralPath $repoRoot
try {
    $env:CLINE_SDK_TEST_SSH_HOST = $SshHost
    # Native stderr must be logged rather than turn npm's failure into an early exception.
    $ErrorActionPreference = 'Continue'
    & $npmCommand test *>&1 | Out-File -LiteralPath $logPath -Encoding utf8
    $testExitCode = $LASTEXITCODE
    if ($null -eq $testExitCode) { $testExitCode = 1 }
} catch {
    $testError = $_.Exception.Message
    $testError | Out-File -LiteralPath $logPath -Encoding utf8 -Append
} finally {
    $ErrorActionPreference = 'Stop'
    if ($null -eq $oldSshHost) { Remove-Item Env:\CLINE_SDK_TEST_SSH_HOST -ErrorAction SilentlyContinue }
    else { $env:CLINE_SDK_TEST_SSH_HOST = $oldSshHost }
    Pop-Location
}
$status = if ($testExitCode -eq 0) { 'passed' } else { 'failed' }
$runId = Split-Path -Leaf $RunDirectory
Save-Json $resultPath ([ordered]@{
    runId = $runId; threadId = $ThreadId; status = $status; exitCode = $testExitCode
    startedAt = $startedAt; finishedAt = [DateTime]::UtcNow.ToString('o')
    command = 'npm test'; sshHost = $SshHost; logPath = $logPath; error = $testError
})

# Save the test outcome before the one queue attempt. Queue failure never reruns tests.
$eventText = "[test-run-completed] runId=$runId status=$status exitCode=$testExitCode result=$resultPath log=$logPath. Read these files and report the result; do not rerun tests automatically."
$queueExitCode = 1
$queueError = $null
try {
    $ErrorActionPreference = 'Continue'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $CodexWrapper queue --thread $ThreadId --message $eventText *>&1 |
        Out-File -LiteralPath (Join-Path $RunDirectory 'queue.log') -Encoding utf8
    $queueExitCode = $LASTEXITCODE
    if ($null -eq $queueExitCode) { $queueExitCode = 1 }
} catch { $queueError = $_.Exception.Message }
finally { $ErrorActionPreference = 'Stop' }
Save-Json $queuePath ([ordered]@{
    threadId = $ThreadId; attemptedAt = [DateTime]::UtcNow.ToString('o')
    exitCode = $queueExitCode; requestAccepted = ($queueExitCode -eq 0)
    error = $queueError; logPath = (Join-Path $RunDirectory 'queue.log')
})
if ($testExitCode -ne 0) { exit $testExitCode }
if ($queueExitCode -ne 0) { exit $queueExitCode }
exit 0
