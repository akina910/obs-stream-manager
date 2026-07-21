import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig, LocalObsSetupStatus } from '../shared/contracts.js'
import type { SecretStore } from './secrets.js'
import type { DataStore } from './storage.js'

type ConfigStore = Pick<DataStore, 'getConfig' | 'saveConfig'>
type PasswordStore = Pick<SecretStore, 'set'>

export type LocalObsProvisioningOptions = {
  obsConfigDirectory?: string | null
  isObsRunning?: () => Promise<boolean>
  pollIntervalMs?: number
  dockUrl?: string
}

type WebSocketConfig = Record<string, unknown> & {
  auth_required?: boolean
  first_load?: boolean
  server_enabled?: boolean
  server_password?: string
  server_port?: number
}

const dockTitle = 'Stream Manager'
const defaultDockUrl = 'http://127.0.0.1:4317'
const defaultPort = 4455

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true } catch { return false }
}

async function atomicWrite(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, filename)
}

function defaultObsConfigDirectory(): string | null {
  const override = process.env.OBS_STREAM_MANAGER_OBS_CONFIG_DIR?.trim()
  if (override) return path.resolve(override)
  const appData = process.env.APPDATA?.trim()
  return process.platform === 'win32' && appData ? path.join(appData, 'obs-studio') : null
}

export async function isObsProcessRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise((resolve) => {
    const executable = path.join(process.env.SystemRoot?.trim() || 'C:\\Windows', 'System32', 'tasklist.exe')
    execFile(executable, ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'], { timeout: 3_000, windowsHide: true }, (error, stdout) => {
      resolve(!error && /"obs64\.exe"/i.test(stdout))
    })
  })
}

function browserDockId(dockUrl: string): string {
  return crypto.createHash('sha256').update(dockUrl).digest('hex').slice(0, 32)
}

