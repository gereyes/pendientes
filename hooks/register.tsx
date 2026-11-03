import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { add, age, close, open, parse, render } from './list'
import type { Item } from './list'
import type { Confirm } from '../types'

const PANE = 'pendientes'
const RELATIVE = '.claude/pendientes.md'
const ADD = 'mcp__pendientes__agregar'
const CLOSE = 'mcp__pendientes__cerrar'
const RECENT = 5

const note = atom({ plugin: 'pendientes', key: 'note' } as const, null)
const confirm = atom({ plugin: 'pendientes', key: 'confirm' } as const, null)
const draft = atom({ plugin: 'pendientes', key: 'draft' } as const, '')
const showClosed = atom({ plugin: 'pendientes', key: 'showClosed' } as const, false)

// Newest first; within one day, the item written later in the file counts as newer.
function closedRecent(items: readonly Item[]) {
  return items
    .filter(i => i.status !== 'open')
    .reverse()
    .sort((a, b) => (b.closed ?? '').localeCompare(a.closed ?? ''))
    .slice(0, RECENT)
}

async function addFromPanel($: EngineInterface, text: string) {
  if (!text.trim()) return
  await save($, add(await load($), text, await today($)))
  await update($, draft, () => '')
}

// Shell commands that can change a file; reading the list with cat, bat or rg stays allowed.
// A redirect only counts when it points at the list, so `2>/dev/null` in a search stays allowed.
const WRITES = /(>>?\s*['"]?[^\s'"|;&]*pendientes\.md|\btee\b|\bsed\b|\bsd\b|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bperl\b|\bpython3?\b|\bnode\b|\bruby\b|\bed\b|\bex\b|\bvim?\b)/

// Set at session.start; a reload runs session.start again, so it is never stale.
let file = ''

async function today($: EngineInterface) {
  return new Date(await $.clock.now()).toLocaleDateString('en-CA')
}

async function load($: EngineInterface): Promise<Item[]> {
  return (await $.fs.exists(file)) ? parse(String(await $.fs.read(file))) : []
}

// Any change to the list makes an old message or a pending question about a numbered row misleading.
async function save($: EngineInterface, items: readonly Item[]) {
  await $.fs.write(file, render(items))
  await update($, note, () => null)
  await update($, confirm, () => null)
  $.ui.invalidate('ui.render')
}

async function closeAndSave($: EngineInterface, number: number, status: 'done' | 'dropped') {
  const next = close(await load($), number, status, await today($))
  if (!next) return null
  await save($, next)
  return next
}

function summary(items: readonly Item[]) {
  const rows = open(items)
  if (rows.length === 0) return 'No hay pendientes abiertos en este proyecto.'
  return [`Pendientes abiertos (${rows.length}):`, ...rows.map((i, n) => `${n + 1}. ${i.text} (creado ${i.created})`)].join('\n')
}

function isListPath(path: string | undefined) {
  if (!path) return false
  const absolute = path.startsWith('/') ? path : `${file.slice(0, -RELATIVE.length)}${path.replace(/^\.\//, '')}`
  return absolute.replace(/\/+/g, '/') === file
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    file = `${await $.session.cwd()}/${RELATIVE}`
    // Session state outlives a reload; a message or question from older code would linger otherwise.
    await update($, note, () => null)
    await update($, confirm, () => null)
    await $.command.register({ name: 'pendientes', description: 'Abre el panel de pendientes de este proyecto', immediate: true })
    await $.tool.register({
      name: 'agregar',
      description:
        'Agrega un pendiente a la lista del proyecto (.claude/pendientes.md). Úsalo cuando surja una tarea que no se va a resolver en este turno, para que no se pierda. Una tarea por llamada, en una frase clara.',
      inputSchema: {
        type: 'object',
        properties: { texto: { type: 'string', description: 'La tarea, en una frase.' } },
        required: ['texto'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'cerrar',
      description:
        'Cierra un pendiente abierto de la lista del proyecto, por su número en la lista de abiertos. "hecho" si se completó, "descartado" si ya no aplica. El texto original nunca se modifica.',
      inputSchema: {
        type: 'object',
        properties: {
          numero: { type: 'integer', minimum: 1, description: 'Número del pendiente en la lista de abiertos.' },
          estado: { type: 'string', enum: ['hecho', 'descartado'] },
        },
        required: ['numero', 'estado'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  // Tells Claude, once per conversation, what is still open and how the list may change.
  on('prompt.context', async ($, e, next) => {
    const out = await next(e)
    const items = await load($)
    const text = [
      `Este proyecto lleva sus pendientes en ${RELATIVE}, administrado por el mod pendientes.`,
      `Cuando surja una tarea que no se resolverá en este turno, regístrala con ${ADD}; al completarla o descartarla, ciérrala con ${CLOSE}.`,
      'Nunca edites ese archivo directamente: el mod lo bloquea y el historial no se reescribe.',
      '',
      summary(items),
    ].join('\n')
    return { ...out, blocks: [...out.blocks, { name: 'pendientes', text }] }
  })

  on('tool.call', { tool: ADD }, async ($, e) => {
    const texto = String((e as { texto?: unknown }).texto ?? '').trim()
    if (!texto) return { deny: 'El pendiente necesita un texto.' }
    const items = add(await load($), texto, await today($))
    await save($, items)
    return { result: `Pendiente agregado.\n${summary(items)}` }
  }).catch(() => ({ deny: `No se pudo escribir en ${RELATIVE}.` }))

  on('tool.call', { tool: CLOSE }, async ($, e) => {
    const { numero, estado } = e as { numero?: unknown; estado?: unknown }
    const status = estado === 'descartado' ? 'dropped' : estado === 'hecho' ? 'done' : null
    if (!status || typeof numero !== 'number') return { deny: 'Indica el número del pendiente y si quedó "hecho" o "descartado".' }
    const items = await closeAndSave($, numero, status)
    if (items) return { result: `Pendiente ${estado}.\n${summary(items)}` }
    const current = await load($)
    return { deny: `No hay un pendiente abierto con el número ${numero}.\n${summary(current)}` }
  }).catch(() => ({ deny: `No se pudo escribir en ${RELATIVE}.` }))

  // The guard: the list only changes through the two tools above, never by editing the file.
  on('tool.call', async ($, e, next) => {
    const input = e as { tool: string; file_path?: string; notebook_path?: string; command?: string }
    const isEdit = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool) && isListPath(input.file_path ?? input.notebook_path)
    const isShellWrite = input.tool === 'Bash' && (input.command ?? '').includes('pendientes.md') && WRITES.test(input.command ?? '')
    if (isEdit || isShellWrite) {
      return { deny: `${RELATIVE} solo se cambia con ${ADD} o ${CLOSE}; así el historial no se reescribe.` }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'El guardia del mod pendientes falló; por seguridad no se ejecutó la acción.' }))

  on('command.run', { command: 'pendientes' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Pendientes' })
    if (opened.isPlaced) return { text: 'Panel de pendientes abierto.' }
    // Some surfaces (the desktop app, for one) do not draw panes; the list still has to reach the person.
    $.ui.log(`pendientes: pane not placed: ${opened.reason}`)
    const list = summary(await load($))
    return { text: `${list}\n\nAquí no se puede mostrar el panel. Para cerrar un pendiente, pídeselo a Claude con su número.` }
  })

  // A first press only asks; the item closes when the person confirms with "Sí".
  on('ui.press', { plugin: 'pendientes', element: /^(hecho|descartar)-\d+$/ }, async ($, e) => {
    const [action, raw] = e.element.split('-')
    const asked: Confirm = { number: Number(raw), action: action === 'hecho' ? 'hecho' : 'descartar' }
    await update($, note, () => null)
    await update($, confirm, () => asked)
    return { element: e.element }
  })

  on('ui.press', { plugin: 'pendientes', element: /^(si|no)$/ }, async ($, e) => {
    const asked = await read($, confirm)
    await update($, confirm, () => null)
    if (e.element === 'no' || !asked) return { element: e.element }
    const status = asked.action === 'hecho' ? 'done' : 'dropped'
    // A closed item shows up under "Cerrados"; only a failed close needs words of its own.
    const items = await closeAndSave($, asked.number, status)
    if (!items) await update($, note, () => ({ text: 'Ese pendiente ya no estaba abierto.' }))
    return { element: e.element }
  })

  on('ui.input', { plugin: 'pendientes', element: 'nuevo' }, async ($, e) => {
    if (e.kind === 'submit') await addFromPanel($, e.value)
    else await update($, draft, () => e.value)
    return { element: e.element, value: e.value }
  })


  on('ui.press', { plugin: 'pendientes', element: 'cerrados' }, async ($, e) => {
    await update($, showClosed, shown => !shown)
    return { element: e.element }
  })

  // Reopening never edits the closed line: the log gains a new open item with the same text.
  on('ui.press', { plugin: 'pendientes', element: /^retomar-\d+$/ }, async ($, e) => {
    const items = await load($)
    const target = closedRecent(items)[Number(e.element.split('-')[1]) - 1]
    if (!target) return { element: e.element }
    if (open(items).some(i => i.text === target.text)) {
      await update($, note, () => ({ text: 'Ese pendiente ya está abierto.' }))
      return { element: e.element }
    }
    await save($, add(items, target.text, await today($)))
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const items = await load($)
    const rows = open(items)
    const done = items.filter(i => i.status === 'done').length
    const dropped = items.filter(i => i.status === 'dropped').length
    const closedCount = done + dropped
    const recent = closedRecent(items)
    const isClosedShown = await read($, showClosed)
    const typed = await read($, draft)
    const message = await read($, note)
    const asked = await read($, confirm)
    const now = await today($)
    const cols = Math.max(30, e.props.bodyColumns)
    const total = items.length

    const tiles = [
      { key: 'abiertos', label: 'Abiertos', value: rows.length, color: 'claude' },
      { key: 'hechos', label: 'Hechos', value: done, color: 'success' },
      { key: 'descartados', label: 'Descartados', value: dropped, color: 'error' },
    ]

    // A full-width band per section: its title and count in bold on a filled background.
    const band = (key: string, label: string, fill: string, toggle?: boolean) => (
      <Box key={`band-${key}`} flexDirection="row" width="100%" alignItems="center" gap={1} backgroundColor={fill} paddingX={1}>
        {/* Only the arrow is a Button: the surface draws a Button natively and ignores its text color. */}
        {toggle === undefined ? null : <Button key={key} plain label={toggle ? '▾' : '▸'} onPress={() => undefined} />}
        <Text bold color="inverseText">
          {label}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" width={cols} gap={1}>
        <Box flexDirection="column">
          <Text size="title" weight="semibold" bold>
            Pendientes
          </Text>
          <Text size="caption" color="claude">
            {rows.length === 0 ? 'Sin pendientes abiertos' : rows.length === 1 ? '1 pendiente abierto' : `${rows.length} pendientes abiertos`}
          </Text>
        </Box>

        {total > 0 ? (
          <Box flexDirection="row" gap={1} width="100%">
            {tiles.map(t => (
              <Box key={`tile-${t.key}`} flexDirection="column" flexGrow={1} borderStyle="round" borderColor="inactive" borderDimColor paddingX={1}>
                <Text size="caption" dimColor wrap="truncate-end">
                  {t.label}
                </Text>
                <Text size="title" bold color={t.color}>
                  {t.value}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}

        {/* Both halves grow in proportion to their counts, so the bar spans the pane at any width. */}
        {total > 0 ? (
          <Box flexDirection="column">
            <Box flexDirection="row" width="100%">
              {done > 0 ? (
                <Box flexGrow={done} backgroundColor="success">
                  <Text> </Text>
                </Box>
              ) : null}
              {total - done > 0 ? (
                <Box flexGrow={total - done} backgroundColor="inactive">
                  <Text> </Text>
                </Box>
              ) : null}
            </Box>
            <Text size="caption" dimColor>
              Hechos: {done} de {total}
            </Text>
          </Box>
        ) : null}

        {/* The surface draws the field's own submit control, labelled here; a second button would repeat it. */}
        <Box width="100%">
          <Input key="nuevo" placeholder="Escribe un pendiente nuevo…" value={typed} submitLabel="Agregar" onSubmit={() => undefined} />
        </Box>

        {/* An earlier version stored notes in another shape; those must not draw an empty box. */}
        {typeof message?.text === 'string' ? (
          <Box borderStyle="round" borderColor="warning" paddingX={1}>
            <Text color="warning" wrap="wrap">
              {message.text}
            </Text>
          </Box>
        ) : null}

        <Box flexDirection="column" gap={1}>
          {band('abiertos', `Abiertos · ${rows.length}`, 'claude')}
          {rows.length === 0 ? (
            <Box flexDirection="column" alignItems="center" borderStyle="round" borderColor="inactive" borderDimColor paddingY={1}>
              <Text color="success" size="title">
                ✓
              </Text>
              <Text weight="medium">Todo al día</Text>
              <Text size="caption" dimColor>
                Escribe arriba tu siguiente pendiente.
              </Text>
            </Box>
          ) : null}
          {rows.map((item, n) => {
            const number = n + 1
            const isAsking = asked?.number === number
            const tone = asked?.action === 'hecho' ? 'success' : 'error'
            return (
              <Box
                key={`row-${number}`}
                flexDirection="row"
                gap={2}
                borderStyle="round"
                borderColor={isAsking ? tone : 'claude'}
                borderDimColor={!isAsking}
                hover={isAsking ? undefined : { borderColor: 'claude', borderDimColor: false }}
                paddingX={1}
                paddingY={1}
              >
                <Text size="title" color="claude">
                  ○
                </Text>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Text bold weight="semibold" wrap="wrap">
                      {item.text}
                    </Text>
                    <Text size="caption" dimColor>
                      #{number}
                    </Text>
                  </Box>
                  <Text size="caption" dimColor>
                    {age(item.created, now)}
                  </Text>
                  {isAsking ? (
                    <Box flexDirection="row" gap={1} alignItems="center" marginTop={1}>
                      <Text bold color={tone}>
                        {asked.action === 'hecho' ? '¿Marcar como hecho?' : '¿Descartar este pendiente?'}
                      </Text>
                      <Button key="si" label="Sí" variant="primary" onPress={() => undefined} />
                      <Button key="no" label="No" variant="secondary" onPress={() => undefined} />
                    </Box>
                  ) : (
                    <Box flexDirection="row" gap={1} justifyContent="flex-end" marginTop={1}>
                      <Button key={`hecho-${number}`} label="Hecho" variant="primary" onPress={() => undefined}>
                        <Text color="success">✓ Hecho</Text>
                      </Button>
                      <Button key={`descartar-${number}`} label="Descartar" variant="secondary" onPress={() => undefined}>
                        <Text color="error">✕ Descartar</Text>
                      </Button>
                    </Box>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>

        {closedCount > 0 ? (
          <Box flexDirection="column" gap={1}>
            {band('cerrados', `Cerrados · ${closedCount}`, 'inactive', isClosedShown)}
            {isClosedShown
              ? recent.map((item, n) => (
                  // Two lines, so a long text on a narrow pane cannot push the button out of view.
                  <Box key={`closed-${n}`} flexDirection="column" paddingX={1}>
                    <Box flexDirection="row" gap={1}>
                      <Text color={item.status === 'done' ? 'success' : 'error'}>{item.status === 'done' ? '✓' : '✕'}</Text>
                      <Text dimColor strikethrough wrap="wrap">
                        {item.text}
                      </Text>
                    </Box>
                    <Box flexDirection="row" justifyContent="space-between" alignItems="center" paddingLeft={2}>
                      <Text size="caption" dimColor>
                        {item.status === 'done' ? 'hecho' : 'descartado'} {item.closed}
                      </Text>
                      <Button key={`retomar-${n + 1}`} label="Retomar" variant="secondary" onPress={() => undefined} />
                    </Box>
                  </Box>
                ))
              : null}
          </Box>
        ) : null}
      </Box>
    )
  })
}
