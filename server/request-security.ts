const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isUnsafeCrossOriginRequest(
  method: string,
  url: string,
  origin: string | undefined,
  fetchSite: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!url.startsWith('/api/') || safeMethods.has(method.toUpperCase())) return false
  if (fetchSite?.toLowerCase() === 'cross-site') return true
  if (!origin) return false // Native clients and package verification do not send Origin.
  return !allowedOrigins.has(origin)
}
