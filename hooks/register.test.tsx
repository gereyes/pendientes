import { expect, mock, test } from 'claude-code/testing'

import { add, age, close, open, parse, render } from './list'

const FILE = '/tmp/proyecto/.claude/pendientes.md'

test('the file format round-trips and closing never rewrites text', async () => {
  let items = add([], 'Agregar ícono al mod', '2026-10-31')
  items = add(items, 'Línea\ncon salto — creado raro', '2026-10-31')
  expect(items[1]?.text).toBe('Línea con salto - creado raro')

  const closed = close(items, 1, 'done', '2026-11-01')
  expect(closed?.[0]).toEqual({ text: 'Agregar ícono al mod', created: '2026-10-31', status: 'done', closed: '2026-11-01' })
  expect(close(items, 9, 'done', '2026-11-01')).toBeNull()

  const text = render(closed ?? [])
  expect(text).toContain('- [ ] Línea con salto - creado raro — creado 2026-10-31')
  expect(text).toContain('- [x] Agregar ícono al mod — creado 2026-10-31, hecho 2026-11-01')
  // The file groups open items first, then closed ones; each keeps its text and dates.
  expect(parse(text).map(i => [i.text, i.status, i.created, i.closed ?? null])).toEqual([
    ['Línea con salto - creado raro', 'open', '2026-10-31', null],
    ['Agregar ícono al mod', 'done', '2026-10-31', '2026-11-01'],
  ])
})

test('tools add and close items, and the guard blocks direct edits', async ($, on) => {
  const files: Record<string, string> = {}
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', async () => ({ value: '/tmp/proyecto' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: { tool: 'x' } }) as never)
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => ({ value: files[(e as { path: string }).path] }) as never)
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('tool.call', async () => ({ result: 'ran' }) as never)
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  mock.store(on, {})

  await $.session.start({ source: 'startup', cwd: '/tmp/proyecto', surface: 'terminal', isInteractive: true } as never)

  const added = await $.tool.call({ tool: 'mcp__pendientes__agregar', texto: 'Agregar ícono' } as never)
  expect(String(added.result)).toContain('1. Agregar ícono (creado 2026-10-31)')
  await $.tool.call({ tool: 'mcp__pendientes__agregar', texto: 'Escribir README' } as never)

  const closed = await $.tool.call({ tool: 'mcp__pendientes__cerrar', numero: 1, estado: 'hecho' } as never)
  expect(String(closed.result)).toContain('1. Escribir README')
  expect(files[FILE]).toContain('- [x] Agregar ícono — creado 2026-10-31, hecho 2026-10-31')

  const missing = await $.tool.call({ tool: 'mcp__pendientes__cerrar', numero: 5, estado: 'hecho' } as never)
  expect(missing.deny).toContain('No hay un pendiente abierto con el número 5')

  for (const call of [
    { tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' },
    { tool: 'Write', file_path: '.claude/pendientes.md', content: '' },
    { tool: 'Bash', command: `sd "README" "otro" ${FILE}` },
    { tool: 'Bash', command: 'echo hola > .claude/pendientes.md' },
  ]) {
    expect((await $.tool.call(call as never)).deny).toContain('solo se cambia con')
  }
  for (const call of [
    { tool: 'Bash', command: `bat ${FILE}` },
    { tool: 'Bash', command: `fd -g pendientes.md ~ 2>/dev/null | rg pendientes.md` },
    { tool: 'Edit', file_path: '/tmp/proyecto/README.md', old_string: 'a', new_string: 'b' },
  ]) {
    expect((await $.tool.call(call as never)).deny).toBeUndefined()
  }
})

test('age reads as plain words', () => {
  expect(age('2026-10-31', '2026-10-31')).toBe('creado hoy')
  expect(age('2026-10-30', '2026-10-31')).toBe('creado ayer')
  expect(age('2026-10-28', '2026-10-31')).toBe('creado hace 3 días')
})

