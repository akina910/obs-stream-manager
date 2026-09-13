import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalObsProvisioner, upsertBrowserDock } from './local-obs-provisioning.js'
import type { SecretName, SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []

async function harness(running: boolean | (() => Promise<boolean>) = false) {
  const initiallyRunning = typeof running === 'boolean' ? running : false
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-local-obs-'))
  directories.push(directory)
  const dataDirectory = path.join(directory, 'data')
  const obsDirectory = path.join(directory, 'obs-studio')
  await mkdir(path.join(obsDirectory, 'plugin_config', 'obs-websocket'), { recursive: true })
  const profileDirectory = path.join(obsDirectory, 'basic', 'profiles', 'Default')
  await mkdir(profileDirectory, { recursive: true })
  await writeFile(path.join(obsDirectory, 'global.ini'), '[General]\r\nName=OBS\r\n\r\n[Basic]\r\nProfile=Default\r\nProfileDir=Default\r\n\r\n[BasicWindow]\r\nExtraBrowserDocks=[]\r\n')
  await writeFile(path.join(profileDirectory, 'basic.ini'), initiallyRunning
    ? '[General]\nAutoRemux=false\n\n[Output]\nMode=Advanced\n\n[Stream1]\nEnableMultitrackVideo=false\n\n[SimpleOutput]\nVBitrate=10000\nABitrate=160\nRecFormat2=mkv\nRecRB=true\nRecRBTime=180\nRecRBSize=512\n\n[AdvOut]\nApplyServiceSettings=false\nUseRescale=false\nTrackIndex=6\nRecType=Standard\nRecFormat2=mkv\nRecUseRescale=false\nRecTracks=63\nRecEncoder=none\nRecRB=true\nRecRBTime=180\nRecRBSize=512\nTrack1Name=GAME\nTrack2Name=DISCORD\nTrack3Name=MIC\nTrack4Name=BGM\nTrack5Name=AUX CAPTURE\nTrack6Name=STREAM MIX\nTrack1Bitrate=160\nTrack2Bitrate=160\nTrack3Bitrate=160\nTrack4Bitrate=160\nTrack5Bitrate=160\nTrack6Bitrate=160\n\n[Video]\nBaseCX=1920\nBaseCY=1080\nOutputCX=1920\nOutputCY=1080\nFPSType=0\nFPSCommon=60\n'
    : '[Output]\nMode=Simple\n\n[Video]\nBaseCX=3840\nBaseCY=2160\nOutputCX=3840\nOutputCY=2160\nFPSType=0\nFPSCommon=30\n')
  await writeFile(path.join(profileDirectory, 'streamEncoder.json'), JSON.stringify(initiallyRunning
    ? { rate_control: 'CBR', bitrate: 10000, keyint_sec: 2, bf: 2, lookahead: false }
    : { preset: 'p5' }))
  const store = new DataStore(dataDirectory)
  await store.initialize()
  const values = new Map<SecretName, string>()
  const setSecret = vi.fn((name: SecretName, value: string) => value ? values.set(name, value) : values.delete(name))
  const secrets = { set: setSecret } as unknown as SecretStore
  const provisioner = new LocalObsProvisioner(store, secrets, {
    obsConfigDirectory: obsDirectory,
    isObsRunning: typeof running === 'function' ? running : async () => running,
  })
  return { obsDirectory, provisioner, setSecret, store, values }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('local OBS provisioning', () => {
  it('treats an environment-overridden OBS directory as an isolated fixture', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-local-obs-env-'))
    directories.push(directory)
    const dataDirectory = path.join(directory, 'data')
    const obsDirectory = path.join(directory, 'obs-studio')
    const profileDirectory = path.join(obsDirectory, 'basic', 'profiles', 'Default')
    await mkdir(path.join(obsDirectory, 'plugin_config', 'obs-websocket'), { recursive: true })
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(path.join(obsDirectory, 'global.ini'), '[General]\nName=OBS\n\n[Basic]\nProfile=Default\nProfileDir=Default\n\n[BasicWindow]\nExtraBrowserDocks=[]\n')
    await writeFile(path.join(profileDirectory, 'basic.ini'), '[Output]\nMode=Simple\n\n[Video]\nBaseCX=3840\nBaseCY=2160\nOutputCX=3840\nOutputCY=2160\nFPSCommon=30\n')
    await writeFile(path.join(profileDirectory, 'streamEncoder.json'), '{}')
    vi.stubEnv('OBS_STREAM_MANAGER_OBS_CONFIG_DIR', obsDirectory)
    const store = new DataStore(dataDirectory)
    await store.initialize()
    const values = new Map<SecretName, string>()
    const secrets = {
      set: vi.fn((name: SecretName, value: string) => value ? values.set(name, value) : values.delete(name)),
    } as unknown as SecretStore

    const provisioner = new LocalObsProvisioner(store, secrets)

    await expect(provisioner.prepare()).resolves.toMatchObject({
      phase: 'ready',
      dockConfigured: true,
      websocketConfigured: true,
      outputConfigured: true,
    })
    expect(values.get('obs-password')).toBeTruthy()
  })

  it('enables OBS control, registers the dock, and stores the generated password', async () => {
    const test = await harness()
    const status = await test.provisioner.prepare()
    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true, outputConfigured: true })
    const websocket = JSON.parse(await readFile(path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(websocket).toMatchObject({ auth_required: true, first_load: false, server_enabled: true, server_port: 4455 })
    expect(typeof websocket.server_password).toBe('string')
    expect(test.values.get('obs-password')).toBe(websocket.server_password)
    await expect(readFile(path.join(test.obsDirectory, 'global.ini'), 'utf8')).resolves.toContain('"title":"Stream Manager"')
    const userIni = await readFile(path.join(test.obsDirectory, 'user.ini'), 'utf8')
    expect(userIni).toContain('"title":"Stream Manager"')
    expect(userIni).toContain('[OBSWebSocket]')
    expect(userIni).toContain('[Basic]')
    expect(userIni).toContain('ProfileDir=Default')
    expect(userIni).toContain(`ServerPassword=${String(websocket.server_password)}`)
    const profile = await readFile(path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'basic.ini'), 'utf8')
    expect(profile).toContain('[General]\nAutoRemux=false')
    expect(profile).toContain('[Output]\nMode=Advanced')
    expect(profile).toContain('BaseCX=1920')
    expect(profile).toContain('OutputCY=1080')
    expect(profile).toContain('FPSType=0')
    expect(profile).toContain('FPSCommon=60')
    expect(profile).toContain('TrackIndex=6')
    expect(profile).toContain('RecTracks=63')
    expect(profile).toContain('Track1Name=GAME')
    expect(profile).toContain('Track6Name=STREAM MIX')
    const encoder = JSON.parse(await readFile(path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'streamEncoder.json'), 'utf8')) as Record<string, unknown>
    expect(encoder).toEqual({ preset: 'p5', rate_control: 'CBR', bitrate: 10000, keyint_sec: 2, bf: 2, lookahead: false })
    const profileAfterFirstPrepare = await readFile(path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'basic.ini'), 'utf8')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await utimes(websocketPath, new Date(1_000), new Date(1_000))
    await expect(test.provisioner.prepare()).resolves.toMatchObject({ phase: 'ready', outputConfigured: true })
    await expect(readFile(path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'basic.ini'), 'utf8')).resolves.toBe(profileAfterFirstPrepare)
    expect((await stat(websocketPath)).mtimeMs).toBe(1_000)
    expect(test.setSecret).toHaveBeenCalledTimes(1)
    await expect(test.store.getConfig()).resolves.toMatchObject({ obs: { url: 'ws://127.0.0.1:4455', passwordStored: true } })
  })

  it('preserves valid JSON websocket values when OBS 31 user.ini contains only a partial section', async () => {
    const test = await harness()
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[BasicWindow]\nExtraBrowserDocks=[]\n\n[OBSWebSocket]\nServerEnabled=false\n')
    await writeFile(websocketPath, JSON.stringify({
      auth_required: true,
      server_enabled: true,
      server_password: 'preserved-password',
      server_port: 4466,
    }))

    const status = await test.provisioner.prepare()
    const userIni = await readFile(userPath, 'utf8')

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
    expect(userIni).toContain('ServerPassword=preserved-password')
    expect(userIni).toContain('ServerPort=4466')
    expect(test.values.get('obs-password')).toBe('preserved-password')
  })

  it('does not inherit stale enabled websocket defaults while authoritative user.ini is live', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[Basic]\nProfile=Default\nProfileDir=Default\n\n[BasicWindow]\nExtraBrowserDocks=[{"title":"Stream Manager","url":"http://127.0.0.1:4317"}]\n\n[OBSWebSocket]\nFirstLoad=false\n')
    await writeFile(websocketPath, JSON.stringify({
      auth_required: true,
      server_enabled: true,
      server_password: 'stale-password',
      server_port: 4466,
    }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', dockConfigured: true, websocketConfigured: false })
    expect(test.values.has('obs-password')).toBe(false)
  })

  it('does not import a stale JSON password when the live OBS 31 INI has no password', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[Basic]\nProfile=Default\nProfileDir=Default\n\n[BasicWindow]\nExtraBrowserDocks=[{"title":"Stream Manager","url":"http://127.0.0.1:4317"}]\n\n[OBSWebSocket]\nFirstLoad=false\nServerEnabled=true\nAuthRequired=true\nServerPort=4455\n')
    await writeFile(websocketPath, JSON.stringify({
      auth_required: true,
      server_enabled: true,
      server_password: 'stale-password',
      server_port: 4455,
    }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', dockConfigured: true, websocketConfigured: false })
    expect(test.values.has('obs-password')).toBe(false)
    expect(test.setSecret).not.toHaveBeenCalled()
  })

  it('repairs malformed dock JSON from a backup without blocking websocket and profile setup', async () => {
    const test = await harness()
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const corrupt = '[Basic]\nProfile=Default\nProfileDir=Default\n\n[BasicWindow]\nExtraBrowserDocks=[{broken-json]\n'
    await writeFile(userPath, corrupt)

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true, outputConfigured: true })
    expect(status.detail).toContain('バックアップして修復')
    await expect(readFile(`${userPath}.obs-stream-manager-backup`, 'utf8')).resolves.toBe(corrupt)
    const repaired = await readFile(userPath, 'utf8')
    expect(JSON.parse(/^ExtraBrowserDocks=(.*)$/m.exec(repaired)?.[1] ?? '[]')).toEqual([
      expect.objectContaining({ url: 'http://127.0.0.1:4317' }),
    ])
  })

  it('does not report a legacy websocket config ready when its port is invalid', async () => {
    const test = await harness(true)
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(websocketPath, JSON.stringify({
      auth_required: true,
      server_enabled: true,
      server_password: 'existing-password',
      server_port: 70_000,
    }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', websocketConfigured: false })
    expect(test.values.has('obs-password')).toBe(false)
  })

  it('uses OBS 31 user.ini for browser docks without writing the obsolete global.ini setting', async () => {
    const test = await harness()
    const globalPath = path.join(test.obsDirectory, 'global.ini')
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const globalBefore = await readFile(globalPath, 'utf8')
    await writeFile(userPath, '[General]\r\nName=OBS\r\n\r\n[BasicWindow]\r\nExtraBrowserDocks=[]\r\n')

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
    const userIni = await readFile(userPath, 'utf8')
    expect(userIni).toContain('"title":"Stream Manager"')
    expect(userIni).toContain('[OBSWebSocket]')
    expect(userIni).toContain('ServerEnabled=true')
    expect(userIni).toContain('AuthRequired=true')
    expect(userIni).toMatch(/ServerPassword=[A-Za-z0-9_-]+/)
    await expect(readFile(globalPath, 'utf8')).resolves.toBe(globalBefore)
  })

  it('repairs an OBS 31 user.ini that explicitly disables the websocket server', async () => {
    const test = await harness()
    const userPath = path.join(test.obsDirectory, 'user.ini')
    await writeFile(userPath, '[BasicWindow]\r\nExtraBrowserDocks=[]\r\n\r\n[OBSWebSocket]\r\nServerEnabled=false\r\nAuthRequired=true\r\nServerPassword=existing-password\r\nServerPort=4455\r\n')

    const status = await test.provisioner.prepare()
    const userIni = await readFile(userPath, 'utf8')

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
    expect(userIni).toContain('ServerEnabled=true')
    expect(userIni).toContain('ServerPassword=existing-password')
    expect(test.values.get('obs-password')).toBe('existing-password')
  })

  it('repairs a null legacy websocket config while OBS is stopped', async () => {
    const test = await harness()
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(websocketPath, 'null')

    const status = await test.provisioner.prepare()
    const websocket = JSON.parse(await readFile(websocketPath, 'utf8')) as Record<string, unknown>

    expect(status).toMatchObject({ phase: 'ready', websocketConfigured: true })
    expect(websocket).toMatchObject({ auth_required: true, server_enabled: true, server_port: 4455 })
    expect(typeof websocket.server_password).toBe('string')
  })

  it('does not report OBS 31 ready while its authoritative user.ini disables websocket', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[BasicWindow]\nExtraBrowserDocks=[{"title":"Stream Manager","url":"http://127.0.0.1:4317"}]\n\n[OBSWebSocket]\nServerEnabled=false\nAuthRequired=true\nServerPassword=existing-password\nServerPort=4455\n')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'existing-password', server_port: 4455 }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', dockConfigured: true, websocketConfigured: false })
    await expect(readFile(userPath, 'utf8')).resolves.toContain('ServerEnabled=false')
  })

  it('recognizes an OBS 31 dock already stored in user.ini while OBS is running', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[BasicWindow]\nExtraBrowserDocks=[{"title":"OBS Stream Manager","url":"http://127.0.0.1:4317","uuid":"existing"}]\n\n[OBSWebSocket]\nServerEnabled=true\nAuthRequired=true\nServerPassword=existing-password\nServerPort=4455\n')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'existing-password', server_port: 4455 }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
  })

  it('does not report ready or rewrite a Simple/4K profile while OBS is running', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    const profilePath = path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'basic.ini')
    await writeFile(userPath, '[Basic]\nProfile=Default\nProfileDir=Default\n\n[BasicWindow]\nExtraBrowserDocks=[{"title":"Stream Manager","url":"http://127.0.0.1:4317"}]\n\n[OBSWebSocket]\nServerEnabled=true\nAuthRequired=true\nServerPassword=existing-password\nServerPort=4455\n')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'existing-password', server_port: 4455 }))
    await writeFile(profilePath, '[Output]\nMode=Simple\n\n[Video]\nBaseCX=3840\nBaseCY=2160\nOutputCX=3840\nOutputCY=2160\nFPSCommon=30\n')
    const before = await readFile(profilePath, 'utf8')

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', dockConfigured: true, websocketConfigured: true, outputConfigured: false })
    await expect(readFile(profilePath, 'utf8')).resolves.toBe(before)
  })

  it('preserves an unreadable encoder file instead of overwriting it', async () => {
    const test = await harness()
    const encoderPath = path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'streamEncoder.json')
    await writeFile(encoderPath, '{broken-json')

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'error', outputConfigured: false })
    expect(status.detail).toContain('OBSの配信エンコーダー設定を安全に読み取れませんでした')
    await expect(readFile(encoderPath, 'utf8')).resolves.toBe('{broken-json')
  })

  it('never rewrites OBS files while OBS is running', async () => {
    const test = await harness(true)
    const before = await readFile(path.join(test.obsDirectory, 'global.ini'), 'utf8')
    const status = await test.provisioner.prepare()
    expect(status).toMatchObject({ phase: 'restart_required', dockConfigured: false, websocketConfigured: false })
    await expect(readFile(path.join(test.obsDirectory, 'global.ini'), 'utf8')).resolves.toBe(before)
    await expect(readFile(path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8')).rejects.toThrow()
  })

  it('stops before writing when OBS launches during provisioning', async () => {
    let checks = 0
    const test = await harness(async () => {
      checks += 1
      return checks > 3
    })
    const profilePath = path.join(test.obsDirectory, 'basic', 'profiles', 'Default', 'basic.ini')
    const profileBefore = await readFile(profilePath, 'utf8')

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', outputConfigured: false })
    expect(status.detail).toContain('OBSが起動したため')
    await expect(readFile(profilePath, 'utf8')).resolves.toBe(profileBefore)
    await expect(readFile(path.join(test.obsDirectory, 'user.ini'), 'utf8')).rejects.toThrow()
  })

  it('imports an already-running OBS password without changing OBS settings', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[Basic]\nProfile=Default\nProfileDir=Default\n\n[BasicWindow]\nExtraBrowserDocks=[{"title":"Stream Manager","url":"http://127.0.0.1:4317"}]\n\n[OBSWebSocket]\nServerEnabled=true\nAuthRequired=true\nServerPassword=existing-password\nServerPort=4466\n')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'existing-password', server_port: 4466 }))
    const status = await test.provisioner.prepare()
    expect(status.phase).toBe('ready')
    expect(status.websocketConfigured).toBe(true)
    expect(test.values.get('obs-password')).toBe('existing-password')
    await expect(test.store.getConfig()).resolves.toMatchObject({ obs: { url: 'ws://127.0.0.1:4466', passwordStored: true } })
  })

  it('does not trust legacy JSON alone during the first live OBS 31 run', async () => {
    const test = await harness(true)
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'stale-password', server_port: 4455 }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'restart_required', websocketConfigured: false })
    expect(test.setSecret).not.toHaveBeenCalled()
    expect(test.values.has('obs-password')).toBe(false)
  })

  it('preserves other docks and stays idempotent', () => {
    const input = '[BasicWindow]\nExtraBrowserDocks=[{"title":"Chat","url":"https://example.test","uuid":"chat"}]\n'
    const once = upsertBrowserDock(input)
    const twice = upsertBrowserDock(once)
    expect(twice).toBe(once)
    expect(JSON.parse(/^ExtraBrowserDocks=(.*)$/m.exec(once)?.[1] ?? '[]')).toHaveLength(2)
  })
})
