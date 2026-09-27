export type GameExitPrompt = {
  id: string
  gameId: string
  gameName: string
  kind: 'recording' | 'stream' | 'stream-and-recording'
  /** Unix milliseconds. Null means an explicit Stop choice is required. */
  autoStopAt: number | null
}

export type GameExitAction = 'stop' | 'continue' | 'dismiss'

export type GameExitResponse = {
  stopped: boolean
  warnings: string[]
}
