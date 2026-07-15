export const startupListenRetryArgument = '--startup-listen-retry'

export class StartupListenTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Local server did not start within ${Math.ceil(timeoutMs / 1_000)} seconds`)
    this.name = 'StartupListenTimeoutError'
  }
}

export async function withStartupListenTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  // Promise.race registers a rejection handler too, but keep an explicit one
  // attached because the listen operation cannot be cancelled and may reject
  // after the timeout path has already started an app relaunch.
  void operation.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StartupListenTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function hasStartupListenRetried(args: string[]): boolean {
  return args.includes(startupListenRetryArgument)
}

export function startupListenRetryArgs(args: string[]): string[] {
  return hasStartupListenRetried(args) ? args : [...args, startupListenRetryArgument]
}
