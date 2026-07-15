const sensitiveField = /token|secret|password|api.?key|stream.?key|authorization|cookie|(?:^|_)code$/i
const sensitiveFieldInText = /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|stream[_-]?key|password|authorization|cookie|device[_-]?code|user[_-]?code|code)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,}]+)/gi
const bearerToken = /(bearer\s+)[a-z0-9._~+/-]+=*/gi

export function redactSensitiveText(value: string): string {
  return value
    .replace(bearerToken, '$1[REDACTED]')
    .replace(sensitiveFieldInText, '$1[REDACTED]')
}

export function isSensitiveField(name: string): boolean {
  return sensitiveField.test(name)
}
