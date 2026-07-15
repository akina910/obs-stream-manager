import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const includeHistory = process.argv.includes('--history')
const cached = new Set(execFileSync('git', ['ls-files', '--cached'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean))
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
const forbiddenFiles = tracked.filter((filename) => filename !== '.env.example' && /(^|\/)(\.env(?:\..+)?|provider-oauth\.json)$/i.test(filename))

const patterns = [
  ['Google API key', new RegExp('AI' + 'za[0-9A-Za-z_-]{35}', 'g')],
  ['GitHub token', new RegExp('gh' + '[pousr]_[A-Za-z0-9]{36,255}', 'g')],
  ['GitHub fine-grained token', new RegExp('github_' + 'pat_[A-Za-z0-9_]{40,255}', 'g')],
  ['OpenAI API key', new RegExp('sk-' + '(?:proj-)?[A-Za-z0-9_-]{32,}', 'g')],
  ['AWS access key', new RegExp('AK' + 'IA[0-9A-Z]{16}', 'g')],
  ['Private key', new RegExp('-----BEGIN ' + '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----', 'g')],
]

function scan(label, content) {
  const findings = []
  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0
    if (pattern.test(content)) findings.push(`${label}: ${name}`)
  }
  return findings
}

const findings = [...forbiddenFiles.map((filename) => `tracked forbidden credential file: ${filename}`)]
for (const filename of tracked) {
  let contents
  try { contents = cached.has(filename) ? execFileSync('git', ['show', `:${filename}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) : readFileSync(filename, 'utf8') } catch {
    try { contents = readFileSync(filename, 'utf8') } catch { continue }
  }
  findings.push(...scan(filename, contents))
}

if (includeHistory) {
  const history = execFileSync('git', ['log', '-p', '--all', '--no-ext-diff', '--format=commit:%H'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  findings.push(...scan('git history', history))
}

if (findings.length) {
  console.error(`Secret scan failed:\n${[...new Set(findings)].join('\n')}`)
  process.exit(1)
}
console.log(`Secret scan passed (${tracked.length} tracked files${includeHistory ? ', full reachable history' : ''})`)
