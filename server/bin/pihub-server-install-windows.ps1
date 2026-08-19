param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$NodePath,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$ServerPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')][string]$ExpectedVersion,
  [ValidateSet("install", "status", "repair", "logs", "uninstall")][string]$Operation = "install",
  [switch]$ValidateDefinition,
  [switch]$RunServer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$taskName = "PiHub Server"
$healthUri = "http://127.0.0.1:30141/api/health"

function Resolve-RegularFile {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if ($LiteralPath.IndexOf([char]0) -ge 0 -or $LiteralPath.Contains("`r") -or $LiteralPath.Contains("`n")) {
    throw "$Description contains unsupported control characters."
  }
  $isDriveAbsolute = $LiteralPath -match '^[A-Za-z]:[\\/]'
  $isUncAbsolute = $LiteralPath -match '^\\\\(?![?.](?:\\|$))[^\\]+\\[^\\]+(?:\\|$)'
  $isExtendedDriveAbsolute = $LiteralPath -match '^\\\\\?\\[A-Za-z]:\\'
  $isExtendedUncAbsolute = $LiteralPath -match '^\\\\\?\\UNC\\[^\\]+\\[^\\]+(?:\\|$)'
  if (-not ($isDriveAbsolute -or $isUncAbsolute -or $isExtendedDriveAbsolute -or $isExtendedUncAbsolute)) {
    throw "$Description must be an absolute path."
  }
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Description must be a regular file and cannot be a symbolic link or junction."
  }
  return $item.FullName
}

