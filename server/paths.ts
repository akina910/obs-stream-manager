import os from 'node:os'
import path from 'node:path'

export function getDataDirectory(): string {
  if (process.env.OBS_STREAM_MANAGER_DATA_DIR) return path.resolve(process.env.OBS_STREAM_MANAGER_DATA_DIR)
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'obs-stream-manager')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'obs-stream-manager')
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'obs-stream-manager')
}

export const runtimeDirectories = ['config', 'profiles/pc', 'profiles/switch', 'profiles/exception', 'thumbnails', 'templates/common/rendered', 'descriptions', 'logs', 'backups', 'database'] as const

