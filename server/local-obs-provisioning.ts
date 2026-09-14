import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
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

type ObsWebSocketIniConfig = {
  alerts_enabled?: boolean
  auth_required?: boolean
  first_load?: boolean
  server_enabled?: boolean
  server_password?: string
  server_port?: number
}

const dockTitle = 'Stream Manager'
const defaultDockUrl = 'http://127.0.0.1:4317'
const defaultPort = 4455
const managedVideoBitrateKbps = 10_000
const managedAudioBitrateKbps = 160

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
}

const managedProfileSettings: Record<string, Record<string, string>> = {
  General: {
    AutoRemux: 'false',
  },
  Output: {
    Mode: 'Advanced',
  },
  Stream1: {
    EnableMultitrackVideo: 'false',
  },
  SimpleOutput: {
    VBitrate: String(managedVideoBitrateKbps),
    ABitrate: String(managedAudioBitrateKbps),
    RecFormat2: 'mkv',
    RecRB: 'true',
    RecRBTime: '180',
    RecRBSize: '512',
  },
  AdvOut: {
    ApplyServiceSettings: 'false',
    UseRescale: 'false',
    TrackIndex: '6',
    RecType: 'Standard',
    RecFormat2: 'mkv',
    RecUseRescale: 'false',
    RecTracks: '63',
    RecEncoder: 'none',
    RecRB: 'true',
    RecRBTime: '180',
    RecRBSize: '512',
    Track1Name: 'GAME',
    Track2Name: 'DISCORD',
    Track3Name: 'MIC',
    Track4Name: 'BGM',
    Track5Name: 'AUX CAPTURE',
    Track6Name: 'STREAM MIX',
    Track1Bitrate: String(managedAudioBitrateKbps),
    Track2Bitrate: String(managedAudioBitrateKbps),
    Track3Bitrate: String(managedAudioBitrateKbps),
    Track4Bitrate: String(managedAudioBitrateKbps),
    Track5Bitrate: String(managedAudioBitrateKbps),
    Track6Bitrate: String(managedAudioBitrateKbps),
  },
  Video: {
    BaseCX: '1920',
    BaseCY: '1080',
    OutputCX: '1920',
    OutputCY: '1080',
    FPSType: '0',
    FPSCommon: '60',
  },
}

const managedEncoderSettings = {
  rate_control: 'CBR',
  bitrate: managedVideoBitrateKbps,
  keyint_sec: 2,
  bf: 2,
  lookahead: false,
} as const

async function exists(filename: string): Promise<boolean> {
  try { await stat(filename); return true } catch { return false }
}

async function atomicWrite(filename: string, contents: string, beforeRename?: () => Promise<void>): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await beforeRename?.()
    await rename(temporary, filename)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

class ObsStartedDuringProvisioningError extends Error {}

async function guardedAtomicWrite(assertObsStopped: () => Promise<void>, filename: string, contents: string): Promise<void> {
  await assertObsStopped()
  await atomicWrite(filename, contents, assertObsStopped)
}

function iniSetting(contents: string, sectionName: string, settingName: string): string | null {
  let inSection = false
  let found: string | null = null
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(line)
    if (section) {
      inSection = section[1].toLowerCase() === sectionName.toLowerCase()
      continue
    }
    if (!inSection) continue
    const setting = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line)
    if (setting?.[1].trim().toLowerCase() === settingName.toLowerCase()) found = setting[2].trim()
  }
  return found
}

