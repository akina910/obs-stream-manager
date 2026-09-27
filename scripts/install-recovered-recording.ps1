param(
  [Parameter(Mandatory = $true)]
  [string]$RecoveredFile
)

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath('J:\steam rec\video\2026-07-24 00-08-06.mp4')
$recovered = [IO.Path]::GetFullPath($RecoveredFile)
$expectedRecovered = 'E:\obs-stream-manager-transcode\2026-07-24 00-08-06.recovered-compact.mp4'
$staged = 'J:\steam rec\video\2026-07-24 00-08-06.replacement.mp4'
$ffmpeg = 'J:\ffmpeg\bin\ffmpeg.exe'
$ffprobe = 'J:\ffmpeg\bin\ffprobe.exe'

if ($recovered -ne $expectedRecovered) { throw "Unexpected recovered path: $recovered" }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Original damaged MP4 is missing.' }
if (-not (Test-Path -LiteralPath $recovered -PathType Leaf)) { throw 'Recovered MP4 is missing.' }
if (Test-Path -LiteralPath $staged) { throw 'Staged replacement already exists.' }

$raw = & $ffprobe -v error -show_entries 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels' -of json $recovered
if ($LASTEXITCODE -ne 0) { throw 'Recovered MP4 cannot be probed.' }
$probe = $raw | ConvertFrom-Json
$video = @($probe.streams | Where-Object codec_type -eq 'video')
$audio = @($probe.streams | Where-Object codec_type -eq 'audio')
$bitrate = [double]$probe.format.size * 8 / [double]$probe.format.duration
if ($video.Count -ne 1 -or $video[0].codec_name -ne 'h264' -or $video[0].width -ne 1920 -or $video[0].height -ne 1062 -or $video[0].avg_frame_rate -ne '60/1') { throw 'Recovered video layout is invalid.' }
if ($audio.Count -ne 6 -or @($audio | Where-Object { $_.codec_name -ne 'aac' -or $_.sample_rate -ne '48000' -or $_.channels -ne 2 }).Count) { throw 'Recovered audio layout is invalid.' }
if ([double]$probe.format.duration -lt 18.8 -or [double]$probe.format.duration -gt 18.9 -or $bitrate -gt 11500000) { throw 'Recovered duration or bitrate is invalid.' }
if ([long]$probe.format.size -ge (Get-Item -LiteralPath $source).Length) { throw 'Recovered MP4 is not smaller than the damaged original.' }

& $ffmpeg -hide_banner -v error -xerror -i $recovered -map 0 -f null NUL
if ($LASTEXITCODE -ne 0) { throw 'Recovered MP4 failed full decode.' }

$sourceItem = Get-Item -LiteralPath $source
Copy-Item -LiteralPath $recovered -Destination $staged
$expectedHash = (Get-FileHash -LiteralPath $recovered -Algorithm SHA256).Hash
$stagedHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash
if ($stagedHash -ne $expectedHash) { throw 'Staged replacement hash mismatch.' }

Remove-Item -LiteralPath $source -Force
Move-Item -LiteralPath $staged -Destination $source
$finalItem = Get-Item -LiteralPath $source
$finalItem.CreationTimeUtc = $sourceItem.CreationTimeUtc
$finalItem.LastWriteTimeUtc = $sourceItem.LastWriteTimeUtc
$finalHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($finalHash -ne $expectedHash) { throw 'Final replacement hash mismatch.' }

[pscustomobject]@{
  File = $source
  Bytes = $finalItem.Length
  DurationSeconds = [math]::Round([double]$probe.format.duration, 3)
  AggregateMbps = [math]::Round($bitrate / 1000000, 2)
  AudioTracks = $audio.Count
  Sha256 = $finalHash
} | ConvertTo-Json -Compress