export function upsertBrowserDock(globalIni: string, dockUrl = defaultDockUrl): string {
  const newline = globalIni.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = globalIni.endsWith('\n')
  const lines = globalIni.split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()
  let basicWindowStart = -1
  let basicWindowEnd = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(lines[index])
    if (!section) continue
    if (section[1] === 'BasicWindow') {
      basicWindowStart = index
      basicWindowEnd = lines.length
    } else if (basicWindowStart >= 0) {
      basicWindowEnd = index
      break
    }
  }

  if (basicWindowStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('')
    lines.push('[BasicWindow]')
    basicWindowStart = lines.length - 1
    basicWindowEnd = lines.length
  }

  let settingIndex = -1
  let docks: Array<Record<string, unknown>> = []
  for (let index = basicWindowStart + 1; index < basicWindowEnd; index += 1) {
    const match = /^\s*ExtraBrowserDocks\s*=\s*(.*)$/.exec(lines[index])
    if (!match) continue
    settingIndex = index
    if (match[1].trim()) {
      const parsed: unknown = JSON.parse(match[1])
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('OBSのドック設定を安全に読み取れませんでした')
      }
      docks = parsed as Array<Record<string, unknown>>
    }
    break
  }

  const nextDock = { title: dockTitle, url: dockUrl, uuid: browserDockId(dockUrl) }
  const matchingIndex = docks.findIndex((item) => item.title === dockTitle || item.url === dockUrl)
  const nextDocks = docks.filter((item, index) => index === matchingIndex || (item.title !== dockTitle && item.url !== dockUrl))
  if (matchingIndex >= 0) nextDocks[nextDocks.findIndex((item) => item === docks[matchingIndex])] = nextDock
  else nextDocks.push(nextDock)
  const setting = `ExtraBrowserDocks=${JSON.stringify(nextDocks)}`
  if (settingIndex >= 0) lines[settingIndex] = setting
  else lines.splice(basicWindowEnd, 0, setting)
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`
}

function browserDockConfigured(globalIni: string, dockUrl: string): boolean {
  const match = /^\s*ExtraBrowserDocks\s*=\s*(.*)$/m.exec(globalIni)
  if (!match?.[1]) return false
  try {
    const docks: unknown = JSON.parse(match[1].trim())
    return Array.isArray(docks) && docks.some((item) => item && typeof item === 'object' && (item as { url?: unknown }).url === dockUrl)
  } catch {
    return false
  }
}

function createPassword(): string {
  return crypto.randomBytes(18).toString('base64url')
}

function websocketReady(config: WebSocketConfig): boolean {
  return config.server_enabled === true
    && (config.auth_required === false || Boolean(config.server_password?.trim()))
}

export class LocalObsProvisioner {
  private readonly obsConfigDirectory: string | null
  private readonly isObsRunning: () => Promise<boolean>
  private readonly pollIntervalMs: number
  private readonly dockUrl: string
  private timer: NodeJS.Timeout | null = null
  private preparation: Promise<LocalObsSetupStatus> | null = null
  private current: LocalObsSetupStatus = {
    phase: 'waiting_for_obs',
    detail: 'OBSを一度起動すると自動で準備します',
    dockConfigured: false,
    websocketConfigured: false,
  }

  constructor(
    private readonly store: ConfigStore,
    private readonly secrets: PasswordStore,
    options: LocalObsProvisioningOptions = {},
  ) {
    this.obsConfigDirectory = options.obsConfigDirectory === undefined ? defaultObsConfigDirectory() : options.obsConfigDirectory
    this.isObsRunning = options.isObsRunning ?? isObsProcessRunning
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000
    this.dockUrl = options.dockUrl ?? defaultDockUrl
  }

  status(): LocalObsSetupStatus {
    return { ...this.current }
  }

  async start(): Promise<LocalObsSetupStatus> {
    const status = await this.prepare()
    if (status.phase !== 'ready' && !this.timer) {
      this.timer = setInterval(() => { void this.prepare().catch(() => undefined) }, this.pollIntervalMs)
      this.timer.unref()
    }
    return status
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  prepare(): Promise<LocalObsSetupStatus> {
    if (this.preparation) return this.preparation
    const operation = this.prepareOnce()
    this.preparation = operation
    void operation.then(
      () => { if (this.preparation === operation) this.preparation = null },
      () => { if (this.preparation === operation) this.preparation = null },
    )
    return operation
  }

  private async prepareOnce(): Promise<LocalObsSetupStatus> {
    if (!this.obsConfigDirectory || !(await exists(this.obsConfigDirectory))) {
      return this.setStatus('waiting_for_obs', 'OBSを一度起動すると自動で準備します', false, false)
    }
    const userIniPath = path.join(this.obsConfigDirectory, 'user.ini')
    const globalIniPath = path.join(this.obsConfigDirectory, 'global.ini')
    const dockConfigPath = await exists(userIniPath)
      ? userIniPath
      : await exists(globalIniPath) ? globalIniPath : null
    if (!dockConfigPath) {
      return this.setStatus('waiting_for_obs', 'OBSを一度起動すると自動で準備します', false, false)
    }

    try {
      const websocketPath = path.join(this.obsConfigDirectory, 'plugin_config', 'obs-websocket', 'config.json')
      const running = await this.isObsRunning()
      const dockConfig = await readFile(dockConfigPath, 'utf8')
      let websocket: WebSocketConfig = {}
      if (await exists(websocketPath)) websocket = JSON.parse(await readFile(websocketPath, 'utf8')) as WebSocketConfig
      let dockReady = browserDockConfigured(dockConfig, this.dockUrl)
      let socketReady = websocketReady(websocket)

      if (!running) {
        const authRequired = websocket.auth_required !== false
        websocket = {
          ...websocket,
          auth_required: authRequired,
          first_load: false,
          server_enabled: true,
          server_password: authRequired ? websocket.server_password?.trim() || createPassword() : websocket.server_password,
          server_port: Number.isInteger(websocket.server_port) && Number(websocket.server_port) > 0 ? websocket.server_port : defaultPort,
        }
        await atomicWrite(websocketPath, `${JSON.stringify(websocket, null, 2)}\n`)
        const nextDockConfig = upsertBrowserDock(dockConfig, this.dockUrl)
        if (nextDockConfig !== dockConfig) await atomicWrite(dockConfigPath, nextDockConfig)
        dockReady = browserDockConfigured(nextDockConfig, this.dockUrl)
        socketReady = true
      }

      if (socketReady) await this.syncApplicationConnection(websocket)
      if (dockReady && socketReady) {
        this.stop()
        return this.setStatus('ready', running ? 'OBSと接続する準備ができています' : 'OBSを起動すると自動で接続します', true, true)
      }
      return this.setStatus('restart_required', 'OBSを一度終了すると自動設定します。次の起動から使えます', dockReady, socketReady)
    } catch (error) {
      return this.setStatus('error', error instanceof Error ? error.message : String(error), false, false)
    }
  }

  private async syncApplicationConnection(websocket: WebSocketConfig): Promise<void> {
    const authRequired = websocket.auth_required !== false
    const password = authRequired ? websocket.server_password?.trim() || '' : ''
    this.secrets.set('obs-password', password)
    const current = await this.store.getConfig()
    const port = Number.isInteger(websocket.server_port) && Number(websocket.server_port) > 0 ? Number(websocket.server_port) : defaultPort
    const nextObs: AppConfig['obs'] = {
      ...current.obs,
      url: `ws://127.0.0.1:${port}`,
      passwordStored: Boolean(password),
    }
    if (JSON.stringify(nextObs) !== JSON.stringify(current.obs)) await this.store.saveConfig({ ...current, obs: nextObs })
  }

  private setStatus(
    phase: LocalObsSetupStatus['phase'],
    detail: string,
    dockConfigured: boolean,
    websocketConfigured: boolean,
  ): LocalObsSetupStatus {
    this.current = { phase, detail, dockConfigured, websocketConfigured }
    return this.status()
  }
}