function upsertIniSetting(contents: string, sectionName: string, settingName: string, value: string): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = contents.endsWith('\n')
  const lines = contents.split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()
  let sectionStart = -1
  let sectionEnd = lines.length
  const sectionIndexes: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(lines[index])
    if (!section) continue
    sectionIndexes.push(index)
    if (section[1].toLowerCase() === sectionName.toLowerCase()) sectionStart = index
  }
  if (sectionStart >= 0) {
    sectionEnd = sectionIndexes.find((index) => index > sectionStart) ?? lines.length
  }
  if (sectionStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('')
    lines.push(`[${sectionName}]`, `${settingName}=${value}`)
  } else {
    let settingIndex = -1
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
      const setting = /^\s*([^=]+?)\s*=/.exec(lines[index])
      if (setting?.[1].trim().toLowerCase() === settingName.toLowerCase()) {
        settingIndex = index
        break
      }
    }
    if (settingIndex >= 0) lines[settingIndex] = `${settingName}=${value}`
    else lines.splice(sectionEnd, 0, `${settingName}=${value}`)
  }
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`
}

function applyManagedProfileSettings(basicIni: string): string {
  let next = basicIni
  for (const [section, settings] of Object.entries(managedProfileSettings)) {
    for (const [name, value] of Object.entries(settings)) next = upsertIniSetting(next, section, name, value)
  }
  return next
}

function profileIniReady(basicIni: string): boolean {
  return Object.entries(managedProfileSettings).every(([section, settings]) =>
    Object.entries(settings).every(([name, value]) => iniSetting(basicIni, section, name) === value))
}

function encoderSettingsReady(settings: Record<string, unknown>): boolean {
  return Object.entries(managedEncoderSettings).every(([name, value]) => settings[name] === value)
}

function activeProfileDirectory(obsConfigDirectory: string, configs: string[]): string | null {
  const profilesRoot = path.resolve(obsConfigDirectory, 'basic', 'profiles')
  for (const config of configs) {
    const directoryName = iniSetting(config, 'Basic', 'ProfileDir')
    if (!directoryName) continue
    const candidate = path.resolve(profilesRoot, directoryName)
    const relative = path.relative(profilesRoot, candidate)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) continue
    return candidate
  }
  return null
}

async function readEncoderSettings(filename: string): Promise<Record<string, unknown>> {
  if (!(await exists(filename))) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    throw new Error(`OBSの配信エンコーダー設定を安全に読み取れませんでした: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OBSの配信エンコーダー設定を安全に読み取れませんでした')
  }
  return parsed as Record<string, unknown>
}

async function activeProfileReady(obsConfigDirectory: string, configs: string[]): Promise<boolean> {
  const directory = activeProfileDirectory(obsConfigDirectory, configs)
  if (!directory) return false
  const basicIniPath = path.join(directory, 'basic.ini')
  if (!(await exists(basicIniPath))) return false
  const [basicIni, encoder] = await Promise.all([
    readFile(basicIniPath, 'utf8'),
    readEncoderSettings(path.join(directory, 'streamEncoder.json')),
  ])
  return profileIniReady(basicIni) && encoderSettingsReady(encoder)
}

async function provisionActiveProfile(
  obsConfigDirectory: string,
  configs: string[],
  assertObsStopped: () => Promise<void>,
): Promise<boolean> {
  const directory = activeProfileDirectory(obsConfigDirectory, configs)
  if (!directory) return false
  const basicIniPath = path.join(directory, 'basic.ini')
  if (!(await exists(basicIniPath))) return false
  const encoderPath = path.join(directory, 'streamEncoder.json')
  const [basicIni, encoder] = await Promise.all([
    readFile(basicIniPath, 'utf8'),
    readEncoderSettings(encoderPath),
  ])
  const nextBasicIni = applyManagedProfileSettings(basicIni)
  const nextEncoder = { ...encoder, ...managedEncoderSettings }
  if (nextBasicIni !== basicIni) await guardedAtomicWrite(assertObsStopped, basicIniPath, nextBasicIni)
  if (!encoderSettingsReady(encoder)) await guardedAtomicWrite(assertObsStopped, encoderPath, `${JSON.stringify(nextEncoder, null, 2)}\n`)
  return profileIniReady(nextBasicIni) && encoderSettingsReady(nextEncoder)
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
      // File writes must fail closed: an unavailable/overloaded tasklist cannot
      // be treated as proof that OBS is stopped.
      resolve(Boolean(error) || /"obs64\.exe"/i.test(stdout))
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
      let parsed: unknown
      try {
        parsed = JSON.parse(match[1])
      } catch {
        throw new Error('OBSのドック設定を安全に読み取れませんでした')
      }
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

function upsertBrowserDockRecovering(contents: string, dockUrl: string): { contents: string; recovered: boolean } {
  try {
    return { contents: upsertBrowserDock(contents, dockUrl), recovered: false }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('OBSのドック設定を安全に読み取れませんでした')) throw error
    const reset = upsertIniSetting(contents, 'BasicWindow', 'ExtraBrowserDocks', '[]')
    return { contents: upsertBrowserDock(reset, dockUrl), recovered: true }
  }
}