test('where the pane cannot be drawn, /pendientes answers with the list as text', async ($, on) => {
  const files: Record<string, string> = {}
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', async () => ({ value: '/tmp/proyecto' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: { tool: 'x' } }) as never)
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => ({ value: files[(e as { path: string }).path] }) as never)
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  on('ui.open', async () => ({ value: { isPlaced: false, reason: 'the attached surfaces place no panes' } }) as never)
  on('ui.log', async () => ({ value: undefined }) as never)
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  mock.store(on, {})

  await $.session.start({ source: 'startup', cwd: '/tmp/proyecto', surface: 'desktop', isInteractive: true } as never)
  await $.tool.call({ tool: 'mcp__pendientes__agregar', texto: 'Agregar ícono' } as never)

  const out = await $.command.run({ command: 'pendientes', args: '' } as never)
  const text = String((out as { text?: unknown }).text)
  expect(text).not.toContain('Panel de pendientes abierto')
  expect(text).toContain('1. Agregar ícono (creado 2026-10-31)')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a panel button asks before closing an item (${surface})`, async ($, on) => {
    const files: Record<string, string> = {}
    on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
    on('session.cwd', async () => ({ value: '/tmp/proyecto' }) as never)
    on('command.register', async () => ({ value: undefined }) as never)
    on('tool.register', async () => ({ value: { tool: 'x' } }) as never)
    on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
    on('fs.read', async ($, e) => ({ value: files[(e as { path: string }).path] }) as never)
    on('fs.write', async ($, e) => {
      const { path, text } = e as { path: string; text: string }
      files[path] = text
      return { value: undefined } as never
    })
    mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
    mock.store(on, {})
    // A message an older version left behind must not survive the next load.
    let stale = true
    on('state.get', async ($, e, next) =>
      (e as { key: string }).key === 'note' && stale ? ({ value: { value: { text: 'Hecho: viejo', tone: 'done' }, version: 1 } } as never) : next(e),
    )
    on('state.set', async ($, e, next) => {
      if ((e as { key: string }).key === 'note') stale = false
      return next(e)
    })

    files[FILE] = render(add([], 'Agregar ícono', '2026-10-31'))
    await $.session.start({ source: 'startup', cwd: '/tmp/proyecto', surface, isInteractive: true } as never)
    const before = files[FILE]

    const props = { title: 'Pendientes', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
    const ui = await $.ui.mount({ plugin: 'pendientes', surface, component: 'Pane', requestId: 'pendientes', props } as never)
    expect(await ui.find({ text: '1 pendiente abierto' })).toBeDefined()
    expect(await ui.find({ text: 'Hecho: viejo' })).toBeUndefined()

    await ui.press({ key: 'hecho-1' })
    expect(await ui.find({ text: '¿Marcar como hecho?' })).toBeDefined()
    expect(files[FILE]).toBe(before)

    await ui.press({ key: 'no' })
    expect(await ui.find({ text: '¿Marcar como hecho?' })).toBeUndefined()
    expect(files[FILE]).toBe(before)

    await ui.press({ key: 'hecho-1' })
    await ui.press({ key: 'si' })
    expect(files[FILE]).toContain('- [x] Agregar ícono — creado 2026-10-31, hecho 2026-10-31')
    expect(await ui.find({ text: 'Sin pendientes abiertos' })).toBeDefined()
    // The closed item shows once, under Cerrados, with no second message repeating it.
    expect(await ui.find({ text: 'Hechos: 1 de 1' })).toBeDefined()
    expect(await ui.find({ text: 'Hecho: Agregar ícono' })).toBeUndefined()
    await ui.unmount()
  })
}

test('the panel adds items, hides closed ones until asked, and reopens one as a new item', async ($, on) => {
  const files: Record<string, string> = {}
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.cwd', async () => ({ value: '/tmp/proyecto' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('tool.register', async () => ({ value: { tool: 'x' } }) as never)
  on('fs.exists', async ($, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async ($, e) => ({ value: files[(e as { path: string }).path] }) as never)
  on('fs.write', async ($, e) => {
    const { path, text } = e as { path: string; text: string }
    files[path] = text
    return { value: undefined } as never
  })
  mock.clock(on, { now: new Date(2026, 9, 31, 12).getTime() })
  mock.store(on, {})
  await $.session.start({ source: 'startup', cwd: '/tmp/proyecto', surface: 'desktop', isInteractive: true } as never)

  const props = { title: 'Pendientes', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never
  const ui = await $.ui.mount({ plugin: 'pendientes', surface: 'desktop', component: 'Pane', requestId: 'pendientes', props } as never)
  expect(await ui.find({ text: 'Todo al día' })).toBeDefined()

  // Enter adds; a blank field adds nothing.
  await ui.input({ key: 'nuevo', text: 'Comprar pan' })
  await ui.input({ key: 'nuevo', text: '   ' })
  await ui.input({ key: 'nuevo', text: 'Leer', kind: 'change' })
  await ui.input({ key: 'nuevo', text: 'Leer' })
  // The field's own submit is the only add control; a second button would show twice on the desktop.
  await expect(ui.press({ key: 'agregar' })).rejects.toThrow()
  expect(parse(files[FILE] ?? '').map(i => [i.text, i.status])).toEqual([
    ['Comprar pan', 'open'],
    ['Leer', 'open'],
  ])

  await ui.press({ key: 'hecho-1' })
  await ui.press({ key: 'si' })
  // Closed items stay folded away until the person opens the section.
  expect(await ui.find({ text: 'Comprar pan' })).toBeUndefined()

  await ui.press({ key: 'cerrados' })
  expect(await ui.find({ text: 'Comprar pan' })).toBeDefined()
  await ui.press({ key: 'retomar-1' })
  // Reopening appends a new open item; the closed line stays in the log.
  expect(files[FILE]).toContain('- [x] Comprar pan — creado 2026-10-31, hecho 2026-10-31')
  expect(open(parse(files[FILE] ?? '')).map(i => i.text)).toEqual(['Leer', 'Comprar pan'])

  // Reopening something already open again does not duplicate it.
  await ui.press({ key: 'retomar-1' })
  expect(open(parse(files[FILE] ?? '')).map(i => i.text)).toEqual(['Leer', 'Comprar pan'])
  expect(await ui.find({ text: 'Ese pendiente ya está abierto.' })).toBeDefined()
  await ui.unmount()
})
