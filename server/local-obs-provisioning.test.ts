import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalObsProvisioner, upsertBrowserDock } from './local-obs-provisioning.js'
import type { SecretName, SecretStore } from './secrets.js'
import { DataStore } from './storage.js'

const directories: string[] = []

async function harness(running = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'obs-stream-manager-local-obs-'))
  directories.push(directory)
  const dataDirectory = path.join(directory, 'data')
  const obsDirectory = path.join(directory, 'obs-studio')
  await mkdir(path.join(obsDirectory, 'plugin_config', 'obs-websocket'), { recursive: true })
  await writeFile(path.join(obsDirectory, 'global.ini'), '[General]\r\nName=OBS\r\n\r\n[BasicWindow]\r\nExtraBrowserDocks=[]\r\n')
  const store = new DataStore(dataDirectory)
  await store.initialize()
  const values = new Map<SecretName, string>()
  const secrets = { set: vi.fn((name: SecretName, value: string) => value ? values.set(name, value) : values.delete(name)) } as unknown as SecretStore
  const provisioner = new LocalObsProvisioner(store, secrets, { obsConfigDirectory: obsDirectory, isObsRunning: async () => running })
  return { obsDirectory, provisioner, store, values }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('local OBS provisioning', () => {
  it('enables OBS control, registers the dock, and stores the generated password', async () => {
    const test = await harness()
    const status = await test.provisioner.prepare()
    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
    const websocket = JSON.parse(await readFile(path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(websocket).toMatchObject({ auth_required: true, first_load: false, server_enabled: true, server_port: 4455 })
    expect(typeof websocket.server_password).toBe('string')
    expect(test.values.get('obs-password')).toBe(websocket.server_password)
    await expect(readFile(path.join(test.obsDirectory, 'global.ini'), 'utf8')).resolves.toContain('"title":"Stream Manager"')
    await expect(test.store.getConfig()).resolves.toMatchObject({ obs: { url: 'ws://127.0.0.1:4455', passwordStored: true } })
  })

  it('uses OBS 31 user.ini for browser docks without writing the obsolete global.ini setting', async () => {
    const test = await harness()
    const globalPath = path.join(test.obsDirectory, 'global.ini')
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const globalBefore = await readFile(globalPath, 'utf8')
    await writeFile(userPath, '[General]\r\nName=OBS\r\n\r\n[BasicWindow]\r\nExtraBrowserDocks=[]\r\n')

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
    await expect(readFile(userPath, 'utf8')).resolves.toContain('"title":"Stream Manager"')
    await expect(readFile(globalPath, 'utf8')).resolves.toBe(globalBefore)
  })

  it('recognizes an OBS 31 dock already stored in user.ini while OBS is running', async () => {
    const test = await harness(true)
    const userPath = path.join(test.obsDirectory, 'user.ini')
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(userPath, '[BasicWindow]\nExtraBrowserDocks=[{"title":"OBS Stream Manager","url":"http://127.0.0.1:4317","uuid":"existing"}]\n')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'existing-password', server_port: 4455 }))

    const status = await test.provisioner.prepare()

    expect(status).toMatchObject({ phase: 'ready', dockConfigured: true, websocketConfigured: true })
  })

  it('never rewrites OBS files while OBS is running', async () => {
    const test = await harness(true)
    const before = await readFile(path.join(test.obsDirectory, 'global.ini'), 'utf8')
    const status = await test.provisioner.prepare()
    expect(status).toMatchObject({ phase: 'restart_required', dockConfigured: false, websocketConfigured: false })
    await expect(readFile(path.join(test.obsDirectory, 'global.ini'), 'utf8')).resolves.toBe(before)
    await expect(readFile(path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8')).rejects.toThrow()
  })

  it('imports an already-running OBS password without changing OBS settings', async () => {
    const test = await harness(true)
    const websocketPath = path.join(test.obsDirectory, 'plugin_config', 'obs-websocket', 'config.json')
    await writeFile(websocketPath, JSON.stringify({ auth_required: true, server_enabled: true, server_password: 'existing-password', server_port: 4466 }))
    const status = await test.provisioner.prepare()
    expect(status.phase).toBe('restart_required')
    expect(status.websocketConfigured).toBe(true)
    expect(test.values.get('obs-password')).toBe('existing-password')
    await expect(test.store.getConfig()).resolves.toMatchObject({ obs: { url: 'ws://127.0.0.1:4466', passwordStored: true } })
  })

  it('preserves other docks and stays idempotent', () => {
    const input = '[BasicWindow]\nExtraBrowserDocks=[{"title":"Chat","url":"https://example.test","uuid":"chat"}]\n'
    const once = upsertBrowserDock(input)
    const twice = upsertBrowserDock(once)
    expect(twice).toBe(once)
    expect(JSON.parse(/^ExtraBrowserDocks=(.*)$/m.exec(once)?.[1] ?? '[]')).toHaveLength(2)
  })
})
