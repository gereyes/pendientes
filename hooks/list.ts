// The file is a log: items are only appended or closed, never reworded or removed.

export type Status = 'open' | 'done' | 'dropped'
export type Item = { text: string; created: string; status: Status; closed?: string }

const HEADERS: Record<Status, string> = {
  open: '## Pendientes',
  done: '## Hechos',
  dropped: '## Descartados',
}
const MARKS: Record<Status, string> = { open: ' ', done: 'x', dropped: '-' }
const CLOSED_WORD: Record<Exclude<Status, 'open'>, string> = { done: 'hecho', dropped: 'descartado' }

const LINE = /^- \[( |x|-)\] (.*) — creado (\d{4}-\d{2}-\d{2})(?:, (?:hecho|descartado) (\d{4}-\d{2}-\d{2}))?$/

export function parse(text: string): Item[] {
  const items: Item[] = []
  for (const row of text.split('\n')) {
    const m = LINE.exec(row.trim())
    if (!m) continue
    const status: Status = m[1] === 'x' ? 'done' : m[1] === '-' ? 'dropped' : 'open'
    items.push({ text: m[2] ?? '', created: m[3] ?? '', status, closed: m[4] })
  }
  return items
}

function line(item: Item) {
  const closed = item.status === 'open' ? '' : `, ${CLOSED_WORD[item.status]} ${item.closed ?? ''}`
  return `- [${MARKS[item.status]}] ${item.text} — creado ${item.created}${closed}`
}

export function render(items: readonly Item[]) {
  const parts = ['# Pendientes del proyecto', '', 'Lo administra el mod pendientes: no lo edites a mano.']
  for (const status of ['open', 'done', 'dropped'] as const) {
    const rows = items.filter(i => i.status === status)
    if (status !== 'open' && rows.length === 0) continue
    parts.push('', HEADERS[status], '', ...(rows.length ? rows.map(line) : ['Nada pendiente.']))
  }
  return `${parts.join('\n')}\n`
}

export const open = (items: readonly Item[]) => items.filter(i => i.status === 'open')

export function age(created: string, today: string) {
  const days = Math.round((Date.parse(today) - Date.parse(created)) / 86_400_000)
  if (!Number.isFinite(days) || days <= 0) return 'creado hoy'
  return days === 1 ? 'creado ayer' : `creado hace ${days} días`
}

// One line per item: a newline or the " — creado" marker inside the text would break the format.
export function clean(text: string) {
  return text.replace(/\s+/g, ' ').replace(/ — creado/g, ' - creado').trim().slice(0, 300)
}

export function add(items: readonly Item[], text: string, today: string): Item[] {
  return [...items, { text: clean(text), created: today, status: 'open' }]
}

// `number` counts open items from 1, in the order the list shows them.
export function close(items: readonly Item[], number: number, status: Exclude<Status, 'open'>, today: string) {
  const target = open(items)[number - 1]
  if (!target) return null
  return items.map(i => (i === target ? { ...i, status, closed: today } : i))
}