function browserDockConfigured(globalIni: string, dockUrl: string): boolean {
  const value = iniSetting(globalIni, 'BasicWindow', 'ExtraBrowserDocks')
  if (!value) return false
  try {
    const docks: unknown = JSON.parse(value)
    return Array.isArray(docks) && docks.some((item) => item && typeof item === 'object' && (item as { url?: unknown }).url === dockUrl)
  } catch {
    return false
  }
}

function obsWebSocketIniConfig(userIni: string): ObsWebSocketIniConfig | null {
  const lines = userIni.split(/\r?\n/)
  let inSection = false
  let foundSection = false
  const values = new Map<string, string>()
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(line)
    if (section) {
      inSection = section[1].toLowerCase() === 'obswebsocket'
      if (inSection) foundSection = true
      continue
    }
    if (!inSection) continue
    const setting = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(line)
    if (setting) values.set(setting[1].trim().toLowerCase(), setting[2].trim())
  }
  if (!foundSection) return null
  const boolean = (name: string): boolean | undefined => {
    const value = values.get(name.toLowerCase())
    if (value === undefined) return undefined
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
    return undefined
  }
  const port = Number(values.get('serverport'))
  return {
    alerts_enabled: boolean('alertsenabled'),
    auth_required: boolean('authrequired'),
    first_load: boolean('firstload'),
    server_enabled: boolean('serverenabled'),
    server_password: values.get('serverpassword'),
    server_port: validPort(port) ? port : undefined,
  }
}

