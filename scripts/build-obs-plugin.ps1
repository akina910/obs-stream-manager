param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\build\obs-plugin')
)

$ErrorActionPreference = 'Stop'
$templateCommit = '3e7d7ac3b5342cd7d9b88890b9c70b472d1520fc'
$websocketCommit = '1ef34bf48110c2a18184e50e41cd0b1a855e2147'
$websocketHeaderSha256 = 'c29e8e38ee66c36db79cae86217ab0f270aad39f97e82090809d087c281b7948'
$websocketLicenseSha256 = '90b664a6fbc82b38595cbb39606268bef0b2eb9b76b0e9e03826befe204190bb'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$workspace = [IO.Path]::GetFullPath((Join-Path $tempRoot "obs-stream-manager-plugin-$([guid]::NewGuid().ToString('N'))"))
$source = Join-Path $PSScriptRoot '..\native\obs-stream-manager-output'

try {
  git clone --quiet https://github.com/obsproject/obs-plugintemplate.git $workspace
  git -C $workspace checkout --quiet $templateCommit
  Copy-Item (Join-Path $source 'CMakeLists.txt') (Join-Path $workspace 'CMakeLists.txt') -Force
  Copy-Item (Join-Path $source 'buildspec.json') (Join-Path $workspace 'buildspec.json') -Force
  Copy-Item (Join-Path $source 'src\plugin-main.c') (Join-Path $workspace 'src\plugin-main.c') -Force

  $header = Join-Path $workspace 'src\obs-websocket-api.h'
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/obsproject/obs-websocket/$websocketCommit/lib/obs-websocket-api.h" -OutFile $header
  if ((Get-FileHash $header -Algorithm SHA256).Hash.ToLowerInvariant() -ne $websocketHeaderSha256) {
    throw 'obs-websocket API header checksum mismatch'
  }

  & (Join-Path $workspace '.github\scripts\Build-Windows.ps1') -Target x64 -Configuration Release
  if ($LASTEXITCODE -ne 0) { throw "OBS plugin build failed with exit code $LASTEXITCODE" }

  $dll = Get-ChildItem $workspace -Recurse -Filter 'obs-stream-manager-output.dll' -File | Select-Object -First 1
  if (-not $dll) { throw 'Built OBS plugin DLL was not found' }
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  Copy-Item $dll.FullName (Join-Path $OutputDirectory $dll.Name) -Force
  $license = Join-Path $OutputDirectory 'GPL-2.0.txt'
  Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/obsproject/obs-websocket/$websocketCommit/LICENSE" -OutFile $license
  if ((Get-FileHash $license -Algorithm SHA256).Hash.ToLowerInvariant() -ne $websocketLicenseSha256) {
    throw 'obs-websocket license checksum mismatch'
  }
  Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'version.json') '{"version":"0.2.0","obsMinimumVersion":"31.1.1"}'
} finally {
  $workspaceParent = [IO.Path]::GetFullPath((Split-Path -Parent $workspace))
  $workspaceName = Split-Path -Leaf $workspace
  if ($workspaceParent -eq $tempRoot.TrimEnd('\') -and $workspaceName.StartsWith('obs-stream-manager-plugin-') -and (Test-Path -LiteralPath $workspace)) {
    Remove-Item -LiteralPath $workspace -Recurse -Force
  }
}
