export const TITLE_TEMPLATE_VARIABLES = ['{game}', '{part}', '{date}', '{time}', '{datetime}'] as const

export type TitleTemplateContext = {
  game: string
  part: number
  now?: Date
}

const pad = (value: number) => String(value).padStart(2, '0')

export function renderTitleTemplate(template: string, context: TitleTemplateContext): string {
  const now = context.now ?? new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return template
    .replaceAll('{game}', context.game)
    .replaceAll('{part}', String(context.part))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{datetime}', `${date} ${time}`)
    .slice(0, 100)
}
