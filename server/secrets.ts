import { Entry } from '@napi-rs/keyring'

const service = 'obs-stream-manager'
export type SecretName = 'obs-password' | 'obs-applied-stream-service' | 'obs-previous-stream-service' | 'steam-api-key' | 'youtube-client-secret' | 'youtube-refresh-token' | 'youtube-stream-key' | 'youtube-stream-server' | 'twitch-client-secret' | 'twitch-access-token' | 'twitch-refresh-token'

export class SecretStore {
  get(name: SecretName): string | null {
    return new Entry(service, name).getPassword() ?? null
  }

  set(name: SecretName, value: string): void {
    const entry = new Entry(service, name)
    if (value) entry.setPassword(value)
    else {
      try { entry.deletePassword() } catch { /* absent secrets are already deleted */ }
    }
  }
}