function upsertObsWebSocketIni(userIni: string, websocket: WebSocketConfig): string {
  const newline = userIni.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = userIni.endsWith('\n')
  const lines = userIni.split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let index = 0; index < lines.length; index += 1) {
    const section = /^\s*\[([^\]]+)]\s*$/.exec(lines[index])
    if (!section) continue
    if (section[1].toLowerCase() === 'obswebsocket') {
      sectionStart = index
      sectionEnd = lines.length
    } else if (sectionStart >= 0) {
      sectionEnd = index
      break
    }
  }
  if (sectionStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('')
    lines.push('[OBSWebSocket]')
    sectionStart = lines.length - 1
    sectionEnd = lines.length
  }
  const settings = new Map<string, string>([
    ['FirstLoad', 'false'],
    ['ServerEnabled', 'true'],
    ['ServerPort', String(websocket.server_port ?? defaultPort)],
    ['AlertsEnabled', String(websocket.alerts_enabled === true)],
    ['AuthRequired', String(websocket.auth_required !== false)],
  ])
  if (websocket.auth_required !== false && websocket.server_password?.trim()) {
    settings.set('ServerPassword', websocket.server_password.trim())
  }
  for (const [name, value] of settings) {
    let settingIndex = -1
    for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
      const setting = /^\s*([^=]+?)\s*=/.exec(lines[index])
      if (setting?.[1].trim().toLowerCase() === name.toLowerCase()) {
        settingIndex = index
        break
      }
    }
    if (settingIndex >= 0) lines[settingIndex] = `${name}=${value}`
    else {
      lines.splice(sectionEnd, 0, `${name}=${value}`)
      sectionEnd += 1
    }
  }
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`
}

function createPassword(): string {
  return crypto.randomBytes(18).toString('base64url')
}

function websocketReady(config: WebSocketConfig): boolean {
  return config.server_enabled === true
    && validPort(config.server_port)
    && (config.auth_required === false || Boolean(config.server_password?.trim()))
}

export class LocalObsProvisioner {
  private readonly obsConfigDirectory: string | null
  private readonly isObsRunning: () => Promise<boolean>
  private readonly pollIntervalMs: number
  private readonly dockUrl: string
  private timer: NodeJS.Timeout | null = null
  private preparation: Promise<LocalObsSetupStatus> | null = null
  private lastSyncedPassword: string | undefined
  private current: LocalObsSetupStatus = {
    phase: 'waiting_for_obs',
    detail: 'OBSを一度起動すると自動で準備します',
    dockConfigured: false,
    websocketConfigured: false,
    outputConfigured: false,
  }

  constructor(
    private readonly store: ConfigStore,
    private readonly secrets: PasswordStore,
    options: LocalObsProvisioningOptions = {},
  ) {
    const isolatedEnvironmentDirectory = options.obsConfigDirectory === undefined
      && Boolean(process.env.OBS_STREAM_MANAGER_OBS_CONFIG_DIR?.trim())
    this.obsConfigDirectory = options.obsConfigDirectory === undefined ? defaultObsConfigDirectory() : options.obsConfigDirectory
    // An explicit environment override points to a test/development fixture,
    // not the configuration directory loaded by the real OBS process. Treat
    // only that isolated directory as stopped so package verification can run
    // safely while the user's OBS instance remains open.
    this.isObsRunning = options.isObsRunning ?? (isolatedEnvironmentDirectory ? async () => false : isObsProcessRunning)
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
      return this.setStatus('waiting_for_obs', 'OBSを一度起動すると自動で準備します', false, false, false)
    }
    const userIniPath = path.join(this.obsConfigDirectory, 'user.ini')
    const globalIniPath = path.join(this.obsConfigDirectory, 'global.ini')
    const dockConfigPath = await exists(userIniPath)
      ? userIniPath
      : await exists(globalIniPath) ? globalIniPath : null
    if (!dockConfigPath) {
      return this.setStatus('waiting_for_obs', 'OBSを一度起動すると自動で準備します', false, false, false)
    }

    try {
      const websocketPath = path.join(this.obsConfigDirectory, 'plugin_config', 'obs-websocket', 'config.json')
      const running = await this.isObsRunning()
      const dockConfig = await readFile(dockConfigPath, 'utf8')
      const globalIni = dockConfigPath === globalIniPath || !(await exists(globalIniPath))
        ? dockConfig
        : await readFile(globalIniPath, 'utf8')
      const profileConfigs = dockConfig === globalIni ? [dockConfig] : [dockConfig, globalIni]
      let websocket: WebSocketConfig = {}
      let websocketContents: string | null = null
      if (await exists(websocketPath)) {
        websocketContents = await readFile(websocketPath, 'utf8')
        const parsed: unknown = JSON.parse(websocketContents)
        websocket = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as WebSocketConfig : {}
      }
      const usesUserIni = path.basename(dockConfigPath).toLowerCase() === 'user.ini'
      const iniWebsocket = usesUserIni ? obsWebSocketIniConfig(dockConfig) : null
      if (iniWebsocket) {
        const definedIniWebsocket: Record<string, boolean | number | string> = Object.fromEntries(
          Object.entries(iniWebsocket).filter((entry): entry is [string, boolean | number | string] => entry[1] !== undefined),
        )
        if (running) {
          // user.ini is authoritative while OBS is live. Missing settings are
          // OBS defaults, not permission to inherit a stale OBS 30 JSON file.
          definedIniWebsocket.server_enabled ??= false
          definedIniWebsocket.auth_required ??= true
          definedIniWebsocket.server_port ??= defaultPort
        }
        websocket = { ...websocket, ...definedIniWebsocket }
        if (running && definedIniWebsocket.auth_required !== false && !iniWebsocket.server_password?.trim()) {
          // OBS 31 no longer reads the legacy JSON password. Never import an
          // obsolete password when the live, authoritative INI has none.
          delete websocket.server_password
        }
      }
      let dockReady = browserDockConfigured(dockConfig, this.dockUrl)
      // OBS 31 writes the authoritative settings to user.ini. If it has not
      // appeared yet during the first live run, the older JSON may be stale.
      let socketReady = running
        ? usesUserIni && iniWebsocket !== null && websocketReady(websocket)
        : websocketReady(websocket)
      let outputReady = await activeProfileReady(this.obsConfigDirectory, profileConfigs)
      let dockRecovered = false

      if (!running) {
        const assertObsStopped = async () => {
          if (await this.isObsRunning()) throw new ObsStartedDuringProvisioningError('OBS started during provisioning')
        }
        await assertObsStopped()
        const authRequired = websocket.auth_required !== false
        websocket = {
          ...websocket,
          alerts_enabled: websocket.alerts_enabled === true,
          auth_required: authRequired,
          first_load: false,
          server_enabled: true,
          server_password: authRequired ? websocket.server_password?.trim() || createPassword() : websocket.server_password,
          server_port: validPort(websocket.server_port) ? websocket.server_port : defaultPort,
        }
        // OBS 31 moved both browser docks and the built-in WebSocket settings
        // to user.ini. A first-run profile may still have only global.ini, so
        // create a compatible user.ini as well as retaining the legacy files.
        // Write the authoritative OBS 31 file before the legacy JSON copy so a
        // partial failure cannot leave user.ini pointing at an older password.
        // OBS 31 uses user.ini as the authoritative per-user file. When it has
        // not been created yet, preserve the complete legacy global.ini as the
        // migration base instead of creating a stub that loses profile/scene
        // selection and other unrelated settings.
        const currentUserIni = dockConfig
        const nextDock = upsertBrowserDockRecovering(currentUserIni, this.dockUrl)
        dockRecovered = nextDock.recovered
        if (dockRecovered) {
          const backupPath = `${dockConfigPath}.obs-stream-manager-backup`
          if (!(await exists(backupPath))) await guardedAtomicWrite(assertObsStopped, backupPath, currentUserIni)
        }
        const nextUserIni = upsertObsWebSocketIni(nextDock.contents, websocket)
        if (!usesUserIni || nextUserIni !== dockConfig) await guardedAtomicWrite(assertObsStopped, userIniPath, nextUserIni)
        const nextWebsocketContents = `${JSON.stringify(websocket, null, 2)}\n`
        if (nextWebsocketContents !== websocketContents) {
          await guardedAtomicWrite(assertObsStopped, websocketPath, nextWebsocketContents)
        }
        if (!usesUserIni) {
          const nextGlobalIni = upsertBrowserDockRecovering(dockConfig, this.dockUrl).contents
          if (nextGlobalIni !== dockConfig) await guardedAtomicWrite(assertObsStopped, dockConfigPath, nextGlobalIni)
        }
        dockReady = browserDockConfigured(nextUserIni, this.dockUrl)
        socketReady = websocketReady(websocket)
        outputReady = await provisionActiveProfile(this.obsConfigDirectory, profileConfigs, assertObsStopped)
      }

      if (socketReady) await this.syncApplicationConnection(websocket)
      if (dockReady && socketReady && outputReady) {
        this.stop()
        return this.setStatus(
          'ready',
          dockRecovered
            ? '壊れたOBSドック設定をバックアップして修復しました。OBSを起動すると自動で接続します'
            : running ? 'OBSと接続する準備ができています' : 'OBSを起動すると自動で接続します',
          true,
          true,
          true,
        )
      }
      const detail = !outputReady && !activeProfileDirectory(this.obsConfigDirectory, profileConfigs)
        ? 'OBSでプロファイルを一度作成すると、配信設定まで自動で準備します'
        : 'OBSを一度終了すると自動設定します。次の起動から使えます'
      return this.setStatus(running ? 'restart_required' : 'waiting_for_obs', detail, dockReady, socketReady, outputReady)
    } catch (error) {
      if (error instanceof ObsStartedDuringProvisioningError) {
        return this.setStatus('restart_required', 'OBSが起動したため設定ファイルの更新を中止しました。OBSを終了すると安全に再開します', false, false, false)
      }
      return this.setStatus('error', error instanceof Error ? error.message : String(error), false, false, false)
    }
  }

  private async syncApplicationConnection(websocket: WebSocketConfig): Promise<void> {
    const authRequired = websocket.auth_required !== false
    const password = authRequired ? websocket.server_password?.trim() || '' : ''
    if (this.lastSyncedPassword !== password) {
      this.secrets.set('obs-password', password)
      this.lastSyncedPassword = password
    }
    const current = await this.store.getConfig()
    const port = validPort(websocket.server_port) ? websocket.server_port : defaultPort
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
    outputConfigured: boolean,
  ): LocalObsSetupStatus {
    this.current = { phase, detail, dockConfigured, websocketConfigured, outputConfigured }
    return this.status()
  }
}
