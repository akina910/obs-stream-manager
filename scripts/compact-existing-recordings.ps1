param(
  [string[]]$SourceFiles = @(),
  [switch]$AllRecordings,
  [switch]$AdditionalFormatsOnly,
  [Parameter(Mandatory = $true)]
  [string]$TemporaryDirectory
)

$ErrorActionPreference = 'Stop'
$recordingRoot = [IO.Path]::GetFullPath('J:\steam rec\video').TrimEnd('\')
$temporaryRoot = [IO.Path]::GetFullPath($TemporaryDirectory).TrimEnd('\')
$ffmpeg = 'J:\ffmpeg\bin\ffmpeg.exe'
$ffprobe = 'J:\ffmpeg\bin\ffprobe.exe'

if (([IO.Path]::GetPathRoot($temporaryRoot)).TrimEnd('\') -ne 'E:') {
  throw 'Temporary output must be on E:. Original recordings are never moved there.'
}
if (-not (Test-Path -LiteralPath $ffmpeg) -or -not (Test-Path -LiteralPath $ffprobe)) {
  throw 'The verified local FFmpeg tools were not found.'
}
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
if ($AllRecordings -or $AdditionalFormatsOnly) {
  if ($SourceFiles.Count) { throw 'Use either -AllRecordings or -SourceFiles, not both.' }
  $extensions = if ($AdditionalFormatsOnly) { @('.mp4', '.mov') } else { @('.mkv', '.mp4', '.mov') }
  $SourceFiles = @(Get-ChildItem -LiteralPath $recordingRoot -File | Where-Object Extension -in $extensions | Sort-Object Name | ForEach-Object FullName)
}
if (-not $SourceFiles.Count) { throw 'No source recordings were selected.' }

function Get-Probe([string]$File) {
  $raw = & $ffprobe -v error -show_entries 'format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels:stream_tags=title' -of json $File
  if ($LASTEXITCODE -ne 0) { throw "ffprobe failed for $File" }
  return $raw | ConvertFrom-Json
}

function Convert-Fps([string]$Rate) {
  $parts = $Rate.Split('/')
  if ($parts.Count -ne 2 -or [double]$parts[1] -eq 0) { return 0 }
  return [double]$parts[0] / [double]$parts[1]
}

function Assert-CompressedOutput([string]$Source, [string]$Output) {
  $sourceProbe = Get-Probe $Source
  $outputProbe = Get-Probe $Output
  $sourceVideo = @($sourceProbe.streams | Where-Object codec_type -eq 'video')
  $outputVideo = @($outputProbe.streams | Where-Object codec_type -eq 'video')
  $sourceAudio = @($sourceProbe.streams | Where-Object codec_type -eq 'audio')
  $outputAudio = @($outputProbe.streams | Where-Object codec_type -eq 'audio')
  $sourceData = @($sourceProbe.streams | Where-Object codec_type -eq 'data')
  $outputData = @($outputProbe.streams | Where-Object codec_type -eq 'data')
  $expectedTitles = @($sourceAudio | ForEach-Object { [string]$_.tags.title })
  $actualTitles = @($outputAudio | ForEach-Object { [string]$_.tags.title })
  $durationDifference = [math]::Abs([double]$sourceProbe.format.duration - [double]$outputProbe.format.duration)
  $aggregateBitrate = [double]$outputProbe.format.size * 8 / [double]$outputProbe.format.duration

  if ($sourceVideo.Count -ne 1 -or $outputVideo.Count -ne 1) { throw 'Expected exactly one video stream.' }
  if ($outputVideo[0].codec_name -ne 'h264') { throw "Output is not H.264: $($outputVideo[0].codec_name)" }
  if ($outputVideo[0].width -ne $sourceVideo[0].width -or $outputVideo[0].height -ne $sourceVideo[0].height) { throw 'Output resolution changed.' }
  $sourceFps = Convert-Fps ([string]$sourceVideo[0].avg_frame_rate)
  $outputFps = Convert-Fps ([string]$outputVideo[0].avg_frame_rate)
  if ($sourceFps -le 0 -or $outputFps -le 0 -or [math]::Abs($outputFps - $sourceFps) -gt 0.01) { throw "Output FPS changed: $($sourceVideo[0].avg_frame_rate) -> $($outputVideo[0].avg_frame_rate)" }
  if ($durationDifference -gt 2) { throw "Duration differs by $durationDifference seconds." }
  if ($outputAudio.Count -ne $sourceAudio.Count) { throw "Audio track count changed: $($sourceAudio.Count) -> $($outputAudio.Count)" }
  if ($outputData.Count -ne $sourceData.Count) { throw "Data stream count changed: $($sourceData.Count) -> $($outputData.Count)" }
  for ($index = 0; $index -lt $sourceAudio.Count; $index++) {
    if ($actualTitles[$index] -ne $expectedTitles[$index] -or
        $outputAudio[$index].codec_name -ne $sourceAudio[$index].codec_name -or
        $outputAudio[$index].sample_rate -ne $sourceAudio[$index].sample_rate -or
        $outputAudio[$index].channels -ne $sourceAudio[$index].channels) {
      throw "Audio stream $index changed."
    }
  }
  if ($aggregateBitrate -gt 11500000 -or $aggregateBitrate -le 0) { throw "Output bitrate is outside the bounded range: $aggregateBitrate bps" }
  if ([long]$outputProbe.format.size -ge [long]$sourceProbe.format.size) { throw 'Compressed output is not smaller than its source.' }

  $duration = [double]$outputProbe.format.duration
  foreach ($position in @(10, [math]::Max(10, $duration / 2), [math]::Max(10, $duration - 20))) {
    & $ffmpeg -hide_banner -v error -xerror -ss $position -i $Output -map '0:v:0' -an -t 10 -f null NUL
    if ($LASTEXITCODE -ne 0) { throw "Output video decode check failed at $position seconds." }
  }

  return [pscustomobject]@{
    DurationSeconds = [math]::Round([double]$outputProbe.format.duration, 3)
    OutputBytes = [long]$outputProbe.format.size
    AggregateMbps = [math]::Round($aggregateBitrate / 1000000, 2)
    AudioTracks = $actualTitles
  }
}

foreach ($requestedSource in $SourceFiles) {
  $source = [IO.Path]::GetFullPath($requestedSource)
  if ([IO.Path]::GetDirectoryName($source).TrimEnd('\') -ne $recordingRoot) { throw "Source is outside the intended recording directory: $source" }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Source recording does not exist: $source" }
  $sourceExtension = [IO.Path]::GetExtension($source).ToLowerInvariant()
  if ($sourceExtension -notin @('.mkv', '.mp4', '.mov')) { throw "Unsupported video container: $source" }

  try {
    $sourceProbe = Get-Probe $source
  } catch {
    if ($AllRecordings -or $AdditionalFormatsOnly) {
      Write-Output "INVALID_SKIP file=$source reason=$($_.Exception.Message)"
      continue
    }
    throw
  }
  $sourceVideo = @($sourceProbe.streams | Where-Object codec_type -eq 'video')
  if ($sourceVideo.Count -ne 1) {
    if ($AllRecordings -or $AdditionalFormatsOnly) {
      Write-Output "INVALID_SKIP file=$source reason=video-stream-count-$($sourceVideo.Count)"
      continue
    }
    throw "Source does not contain exactly one video stream: $source"
  }
  $sourceBitrate = [double]$sourceProbe.format.size * 8 / [double]$sourceProbe.format.duration
  if ($sourceVideo[0].codec_name -eq 'h264' -and $sourceBitrate -le 11500000) {
    Write-Output "ALREADY_COMPACT file=$source bitrate=$([math]::Round($sourceBitrate / 1000000, 2))Mbps"
    continue
  }

  $temporaryOutput = Join-Path $temporaryRoot (([IO.Path]::GetFileNameWithoutExtension($source)) + '.compact' + $sourceExtension)
  $verification = $null
  if (Test-Path -LiteralPath $temporaryOutput) {
    try {
      $verification = Assert-CompressedOutput $source $temporaryOutput
      Write-Output "RESUME_VERIFIED source=$source temporary=$temporaryOutput"
    } catch {
      Write-Output "STALE_TEMP_REMOVE file=$temporaryOutput reason=$($_.Exception.Message)"
      Remove-Item -LiteralPath $temporaryOutput -Force
    }
  }
  if (-not $verification) {
    Write-Output "TRANSCODE_START source=$source temporary=$temporaryOutput"
    $audioStreams = @($sourceProbe.streams | Where-Object codec_type -eq 'audio')
    $ffmpegArguments = @('-hide_banner', '-y', '-xerror', '-i', $source, '-map', '0', '-map_metadata', '0', '-map_chapters', '0', '-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '20M', '-g', '120', '-bf', '2', '-spatial_aq', '0', '-temporal_aq', '0', '-rc-lookahead', '0', '-c:a', 'copy', '-c:s', 'copy', '-c:d', 'copy', '-c:t', 'copy')
    for ($audioIndex = 0; $audioIndex -lt $audioStreams.Count; $audioIndex++) {
      $title = [string]$audioStreams[$audioIndex].tags.title
      if ($title) { $ffmpegArguments += @("-metadata:s:a:$audioIndex", "title=$title") }
    }
    $ffmpegArguments += @('-stats_period', '30', '-progress', 'pipe:1', '-nostats', $temporaryOutput)
    & $ffmpeg @ffmpegArguments
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed. The original remains untouched: $source" }

    $verification = Assert-CompressedOutput $source $temporaryOutput
  }
  Write-Output ("VERIFY_PASS " + ($verification | ConvertTo-Json -Compress))

  # At this point the independently stored E: output has passed structural and
  # sampled decode checks. Delete only the explicit J: source, then move the
  # verified compressed file back under the identical recording filename.
  $resolvedParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($source)).TrimEnd('\')
  if ($resolvedParent -ne $recordingRoot) { throw 'Source path changed before deletion.' }
  $sourceInfo = Get-Item -LiteralPath $source
  $originalCreationTime = $sourceInfo.CreationTime
  $originalLastWriteTime = $sourceInfo.LastWriteTime
  Remove-Item -LiteralPath $source -Force
  Move-Item -LiteralPath $temporaryOutput -Destination $source
  $finalInfo = Get-Item -LiteralPath $source
  $finalInfo.CreationTime = $originalCreationTime
  $finalInfo.LastWriteTime = $originalLastWriteTime

  $finalProbe = Get-Probe $source
  if ([long]$finalProbe.format.size -ne $verification.OutputBytes) { throw "Final J: file does not match the verified output size: $source" }
  Write-Output "REPLACED_OK file=$source bytes=$($verification.OutputBytes)"
}

Write-Output 'ALL_DONE'
