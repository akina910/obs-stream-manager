import { ApiRequestError, type ServicePreparationResult } from './api'

function twitchOnlyFailure(services: ServicePreparationResult[]): ServicePreparationResult | undefined {
  const failures = services.filter((service) => !service.ok)
  return failures.length && failures.every((service) => service.service === 'twitch') ? failures[0] : undefined
}

// Provider preparation can be deferred until the user's explicit Start action.
// Never bypass an error just because its text mentions Twitch: only a structured
// Twitch-only preparation failure and explicit confirmation allow one retry.
export async function startStreamWithFallback<T>(dependencies: {
  start: (allowServiceFailures: boolean) => Promise<T>
  onServices: (services: ServicePreparationResult[]) => void
  confirmYouTubeOnly: (message: string) => boolean
}): Promise<T | null> {
  const attempt = async (allowServiceFailures: boolean) => {
    try { return await dependencies.start(allowServiceFailures) }
    catch (error) {
      if (error instanceof ApiRequestError && error.services) dependencies.onServices(error.services)
      throw error
    }
  }
  // Each new click rechecks readiness, so a successful reauthorization is not
  // bypassed because the previous click/selection retained a Twitch failure.
  try { return await attempt(false) }
  catch (error) {
    if (!(error instanceof ApiRequestError) || !error.services) throw error
    const failure = twitchOnlyFailure(error.services)
    if (!failure) throw error
    if (!dependencies.confirmYouTubeOnly(failure.message)) return null
    return attempt(true)
  }
}
