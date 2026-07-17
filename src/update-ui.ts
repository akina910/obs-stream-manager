import type { RuntimeStatus } from '../shared/contracts'
import { getUpdateBlockReason, type DesktopUpdateState, type UpdateBlockReason } from '../shared/update-contracts'

export type DesktopUpdateAction = 'check' | 'download' | 'install' | 'open-releases' | 'none'

export type DesktopUpdateActionState = {
  action: DesktopUpdateAction
  disabled: boolean
  blockReason?: UpdateBlockReason
}

export function getDesktopUpdateAction(state: DesktopUpdateState, status: RuntimeStatus): DesktopUpdateActionState {
  switch (state.phase) {
    case 'idle':
    case 'up-to-date':
    case 'error':
      return { action: 'check', disabled: false }
    case 'available':
      return state.installSupported
        ? { action: 'download', disabled: false }
        : { action: 'open-releases', disabled: false }
    case 'downloaded': {
      const blockReason = getUpdateBlockReason(status)
      return blockReason
        ? { action: 'install', disabled: true, blockReason }
        : { action: 'install', disabled: false }
    }
    case 'checking':
    case 'downloading':
    case 'installing':
    case 'unsupported':
      return { action: 'none', disabled: true }
  }
}