function ConvertTo-WindowsCommandLineArgument {
  param([AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $quoted = [System.Text.StringBuilder]::new()
  [void]$quoted.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      [void]$quoted.Append(('\' * (($backslashes * 2) + 1)))
      [void]$quoted.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$quoted.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$quoted.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$quoted.Append(('\' * ($backslashes * 2)))
  }
  [void]$quoted.Append('"')
  return $quoted.ToString()
}

function Write-PiHubJson {
  param([Parameter(Mandatory = $true)]$Value)
  Write-Output ($Value | ConvertTo-Json -Compress -Depth 4)
}

function New-PiHubTaskComponents {
  param(
    [Parameter(Mandatory = $true)][string]$PowerShellPath,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$NodeFile,
    [Parameter(Mandatory = $true)][string]$ServerFile,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$IdentityName
  )

  $taskArgumentValues = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $InstallerPath,
    "-RunServer",
    "-NodePath",
    $NodeFile,
    "-ServerPath",
    $ServerFile,
    "-ExpectedVersion",
    $Version
  )
  $taskArguments = ($taskArgumentValues | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value $_ }) -join " "
  $workingDirectory = Split-Path -Parent $ServerFile
  $action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $taskArguments -WorkingDirectory $workingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $IdentityName
  $settings = New-ScheduledTaskSettingsSet `
    -RestartCount 100 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

  # InteractiveToken keeps PiHub in the signed-in user's session so ConPTY is
  # available, while Limited prevents an administrator account from elevating it.
  $principal = New-ScheduledTaskPrincipal -UserId $IdentityName -LogonType Interactive -RunLevel Limited
  return [pscustomobject]@{
    Action = $action
    Trigger = $trigger
    Settings = $settings
    Principal = $principal
    Definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "PiHub current-user server"
    ValidationDefinition = New-ScheduledTask -Action $action -Settings $settings -Principal $principal -Description "Temporary PiHub registration validation"
    TaskArguments = $taskArguments
    WorkingDirectory = $workingDirectory
  }
}

function Set-PrivateDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Owner
  )

  New-Item -ItemType Directory -Force -Path $LiteralPath | Out-Null
  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Refusing to use a non-directory, symbolic link, or junction for private PiHub state: $LiteralPath"
  }

  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($Owner)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $Owner,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
}

function Set-PrivateFile {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Owner
  )

  if (Test-Path -LiteralPath $LiteralPath) {
    $item = Get-Item -LiteralPath $LiteralPath -Force
    if ($item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "Refusing to use a non-regular file, symbolic link, or junction for a PiHub log: $LiteralPath"
    }
  } else {
    $stream = [System.IO.File]::Open(
      $LiteralPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::Read
    )
    $stream.Dispose()
  }

  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($Owner)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $Owner,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $LiteralPath -AclObject $acl
}

function Test-PrivateAcl {
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][System.Security.Principal.SecurityIdentifier]$Owner
  )

  $acl = Get-Acl -LiteralPath $LiteralPath
  $actualOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  $rules = @($acl.GetAccessRules(
    $true,
    $false,
    [System.Security.Principal.SecurityIdentifier]
  ))
  return ($acl.AreAccessRulesProtected -and
    $actualOwner.Equals($Owner) -and
    $rules.Count -eq 1 -and
    $rules[0].IdentityReference.Equals($Owner) -and
    $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
      [System.Security.AccessControl.FileSystemRights]::FullControl))
}

function Stop-TaskAndWait {
  param([Parameter(Mandatory = $true)][string]$Name)

  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $task -or $task.State -ne "Running") {
    return
  }
  Stop-ScheduledTask -TaskName $Name
  for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
    Start-Sleep -Milliseconds 100
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($null -eq $task -or $task.State -ne "Running") {
      return
    }
  }
  throw "Scheduled task '$Name' did not stop within five seconds."
}

function Get-PiHubHealthSnapshot {
  try {
    $response = Invoke-RestMethod `
      -Uri $healthUri `
      -Method Get `
      -TimeoutSec 2 `
      -Headers @{ Accept = "application/json"; "Cache-Control" = "no-store" }
    $version = if ($response.version -is [string]) { $response.version } else { $null }
    if ($response.status -ne "ok") {
      return [pscustomobject]@{ healthy = $false; reason = "invalid_status"; version = $version }
    }
    if ($version -ne $ExpectedVersion) {
      return [pscustomobject]@{ healthy = $false; reason = "version_mismatch"; version = $version }
    }
    return [pscustomobject]@{ healthy = $true; reason = $null; version = $version }
  } catch {
    return [pscustomobject]@{ healthy = $false; reason = "unreachable"; version = $null }
  }
}

function Wait-PiHubHealth {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $lastReason = "unreachable"
  do {
    $snapshot = Get-PiHubHealthSnapshot
    if ($snapshot.healthy) {
      return
    }
    $lastReason = $snapshot.reason
    if ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 400
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "PiHub did not pass its local health check: $lastReason"
}

$nodeFile = Resolve-RegularFile -LiteralPath $NodePath -Description "Node.js executable"
$serverFile = Resolve-RegularFile -LiteralPath $ServerPath -Description "PiHub server entry point"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$serverArguments = @($serverFile, "--no-open", "--hostname", "127.0.0.1", "--port", "30141")

if ($ValidateDefinition) {
  if ($RunServer) {
    throw "ValidateDefinition and RunServer cannot be used together."
  }
  $validationPowerShellPath = Resolve-RegularFile -LiteralPath (Join-Path $PSHOME "powershell.exe") -Description "Windows PowerShell executable"
  $validationInstallerPath = Resolve-RegularFile -LiteralPath $PSCommandPath -Description "PiHub Windows service wrapper"
  $components = New-PiHubTaskComponents `
    -PowerShellPath $validationPowerShellPath `
    -InstallerPath $validationInstallerPath `
    -NodeFile $nodeFile `
    -ServerFile $serverFile `
    -Version $ExpectedVersion `
    -IdentityName $identity.Name
  $actions = @($components.Definition.Actions)
  if ($actions.Count -ne 1 -or
      -not [string]::Equals($actions[0].Execute, $validationPowerShellPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      $actions[0].Arguments -ne $components.TaskArguments -or
      -not [string]::Equals($actions[0].WorkingDirectory, $components.WorkingDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The in-memory PiHub scheduled task action is invalid."
  }
  if ([string]$components.Principal.RunLevel -ne "Limited") {
    throw "The in-memory PiHub scheduled task principal is not limited."
  }
  if (@($components.Definition.Triggers).Count -ne 1) {
    throw "The in-memory PiHub scheduled task must have one logon trigger."
  }
  $aclScratch = Join-Path ([System.IO.Path]::GetTempPath()) "pihub-service-validation-$([Guid]::NewGuid().ToString('N'))"
  try {
    Set-PrivateDirectory -LiteralPath $aclScratch -Owner $identity.User
    $aclFile = Join-Path $aclScratch "server.log"
    Set-PrivateFile -LiteralPath $aclFile -Owner $identity.User
    if (-not (Test-PrivateAcl -LiteralPath $aclScratch -Owner $identity.User) -or
        -not (Test-PrivateAcl -LiteralPath $aclFile -Owner $identity.User)) {
      throw "The temporary PiHub state ACL is not private to the current user."
    }
  } finally {
    Remove-Item -LiteralPath $aclScratch -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-PiHubJson ([ordered]@{
    schemaVersion = 1
    command = "validate-definition"
    platform = "win32"
    definitionSafe = $true
    aclValidated = $true
    registered = $false
    runLevel = [string]$components.Principal.RunLevel
  })
  exit 0
}

$windowsPrincipal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if ($windowsPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "PiHub must be installed and run from a non-elevated terminal. Do not run this installer as Administrator."
}

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is unavailable; refusing to create persistent PiHub state."
}
$stateDirectory = Join-Path $env:LOCALAPPDATA "PiHub"
$logDirectory = Join-Path $stateDirectory "logs"
$stdoutLog = Join-Path $logDirectory "server.log"
$stderrLog = Join-Path $logDirectory "server-error.log"

if ($RunServer) {
  Set-PrivateDirectory -LiteralPath $stateDirectory -Owner $identity.User
  Set-PrivateDirectory -LiteralPath $logDirectory -Owner $identity.User
  Set-PrivateFile -LiteralPath $stdoutLog -Owner $identity.User
  Set-PrivateFile -LiteralPath $stderrLog -Owner $identity.User
  $env:PIHUB_LOG_DIRECTORY = $logDirectory
  & $nodeFile @serverArguments 1>$null 2>$null
  exit $LASTEXITCODE
}

if ($Operation -eq "logs") {
  Write-PiHubJson ([ordered]@{
    schemaVersion = 1
    command = "logs"
    platform = "win32"
    stdout = $stdoutLog
    stderr = $stderrLog
    maxBytes = 5242880
    backups = 1
    retainedOnUninstall = $true
  })
  exit 0
}

$powerShellPath = Resolve-RegularFile -LiteralPath (Join-Path $PSHOME "powershell.exe") -Description "Windows PowerShell executable"
$installerPath = Resolve-RegularFile -LiteralPath $PSCommandPath -Description "PiHub Windows service wrapper"
$taskComponents = New-PiHubTaskComponents `
  -PowerShellPath $powerShellPath `
  -InstallerPath $installerPath `
  -NodeFile $nodeFile `
  -ServerFile $serverFile `
  -Version $ExpectedVersion `
  -IdentityName $identity.Name
$taskArguments = $taskComponents.TaskArguments
$workingDirectory = $taskComponents.WorkingDirectory

function Get-PiHubTaskSnapshot {
  param([string]$CommandName = "status")

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $installed = $null -ne $task
  $active = $installed -and $task.State -eq "Running"
  $enabled = $installed -and $task.State -ne "Disabled"
  $configured = $false
  if ($installed) {
    $actions = @($task.Actions)
    if ($actions.Count -eq 1) {
      $configured = [string]::Equals($actions[0].Execute, $powerShellPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        $actions[0].Arguments -eq $taskArguments -and
        [string]::Equals($actions[0].WorkingDirectory, $workingDirectory, [System.StringComparison]::OrdinalIgnoreCase)
    }
  }
  $health = if ($active) {
    Get-PiHubHealthSnapshot
  } else {
    [pscustomobject]@{ healthy = $false; reason = "inactive"; version = $null }
  }
  $ready = $installed -and $configured -and $active -and $enabled -and $health.healthy
  $state = if (-not $installed) { "not-installed" } elseif ($ready) { "ready" } else { "degraded" }
  return [ordered]@{
    schemaVersion = 1
    command = $CommandName
    platform = "win32"
    service = $taskName
    state = $state
    installed = $installed
    configured = $configured
    definitionSafe = $true
    managerAvailable = $true
    active = $active
    enabled = $enabled
    healthy = $health.healthy
    healthReason = $health.reason
    version = $health.version
    expectedVersion = $ExpectedVersion
    ready = $ready
  }
}

if ($Operation -eq "status") {
  $snapshot = Get-PiHubTaskSnapshot -CommandName "status"
  Write-PiHubJson $snapshot
  if ($snapshot.ready) { exit 0 } else { exit 3 }
}

if ($Operation -eq "uninstall") {
  $previousTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $previousTask) {
    Write-PiHubJson ([ordered]@{
      schemaVersion = 1
      command = "uninstall"
      platform = "win32"
      state = "removed"
      removed = $false
      dataRetained = $true
    })
    exit 0
  }
  $previousXml = Export-ScheduledTask -TaskName $taskName
  $previousWasRunning = $previousTask.State -eq "Running"
  try {
    Stop-TaskAndWait -Name $taskName
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    if ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
      throw "The PiHub scheduled task still exists after uninstall."
    }
  } catch {
    $uninstallFailure = $_.Exception.Message
    $rollbackFailure = $null
    try {
      $currentTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
      if ($null -eq $currentTask) {
        Register-ScheduledTask -TaskName $taskName -Xml $previousXml -Force | Out-Null
        $currentTask = Get-ScheduledTask -TaskName $taskName
      }
      if ($previousWasRunning -and $currentTask.State -ne "Running") {
        Start-ScheduledTask -TaskName $taskName
      }
    } catch {
      $rollbackFailure = $_.Exception.Message
    }
    if ($null -ne $rollbackFailure) {
      throw "PiHub task uninstall failed: $uninstallFailure Rollback also failed: $rollbackFailure"
    }
    throw "PiHub task uninstall failed; the previous task state was restored: $uninstallFailure"
  }
  Write-PiHubJson ([ordered]@{
    schemaVersion = 1
    command = "uninstall"
    platform = "win32"
    state = "removed"
    removed = $true
    dataRetained = $true
  })
  exit 0
}

if ($Operation -eq "install") {
  $currentSnapshot = Get-PiHubTaskSnapshot -CommandName "install"
  if ($currentSnapshot.ready) {
    $currentSnapshot["changed"] = $false
    Write-PiHubJson $currentSnapshot
    Write-Output "PIHUB_WINDOWS_TASK_READY"
    exit 0
  }
}

Set-PrivateDirectory -LiteralPath $stateDirectory -Owner $identity.User
Set-PrivateDirectory -LiteralPath $logDirectory -Owner $identity.User
Set-PrivateFile -LiteralPath $stdoutLog -Owner $identity.User
Set-PrivateFile -LiteralPath $stderrLog -Owner $identity.User

$definition = $taskComponents.Definition
$validationDefinition = $taskComponents.ValidationDefinition

$previousTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$previousXml = $null
$previousWasRunning = $false
if ($null -ne $previousTask) {
  $previousXml = Export-ScheduledTask -TaskName $taskName
  $previousWasRunning = $previousTask.State -eq "Running"
}

$validationTaskName = "PiHub Server install validation $([Guid]::NewGuid().ToString('N'))"
$validationRegistered = $false
$replacementRegistered = $false
try {
  # Registering an inert temporary definition validates Task Scheduler access
  # and the candidate action before the existing task is touched.
  Register-ScheduledTask -TaskName $validationTaskName -InputObject $validationDefinition -Force | Out-Null
  $validationRegistered = $true
  Unregister-ScheduledTask -TaskName $validationTaskName -Confirm:$false
  $validationRegistered = $false

  # Task Scheduler replaces a definition atomically; -Force avoids the unsafe
  # unregister-then-register window that could destroy a working old task.
  Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
  $replacementRegistered = $true

  $registeredTask = Get-ScheduledTask -TaskName $taskName
  $registeredAction = @($registeredTask.Actions)[0]
  if (-not [string]::Equals($registeredAction.Execute, $powerShellPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      $registeredAction.Arguments -ne $taskArguments) {
    throw "Task Scheduler did not retain the expected PiHub executable and arguments."
  }

  Stop-TaskAndWait -Name $taskName
  Start-ScheduledTask -TaskName $taskName
  Wait-PiHubHealth
  $runningTask = Get-ScheduledTask -TaskName $taskName
  if ($runningTask.State -ne "Running") {
    throw "The PiHub scheduled task exited during its health check."
  }
  $installedSnapshot = Get-PiHubTaskSnapshot -CommandName $Operation
  $installedSnapshot["changed"] = $true
  Write-PiHubJson $installedSnapshot
  Write-Output "PIHUB_WINDOWS_TASK_READY"
} catch {
  $installFailure = $_
  $rollbackFailure = $null
  if ($replacementRegistered) {
    try {
      Stop-TaskAndWait -Name $taskName
      if ($null -ne $previousXml) {
        Register-ScheduledTask -TaskName $taskName -Xml $previousXml -Force | Out-Null
        if ($previousWasRunning) {
          Start-ScheduledTask -TaskName $taskName
        }
      } else {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
      }
    } catch {
      $rollbackFailure = $_.Exception.Message
    }
  }
  if ($null -ne $rollbackFailure) {
    throw "PiHub task installation failed: $($installFailure.Exception.Message) Rollback also failed: $rollbackFailure"
  }
  throw "PiHub task installation failed; the previous task state was restored: $($installFailure.Exception.Message)"
} finally {
  if ($validationRegistered) {
    Unregister-ScheduledTask -TaskName $validationTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}
