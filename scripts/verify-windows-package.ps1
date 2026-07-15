param(
  [string]$PackageDirectory = '',
  [string]$PackageArchive = ''
)

$ErrorActionPreference = 'Stop'
$port = 4317
$testRoot = Join-Path $env:TEMP 'obs-stream-manager-package-verification-automated'
$runtime = Join-Path $testRoot 'win-unpacked'
$dataDirectory = Join-Path $testRoot 'data'
$secretService = 'obs-stream-manager-package-verification-automated'
$secretMarker = 'VERIFY-SECRET-8f429421-2db8-47bb-af75-4f0731c7f1c2'
$originalPath = $env:PATH
$originalDataDirectory = $env:OBS_STREAM_MANAGER_DATA_DIR
$originalSecretService = $env:OBS_STREAM_MANAGER_SECRET_SERVICE
$originalDisableLoginItem = $env:OBS_STREAM_MANAGER_DISABLE_LOGIN_ITEM

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Wait-ForListener([bool]$Present, [int]$TimeoutSeconds = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ([bool]$listener -eq $Present) { return $listener }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw "Port $port did not reach expected listener state: $Present"
}

function Get-TestProcesses {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtime, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Stop-TestApp {
  $quit = Start-Process -FilePath $exe -ArgumentList '--quit' -WorkingDirectory $runtime -PassThru
  Assert-True $quit.WaitForExit(10000) 'Quit command process did not exit'
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $remaining = Get-TestProcesses
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $remaining -and -not $listener) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'Packaged application did not terminate cleanly'
}

