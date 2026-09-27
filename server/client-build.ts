export type ClientBuild = { entryScript: string | null }

export function clientKindFromUserAgent(userAgent: string): 'desktop' | 'obs-dock' | 'browser' {
  if (/\bElectron\/[\d.]+/i.test(userAgent)) return 'desktop'
  if (/(?:^|\s)OBS(?:-Browser)?\/[\d.]+(?:\s|$)/i.test(userAgent)) return 'obs-dock'
  return 'browser'
}

// Vite gives the entry bundle a content hash. Read it once at server startup so
// clients compare against the build this server is actually serving.
export function clientBuildFromHtml(html: string): ClientBuild {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*(['"])module\1/i.test(tag)) continue
    const source = tag.match(/\bsrc\s*=\s*(['"])([^'"]+)\1/i)?.[2]
    if (source && /^\/assets\/[^/?#]+\.js$/.test(source)) return { entryScript: source }
  }
  return { entryScript: null }
}
