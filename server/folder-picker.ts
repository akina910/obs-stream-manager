import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function selectFolder(initialPath = ''): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('フォルダ選択は現在Windows版で利用できます'), { statusCode: 501 })
  }

  const encodedInitialPath = Buffer.from(initialPath, 'utf8').toString('base64')
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
    `$initial = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedInitialPath}'))`,
    '$dialog = [Windows.Forms.FolderBrowserDialog]::new()',
    "$dialog.Description = '録画先フォルダを選択'",
    '$dialog.ShowNewFolderButton = $true',
    'if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) { $dialog.SelectedPath = $initial }',
    'if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    '$dialog.Dispose()',
  ].join('; ')

  let stdout: string
  try {
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    })
    stdout = result.stdout
  } catch (error) {
    const failure = error as Error & { killed?: boolean; signal?: string }
    if (failure.killed || failure.signal) throw Object.assign(new Error('フォルダ選択がタイムアウトしました。もう一度お試しください'), { statusCode: 504 })
    throw error
  }
  const selected = stdout.trim()
  return selected || null
}