$results = [ordered]@{}
try {
  if ($PackageDirectory -and $PackageArchive) { throw 'Specify either PackageDirectory or PackageArchive, not both' }
  if (-not $PackageDirectory -and -not $PackageArchive) {
    $PackageDirectory = Join-Path $PSScriptRoot '..\release\win-unpacked'
  }

  $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP)
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  Assert-True ($resolvedTestRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) 'Unsafe test directory'
  Assert-True (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) "Port $port is already in use"
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $testRoot, $dataDirectory | Out-Null
  if ($PackageArchive) {
    $resolvedArchive = (Resolve-Path -LiteralPath $PackageArchive).Path
    Assert-True ([IO.Path]::GetExtension($resolvedArchive) -eq '.zip') 'Package archive must be a ZIP file'
    Expand-Archive -LiteralPath $resolvedArchive -DestinationPath $runtime
    $results.archiveExtracted = $true
  } else {
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $PackageDirectory).Path -Destination $runtime -Recurse
  }
  $exe = Join-Path $runtime 'OBS Stream Manager.exe'
  Assert-True ([bool](Test-Path -LiteralPath $exe)) 'Packaged executable is missing'
  $obsPlugin = Join-Path $runtime 'resources\obs-plugin\bin\64bit\obs-stream-manager-output.dll'
  Assert-True ([bool](Test-Path -LiteralPath $obsPlugin)) 'Bundled OBS output plugin is missing'
  $obsPluginLocale = Join-Path $runtime 'resources\obs-plugin\data\locale\en-US.ini'
  Assert-True ([bool](Test-Path -LiteralPath $obsPluginLocale)) 'Bundled OBS output plugin locale is missing'
  $obsPluginVersionFile = Join-Path $runtime 'resources\obs-plugin\version.json'
  Assert-True ([bool](Test-Path -LiteralPath $obsPluginVersionFile)) 'Bundled OBS output plugin version metadata is missing'
  $obsPluginVersion = Get-Content -LiteralPath $obsPluginVersionFile -Raw | ConvertFrom-Json
  $expectedVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
  Assert-True ($obsPluginVersion.version -eq $expectedVersion) "Unexpected OBS output plugin version: $($obsPluginVersion.version), expected $expectedVersion"

  Add-Type -AssemblyName System.Drawing
  $appIcon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
  Assert-True ($null -ne $appIcon) 'Packaged executable icon is missing'
  $iconBitmap = $appIcon.ToBitmap()
  $iconCenter = $iconBitmap.GetPixel([Math]::Floor($iconBitmap.Width / 2), [Math]::Floor($iconBitmap.Height / 2))
  $iconBrand = $iconBitmap.GetPixel([Math]::Floor($iconBitmap.Width / 4), [Math]::Floor($iconBitmap.Height / 4))
  $results.customAppIcon = $iconCenter.R -lt 50 -and $iconCenter.G -lt 50 -and $iconCenter.B -lt 50 -and $iconBrand.B -gt 120
  $iconBitmap.Dispose()
  $appIcon.Dispose()

  $env:OBS_STREAM_MANAGER_DATA_DIR = $dataDirectory
  $env:OBS_STREAM_MANAGER_SECRET_SERVICE = $secretService
  $env:OBS_STREAM_MANAGER_DISABLE_LOGIN_ITEM = '1'
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $results.nodeOnPath = [bool](Get-Command node -ErrorAction SilentlyContinue)

  Start-Process -FilePath $exe -WorkingDirectory $runtime
  $listener = Wait-ForListener $true
  $health = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 10
  $web = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10
  $favicon = Invoke-WebRequest "http://127.0.0.1:$port/favicon.svg" -UseBasicParsing -TimeoutSec 10
  $desktopPreferences = Get-Content (Join-Path $dataDirectory 'config\desktop.json') -Raw | ConvertFrom-Json
  $results.freshStart = $health.ok -and $health.dataDirectory -eq $dataDirectory
  $results.loopbackOnly = @($listener | Where-Object LocalAddress -ne '127.0.0.1').Count -eq 0
  $results.securityHeaders = $web.Headers['Content-Security-Policy'] -match "script-src 'self'" -and $web.Headers['X-Content-Type-Options'] -eq 'nosniff'
  $results.customFavicon = $favicon.StatusCode -eq 200 -and $favicon.Headers['Content-Type'] -match '^image/svg\+xml' -and $web.Content -match 'href="/favicon\.svg"'
  try {
    Invoke-WebRequest "http://127.0.0.1:$port/api/stream/stop" -Method Post -Headers @{ Origin = 'https://evil.example'; 'Sec-Fetch-Site' = 'cross-site' } -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 10 | Out-Null
    $results.crossOriginMutationBlocked = $false
  } catch {
    $results.crossOriginMutationBlocked = $_.Exception.Response.StatusCode.value__ -eq 403
  }
  $results.extractedPackageDoesNotAutoStart = -not $desktopPreferences.startWithWindows -and -not (Test-Path (Join-Path $runtime 'resources\installed-by-nsis'))
  $firstProcessCount = (Get-TestProcesses).Count

  $second = Start-Process -FilePath $exe -WorkingDirectory $runtime -PassThru
  Assert-True $second.WaitForExit(10000) 'Second instance did not exit'
  Start-Sleep -Milliseconds 500
  $results.singleInstance = $second.ExitCode -eq 0 -and (Get-TestProcesses).Count -eq $firstProcessCount

  $primary = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  $windowDeadline = (Get-Date).AddSeconds(10)
  do {
    $primary.Refresh()
    if ($primary.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $windowDeadline)
  Assert-True ($primary.MainWindowHandle -ne 0) 'Primary window did not become available for close-to-tray verification'
  Assert-True $primary.CloseMainWindow() 'Primary window did not accept a close request'
  Start-Sleep -Seconds 1
  $results.closeKeepsDockAlive = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and [bool](Get-Process -Id $primary.Id -ErrorAction SilentlyContinue)

  $bootstrap = Invoke-RestMethod "http://127.0.0.1:$port/api/bootstrap" -TimeoutSec 10
  $oauthStatus = Invoke-RestMethod "http://127.0.0.1:$port/api/oauth/status" -TimeoutSec 10
  $results.providerOAuthProvisioned = [bool]$bootstrap.config.youtube.clientId -and $bootstrap.config.youtube.clientSecretStored -and $oauthStatus.youtube.appConfigured -and [bool]$bootstrap.config.twitch.clientId -and $oauthStatus.twitch.appConfigured
  $bootstrap.config.obs.startDelaySeconds = 7
  $bootstrap.config.ui.language = 'en'
  $saveBody = @{ config = $bootstrap.config; secrets = @{ 'obs-password' = $secretMarker } } | ConvertTo-Json -Depth 30
  $saved = Invoke-RestMethod "http://127.0.0.1:$port/api/config" -Method Put -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($saveBody)) -TimeoutSec 10
  $backup = Invoke-RestMethod "http://127.0.0.1:$port/api/backup/export" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10
  $backupJson = $backup | ConvertTo-Json -Depth 30 -Compress
  $results.secretStored = $saved.obs.passwordStored
  $results.backupSecretFree = -not $backupJson.Contains($secretMarker) -and -not ($backup.PSObject.Properties.Name -contains 'secrets') -and -not $backup.config.obs.passwordStored

  Stop-TestApp
  $results.cleanExit = (Get-TestProcesses).Count -eq 0 -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

  Start-Process -FilePath $exe -ArgumentList '--background' -WorkingDirectory $runtime
  $backgroundListener = Wait-ForListener $true
  Start-Sleep -Seconds 1
  $backgroundProcess = Get-Process -Id $backgroundListener.OwningProcess -ErrorAction Stop
  $results.backgroundStartsHidden = $backgroundProcess.MainWindowHandle -eq 0
  $foregroundRequest = Start-Process -FilePath $exe -WorkingDirectory $runtime -PassThru
  Assert-True $foregroundRequest.WaitForExit(10000) 'Foreground request process did not exit'
  $windowDeadline = (Get-Date).AddSeconds(10)
  do {
    $backgroundPrimary = Get-Process -Id $backgroundProcess.Id -ErrorAction SilentlyContinue
    if ($backgroundPrimary -and $backgroundPrimary.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $windowDeadline)
  $results.secondLaunchShowsWindow = [bool]$backgroundPrimary -and $backgroundPrimary.MainWindowHandle -ne 0
  $restarted = Invoke-RestMethod "http://127.0.0.1:$port/api/bootstrap" -TimeoutSec 10
  $results.restartPersistence = $restarted.config.obs.startDelaySeconds -eq 7 -and $restarted.config.obs.passwordStored
  $results.languagePersistence = $restarted.config.ui.language -eq 'en'

  $restarted.config.youtube.clientId = ''
  $clearBody = @{ config = $restarted.config; secrets = @{ 'obs-password' = '' } } | ConvertTo-Json -Depth 30
  [void](Invoke-RestMethod "http://127.0.0.1:$port/api/config" -Method Put -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($clearBody)) -TimeoutSec 10)
  Stop-TestApp
  $results.finalCleanExit = (Get-TestProcesses).Count -eq 0 -and -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

  foreach ($entry in $results.GetEnumerator()) {
    if ($entry.Key -ne 'nodeOnPath') { Assert-True ([bool]$entry.Value) "Verification failed: $($entry.Key)" }
  }
  Assert-True (-not $results.nodeOnPath) 'Node.js unexpectedly remained on PATH'
  [pscustomobject]$results | ConvertTo-Json
} finally {
  $env:PATH = $originalPath
  $env:OBS_STREAM_MANAGER_DATA_DIR = $originalDataDirectory
  $env:OBS_STREAM_MANAGER_SECRET_SERVICE = $originalSecretService
  $env:OBS_STREAM_MANAGER_DISABLE_LOGIN_ITEM = $originalDisableLoginItem
}
