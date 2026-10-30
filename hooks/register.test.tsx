import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'tmux',
  component: 'Pane',
  requestId: 'tmux-sessions',
  props: {
    title: 'tmux',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const COMMAND = {
  command: 'tmux',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

// One pane per window: two Claude sessions and a shell. `mark` is the pane's
// @claude_state user option, empty when unset.
const PANES: { window: string; pane: string; command: string; title: string; mark?: string; roster?: boolean }[] = [
  { window: '@3', pane: '%3', command: '2.1.312', title: 'this session' },
  { window: '@5', pane: '%5', command: '2.1.312', title: 'other session' },
  { window: '@6', pane: '%6', command: 'zsh', title: 'a shell' },
]

// tmux as the mod meets it: list-panes reports the pane in front, select-pane
// brings one forward, wait-for blocks until wait-for -S wakes every waiter, and
// new-window opens a shell whose typed command reads as Claude Code, ready for
// input, from the `readyAt`th display on; typed `codex`, it reads as Codex at
// once and writes its own title from the `readyAt`th display on.
function fakeTmux(on: On, readyAt = 1, extra: typeof PANES = []) {
  const ran: string[][] = []
  const panes = [...PANES, ...extra].map(p => ({ ...p }))
  let front = '%3'
  let displays = 0
  let typed = ''
  let isUnloaded = false
  let wake = () => {}
  let signalled = new Promise<void>(resolve => (wake = resolve))
  const signal = () => {
    wake()
    signalled = new Promise<void>(resolve => (wake = resolve))
  }
  const list = () =>
    panes
      .map(p =>
        [p.pane === front ? '1' : '0', '1', p.window, p.pane, p.command, p.mark ?? '', p.title]
          .join('\x1f'),
      )
      .join('\n')
  const display = (pane: string) => {
    const p = panes.find(one => one.pane === pane)
    if (!p) return ''
    displays += 1
    if (typed.startsWith('codex')) {
      Object.assign(p, { command: 'codex', title: displays >= readyAt ? 'CorpusForge' : p.title })
    } else if (displays >= readyAt) Object.assign(p, { command: '2.1.312', title: '✳ Claude Code' })

    return `${p.command}\x1f${p.title}\n`
  }

  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    let stdout = ''
    if (argv[1] === 'list-panes') {
      // `-t <window>` reads that window's @claude_roster marks; the probe lists all
      stdout = argv[2] === '-t'
        ? panes.filter(p => p.window === argv[3]).map(p => (p.roster ? '1' : '')).join('\n')
        : list()
    }
    if (argv[1] === 'split-window') {
      const beside = panes.find(p => p.pane === argv[10])
      panes.push({ window: beside?.window ?? '', pane: '%50', command: 'tmux-roster', title: 'host' })
      stdout = '%50\n'
    }
    if (argv[1] === 'set-option' && argv[5] === '@claude_roster') {
      const marked = panes.find(p => p.pane === argv[4])
      if (marked) marked.roster = true
    }
    if (argv[1] === 'select-pane') front = argv[3] ?? front
    if (argv[1] === 'send-keys' && argv[4] === '-l') typed = argv[5] ?? ''
    if (argv[1] === 'wait-for' && argv[2] === '-S') signal()
    if (argv[1] === 'kill-pane') {
      const at = panes.findIndex(p => p.pane === argv[3])
      if (at >= 0) panes.splice(at, 1)
    }
    if (argv[1] === 'new-window') {
      panes.push({ window: '@7', pane: '%7', command: 'zsh', title: 'host' })
      stdout = '@7\x1f%7\x1fhost\n'
    }
    if (argv[1] === 'display') stdout = display(argv[4] ?? '')

    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('process.spawn', async function* (_, e) {
    ran.push([...e.argv])
    await signalled

    return {
      value: isUnloaded
        ? { code: null, signal: 'SIGTERM' }
        : { code: 0, signal: null },
    }
  })

  return {
    ran,
    panes,
    // What the mod ran but the probes and the waits on the channel.
    acts: () =>
      ran.filter(
        argv =>
          argv[1] !== 'list-panes' &&
          !(argv[1] === 'wait-for' && argv[2] !== '-S'),
      ),
    // Another session's click: its pane comes forward and it signals.
    clickElsewhere(pane: string) {
      front = pane
      signal()
    },
    // The module unloading kills the waiting child.
    unload() {
      isUnloaded = true
      signal()
    },
  }
}

async function start($: Parameters<TestBody>[0], on: On, readyAt = 1, extra: typeof PANES = []) {
  on('command.register', () => ({ value: { command: 'tmux' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  const tmux = fakeTmux(on, readyAt, extra)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(COMMAND)

  return { clock, tmux }
}

test('pressing a row brings its pane and window to the front', async ($, on) => {
  const { tmux } = await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    tmux.ran.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })

    // two rows, their two [x], and the two [new]
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
    await ui.press({ key: '%5' })

    expect(tmux.acts()).toEqual([
      ['tmux', 'select-pane', '-t', '%5'],
      ['tmux', 'select-window', '-t', '@5'],
      ['tmux', 'wait-for', '-S', 'claude-tmux-pane'],
    ])
    await ui.unmount()
  }
  tmux.unload()
})

test('a click in another session moves the highlight before the next poll', async ($, on) => {
  const { clock, tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const front = async () =>
    (await ui.find({ type: 'Text', text: /▶/ }))?.text

  expect(await front()).toBe('▶ this session')
  tmux.clickElsewhere('%5')
  // Settle without moving the clock: the 2 s poll stays asleep.
  await clock.advance(0)

  expect(await front()).toBe('▶ other session')
  await ui.unmount()
  tmux.unload()
})

// The `hover` the drawn tree gives the Button keyed `key`; `find` leaves it out.
function hoverOf(node: any, key: string): unknown {
  if (typeof node !== 'object' || node === null) return undefined
  if (node.type === 'Button' && node.props?.key === key) return node.hover
  for (const child of node.children ?? []) {
    const hover = hoverOf(child, key)
    if (hover !== undefined) return hover
  }

  return undefined
}

test('rows and [new] do not invert under the pointer, so no bar stays where a click left it', async ($, on) => {
  const { tmux } = await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const tree = await ui.drawn()
    expect(hoverOf(tree, '%3')).toEqual({ inverse: false })
    expect(hoverOf(tree, '%5')).toEqual({ inverse: false })
    expect(hoverOf(tree, 'new')).toEqual({ inverse: false, dimColor: true })
    expect(hoverOf(tree, 'new-codex')).toEqual({ inverse: false, dimColor: true })
    await ui.unmount()
  }
  tmux.unload()
})

const NEW_WINDOW = [
  'tmux', 'new-window', '-d', '-P', '-F', '#{window_id}\x1f#{pane_id}\x1f#{pane_title}', '-c', '/',
]
const DISPLAY = [
  'tmux', 'display', '-p', '-t', '%7', '#{pane_current_command}\x1f#{pane_title}',
]
const SWITCH = [
  ['tmux', 'select-pane', '-t', '%7'],
  ['tmux', 'select-window', '-t', '@7'],
  ['tmux', 'wait-for', '-S', 'claude-tmux-pane'],
]

test(
  '[new] starts the configured command in a new window and brings it forward',
  { options: { new_session_command: 'claude --dangerously-skip-permissions' } },
  async ($, on) => {
    const { tmux } = await start($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    tmux.ran.length = 0

    await ui.press({ key: 'new' })

    expect(tmux.acts()).toEqual([
      NEW_WINDOW,
      ['tmux', 'send-keys', '-t', '%7', '-l', 'claude --dangerously-skip-permissions'],
      ['tmux', 'send-keys', '-t', '%7', 'Enter'],
      DISPLAY,
      ...SWITCH,
    ])
    expect(await ui.find({ key: 'new' })).toBeDefined()
    await ui.unmount()
    tmux.unload()
  },
)

test('[new] spins until the new session waits for input, then switches', async ($, on) => {
  const { clock, tmux } = await start($, on, 3)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const spinner = async () =>
    (await ui.find({ type: 'Text', text: /starting Claude Code/ }))?.text
  tmux.ran.length = 0

  await ui.press({ key: 'new' })

  expect(await spinner()).toBe('  ◐ starting Claude Code…')
  expect(await ui.find({ key: 'new' })).toBeUndefined()
  await clock.advance(150)
  expect(await spinner()).toBe('  ◓ starting Claude Code…')
  expect(tmux.acts().some(argv => argv[1] === 'select-window')).toBe(false)

  await clock.advance(150)
  expect(await spinner()).toBeUndefined()
  expect(tmux.acts()).toEqual([
    NEW_WINDOW,
    ['tmux', 'send-keys', '-t', '%7', '-l', 'claude'],
    ['tmux', 'send-keys', '-t', '%7', 'Enter'],
    DISPLAY,
    DISPLAY,
    DISPLAY,
    ...SWITCH,
  ])
  await ui.unmount()
  tmux.unload()
})

const HOME = '/Users/me'
const SESSIONS = `${HOME}/.claude/sessions`

// Claude Code's session registry as measured on 2026-10-29: one file per
// running session, naming its tmux pane ("<session>:<window_id>.<pane_id>"),
// its kind and its status ("busy" while it works, "waiting" on a permission
// prompt).
const entry = (pid: number, tmux: string, status: string, startedAt: number, kind = 'interactive') =>
  JSON.stringify({ pid, sessionId: `s-${pid}`, kind, entrypoint: 'cli', status, startedAt, statusUpdatedAt: startedAt, tmux })

// The registry beneath the mod, listed in the order of `files`.
function fakeRegistry(on: On, files: Record<string, string>) {
  mock.env(on, { HOME })
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(path => path.startsWith(`${e.path}/`))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: no such file, open '${e.path}'`)

    return { value: text }
  })

  return files
}

const THIRD = [{ window: '@8', pane: '%8', command: '2.1.312', title: 'third session' }]
const rowText = async (ui: any, pane: string) => (await ui.find({ type: 'Button', key: pane }))?.text ?? ''
const suffix = async (ui: any, text: string) =>
  (await ui.find({ type: 'Text', text: new RegExp(`^${text}$`) }))?.props

test('each Claude session ends with its state: Active green, Needs you bold yellow, Idle white', async ($, on) => {
  fakeRegistry(on, {
    // a session that exited between the listing and the read: skipped, the rest still count
    [`${SESSIONS}/099.json`]: undefined as unknown as string,
    [`${SESSIONS}/300.json`]: entry(300, '2:@3.%3', 'busy', 1),
    [`${SESSIONS}/500.json`]: entry(500, '2:@5.%5', 'idle', 1),
    [`${SESSIONS}/800.json`]: entry(800, '2:@8.%8', 'idle', 1),
  })
  const { tmux } = await start($, on, 1, THIRD)
  const other = tmux.panes.find(p => p.pane === '%5')
  if (other) other.mark = 'pending'
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await rowText(ui, '%3')).endsWith(' -- Active')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Needs you')).toBe(true)
  expect((await rowText(ui, '%8')).endsWith(' -- Idle')).toBe(true)
  expect(await suffix(ui, ' -- Active')).toMatchObject({ color: 'green', dimColor: false })
  expect(await suffix(ui, ' -- Needs you')).toMatchObject({ color: 'yellow', weight: 'bold', dimColor: false })
  expect(await suffix(ui, ' -- Idle')).toMatchObject({ color: 'white', dimColor: false })
  // the fields this fake answers, in its order: the mark sits before the title
  const listing = tmux.ran.find(argv => argv[1] === 'list-panes')
  expect(listing?.slice(0, 4)).toEqual(['tmux', 'list-panes', '-s', '-F'])
  expect(listing?.[4]?.split('\x1f')).toEqual([
    '#{window_active}', '#{pane_active}', '#{window_id}', '#{pane_id}',
    '#{pane_current_command}', '#{@claude_state}', '#{pane_title}',
  ])
  // the name keeps its own highlight
  expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('▶ this session')
  await ui.unmount()
  tmux.unload()
})

test("a pane's newest interactive session gives its state; a stale or headless entry, or another pane's, does not", async ($, on) => {
  fakeRegistry(on, {
    // a crash left 100 behind; 101 runs there now; 103 is older than 101
    [`${SESSIONS}/100.json`]: entry(100, '2:@5.%5', 'busy', 1),
    [`${SESSIONS}/101.json`]: entry(101, '2:@5.%5', 'idle', 3),
    [`${SESSIONS}/103.json`]: entry(103, '2:@5.%5', 'busy', 2),
    // a headless run started from that pane, newer still
    [`${SESSIONS}/104.json`]: entry(104, '2:@5.%5', 'busy', 4, 'sdk'),
    // a busy session in a pane this list does not show
    [`${SESSIONS}/900.json`]: entry(900, '0:@9.%9', 'busy', 5),
  })
  const { tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await rowText(ui, '%5')).endsWith(' -- Idle')).toBe(true)
  expect((await rowText(ui, '%3')).endsWith(' -- Idle')).toBe(true)
  await ui.unmount()
  tmux.unload()
})

test('a pane marked active reads Active though its session is idle; a pending mark wins over busy', async ($, on) => {
  fakeRegistry(on, {
    [`${SESSIONS}/300.json`]: entry(300, '2:@3.%3', 'idle', 1),
    [`${SESSIONS}/500.json`]: entry(500, '2:@5.%5', 'busy', 1),
  })
  const { tmux } = await start($, on)
  for (const [pane, mark] of [['%3', 'active'], ['%5', 'pending']] as const) {
    const p = tmux.panes.find(one => one.pane === pane)
    if (p) p.mark = mark
  }
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await rowText(ui, '%3')).endsWith(' -- Active')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Needs you')).toBe(true)
  await ui.unmount()
  tmux.unload()
})

test('with no readable registry every unmarked session is Idle and the list still draws', async ($, on) => {
  mock.env(on, { HOME })
  on('fs.list', (_, e) => {
    throw new Error(`ENOENT: no such file or directory, scandir '${e.path}'`)
  })
  const { tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // two rows, their two [x], and the two [new]
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(6)
  expect((await rowText(ui, '%3')).endsWith(' -- Idle')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Idle')).toBe(true)
  await ui.unmount()
  tmux.unload()
})

test('the state follows the next poll: a session that goes idle, a pane that turns pending', async ($, on) => {
  const files = fakeRegistry(on, {
    [`${SESSIONS}/300.json`]: entry(300, '2:@3.%3', 'busy', 1),
    [`${SESSIONS}/500.json`]: entry(500, '2:@5.%5', 'idle', 1),
  })
  const { clock, tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await rowText(ui, '%3')).endsWith(' -- Active')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Idle')).toBe(true)

  files[`${SESSIONS}/300.json`] = entry(300, '2:@3.%3', 'idle', 1)
  const other = tmux.panes.find(p => p.pane === '%5')
  if (other) other.mark = 'pending'
  await clock.advance(2000)

  expect((await rowText(ui, '%3')).endsWith(' -- Idle')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Needs you')).toBe(true)
  await ui.unmount()
  tmux.unload()
})

test('a session waiting on a permission prompt reads Needs you, over an active mark', async ($, on) => {
  fakeRegistry(on, {
    [`${SESSIONS}/300.json`]: entry(300, '2:@3.%3', 'waiting', 1),
    [`${SESSIONS}/500.json`]: entry(500, '2:@5.%5', 'waiting', 1),
  })
  const { tmux } = await start($, on, 1)
  const marked = tmux.panes.find(p => p.pane === '%5')
  if (marked) marked.mark = 'active'
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await rowText(ui, '%3')).endsWith(' -- Needs you')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Needs you')).toBe(true)
  await ui.unmount()
  tmux.unload()
})

test('an idle or unknown mark defers to the registry; a shell status reads Idle', async ($, on) => {
  fakeRegistry(on, {
    [`${SESSIONS}/300.json`]: entry(300, '2:@3.%3', 'busy', 1),
    [`${SESSIONS}/500.json`]: entry(500, '2:@5.%5', 'busy', 1),
    [`${SESSIONS}/800.json`]: entry(800, '2:@8.%8', 'shell', 1),
  })
  const { tmux } = await start($, on, 1, THIRD)
  for (const [pane, mark] of [['%3', 'idle'], ['%5', 'later']] as const) {
    const p = tmux.panes.find(one => one.pane === pane)
    if (p) p.mark = mark
  }
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await rowText(ui, '%3')).endsWith(' -- Active')).toBe(true)
  expect((await rowText(ui, '%5')).endsWith(' -- Active')).toBe(true)
  expect((await rowText(ui, '%8')).endsWith(' -- Idle')).toBe(true)
  await ui.unmount()
  tmux.unload()
})

test('a snapshot the previous version stored, rows without an agent, is declined after the reload', async ($, on) => {
  on('state.get', ($, e, next) =>
    e.plugin === 'tmux' && e.key === 'snapshot'
      ? { value: { value: { shape: 'tmux-3', value: { inTmux: true, rows: [{ id: '%3', windowId: '@3', name: 'old row', command: '2.1.312', isActive: true, state: 'idle' }] } }, version: 1 } }
      : next(e),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.findAll({ type: 'Button', key: '%3' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /No Claude Code sessions/ }))?.text).toBe('No Claude Code sessions in this tmux session.')
  await ui.unmount()
})

const KILL = [
  ['tmux', 'kill-pane', '-t', '%5'],
  ['tmux', 'wait-for', '-S', 'claude-tmux-pane'],
]
const closeText = async (ui: any, pane: string) =>
  (await ui.find({ type: 'Button', key: `close:${pane}` }))?.text

test('[x] asks first; a second press kills that pane and the row leaves every list', async ($, on) => {
  const { clock, tmux } = await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await closeText(ui, '%5')).toBe('[x]')
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  tmux.ran.length = 0

  await ui.press({ key: 'close:%5' })
  expect(tmux.acts()).toEqual([])
  expect(await closeText(ui, '%5')).toBe('[close?]')
  expect(await closeText(ui, '%3')).toBe('[x]')

  await ui.press({ key: 'close:%5' })
  expect(tmux.acts()).toEqual(KILL)
  await clock.advance(0)
  expect(await ui.find({ type: 'Button', key: '%5' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: '%3' })).toBeDefined()
  await ui.unmount()
  tmux.unload()
})

test('an unanswered [close?] turns back after 3 s, and the next press only asks again', async ($, on) => {
  const { clock, tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  tmux.ran.length = 0

  await ui.press({ key: 'close:%5' })
  await clock.advance(2999)
  expect(await closeText(ui, '%5')).toBe('[close?]')
  await clock.advance(1)
  expect(await closeText(ui, '%5')).toBe('[x]')

  await ui.press({ key: 'close:%5' })
  expect(await closeText(ui, '%5')).toBe('[close?]')
  expect(tmux.acts()).toEqual([])
  await ui.unmount()
  tmux.unload()
})

test("asking on another row moves the ask; the first row's wait does not cut the second short", async ($, on) => {
  const { clock, tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  tmux.ran.length = 0

  await ui.press({ key: 'close:%3' })
  await clock.advance(2000)
  await ui.press({ key: 'close:%5' })
  expect(await closeText(ui, '%3')).toBe('[x]')
  expect(await closeText(ui, '%5')).toBe('[close?]')

  // %3's wait ends here; %5 still asks
  await clock.advance(1500)
  expect(await closeText(ui, '%5')).toBe('[close?]')
  await ui.press({ key: 'close:%3' })
  expect(tmux.acts()).toEqual([])

  await ui.press({ key: 'close:%3' })
  expect(tmux.acts()).toEqual([
    ['tmux', 'kill-pane', '-t', '%3'],
    ['tmux', 'wait-for', '-S', 'claude-tmux-pane'],
  ])
  await ui.unmount()
  tmux.unload()
})

// Two Codex panes, as tmux reports them: `codex` as the current command, and
// the title Codex writes for itself.
const CODEX = [
  { window: '@10', pane: '%10', command: 'codex', title: 'codex one', mark: 'active' },
  { window: '@11', pane: '%11', command: 'codex', title: 'codex two' },
]

test('Codex sessions list under their own header, the facing one in Codex blue', async ($, on) => {
  fakeRegistry(on, {
    // a busy Claude Code entry a crash left in a pane Codex runs in now
    [`${SESSIONS}/110.json`]: entry(110, '2:@11.%11', 'busy', 1),
  })
  const { clock, tmux } = await start($, on, 1, CODEX)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // four rows, their four [x], and the two [new]; the shell stays out
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(10)
    expect(await ui.find({ type: 'Text', text: /^Codex$/ })).toBeDefined()
    expect((await rowText(ui, '%10')).endsWith(' -- Active')).toBe(true)
    expect((await rowText(ui, '%11')).endsWith(' -- Idle')).toBe(true)
    expect(await closeText(ui, '%10')).toBe('[x]')
    // a Claude Code row facing the user keeps Claude's color
    expect((await ui.find({ type: 'Text', text: /▶/ }))?.props).toMatchObject({ color: 'claude', weight: 'bold' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  tmux.ran.length = 0
  await ui.press({ key: '%10' })
  expect(tmux.acts()).toEqual([
    ['tmux', 'select-pane', '-t', '%10'],
    ['tmux', 'select-window', '-t', '@10'],
    ['tmux', 'wait-for', '-S', 'claude-tmux-pane'],
  ])
  await clock.advance(0)
  const front = await ui.find({ type: 'Text', text: /▶/ })
  expect(front?.text).toBe('▶ ✳ codex one')
  expect(front?.props).toMatchObject({ color: '#63A8F8', weight: 'bold' })
  await ui.unmount()
  tmux.unload()
})

test('with only Codex sessions the Claude Code list says it is empty and [new] stays', async ($, on) => {
  const { tmux } = await start($, on, 1, CODEX)
  tmux.panes.splice(0, tmux.panes.length, ...tmux.panes.filter(p => p.command === 'codex'))
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /No Claude Code sessions/ }))?.text).toBe('No Claude Code sessions in this tmux session.')
  expect(await ui.find({ key: 'new' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: '%10' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: '%11' })).toBeDefined()
  await ui.unmount()
  tmux.unload()
})

test('without Codex sessions the Codex header still draws, with its [new]', async ($, on) => {
  const { tmux } = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /^Codex$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'new-codex' })).toBeDefined()
  await ui.unmount()
  tmux.unload()
})

test("a Codex row opens with Claude Code's ✳ bullet, in place of Codex's spinner", async ($, on) => {
  const { tmux } = await start($, on, 1, [
    { window: '@10', pane: '%10', command: 'codex', title: 'CorpusForge' },
    // Codex's title while it works: a braille spinner frame, a space, the rest
    { window: '@11', pane: '%11', command: 'codex', title: '⠹ fix the build | CorpusForge' },
  ])
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /CorpusForge$/ }))?.text).toBe('  ✳ CorpusForge')
  expect((await ui.find({ type: 'Text', text: /fix the build/ }))?.text).toBe('  ✳ fix the build | CorpusForge')
  // a Claude Code title already opens with its own ✳ and is drawn as written
  expect((await ui.find({ type: 'Text', text: /other session/ }))?.text).toBe('  other session')
  await ui.unmount()
  tmux.unload()
})

test(
  "Codex's [new] starts the configured command and switches once Codex writes its title",
  { options: { new_codex_command: 'codex --yolo' } },
  async ($, on) => {
    const { clock, tmux } = await start($, on, 3)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const spinner = async () => (await ui.find({ type: 'Text', text: /starting/ }))?.text
    tmux.ran.length = 0

    await ui.press({ key: 'new-codex' })

    // codex runs at once, but its title is still the window's first
    expect(await spinner()).toBe('  ◐ starting Codex…')
    expect(await ui.find({ key: 'new-codex' })).toBeUndefined()
    // the Claude Code [new] stays pressable meanwhile
    expect(await ui.find({ key: 'new' })).toBeDefined()
    await clock.advance(150)
    expect(await spinner()).toBe('  ◓ starting Codex…')
    expect(tmux.acts().some(argv => argv[1] === 'select-window')).toBe(false)

    await clock.advance(150)
    expect(await spinner()).toBeUndefined()
    expect(tmux.acts()).toEqual([
      NEW_WINDOW,
      ['tmux', 'send-keys', '-t', '%7', '-l', 'codex --yolo'],
      ['tmux', 'send-keys', '-t', '%7', 'Enter'],
      DISPLAY,
      DISPLAY,
      DISPLAY,
      ...SWITCH,
    ])
    await ui.unmount()
    tmux.unload()
  },
)

const ROSTER = (pane: string, window: string) => [
  ['tmux', 'list-panes', '-t', window, '-F', '#{@claude_roster}'],
  ['tmux', 'split-window', '-h', '-d', '-l', '32%', '-P', '-F', '#{pane_id}', '-t', pane, 'tmux-roster'],
  ['tmux', 'set-option', '-p', '-t', '%50', '@claude_roster', '1'],
]

test(
  'a Codex row brought forward gets the list beside it once, and a Claude Code row none',
  { options: { codex_roster_command: ' tmux-roster ' } },
  async ($, on) => {
    const { tmux } = await start($, on, 1, CODEX)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    tmux.ran.length = 0
    await ui.press({ key: '%10' })
    // the probes and the waits aside, with the roster's own mark read
    const read = (argv: string[]) => argv[1] === 'list-panes' && argv[2] === '-t'
    expect(tmux.ran.filter(argv => read(argv) || tmux.acts().includes(argv))).toEqual([
      ...ROSTER('%10', '@10'),
      ['tmux', 'select-pane', '-t', '%10'],
      ['tmux', 'select-window', '-t', '@10'],
      ['tmux', 'wait-for', '-S', 'claude-tmux-pane'],
    ])
    // the window holds its list now: a second press only switches
    tmux.ran.length = 0
    await ui.press({ key: '%10' })
    expect(tmux.ran.some(argv => argv[1] === 'split-window')).toBe(false)
    expect(tmux.ran).toContainEqual(['tmux', 'list-panes', '-t', '@10', '-F', '#{@claude_roster}'])
    tmux.ran.length = 0
    await ui.press({ key: '%5' })
    expect(tmux.ran.some(argv => argv[2] === '-t' && argv[1] === 'list-panes')).toBe(false)
    await ui.unmount()
    tmux.unload()
  },
)

test(
  "Codex's [new] gives the new window the list before switching to it",
  { options: { codex_roster_command: 'tmux-roster' } },
  async ($, on) => {
    const { clock, tmux } = await start($, on, 1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    tmux.ran.length = 0
    await ui.press({ key: 'new-codex' })
    await clock.advance(150)
    expect(tmux.acts().slice(-5)).toEqual([...ROSTER('%7', '@7').slice(1), ...SWITCH])
    expect(tmux.ran).toContainEqual(ROSTER('%7', '@7')[0])
    await ui.unmount()
    tmux.unload()
  },
)

test('without a list command a Codex row only switches', async ($, on) => {
  const { tmux } = await start($, on, 1, CODEX)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  tmux.ran.length = 0
  await ui.press({ key: '%11' })
  expect(tmux.ran.some(argv => argv[1] === 'split-window' || argv[2] === '-t' && argv[1] === 'list-panes')).toBe(false)
  await ui.unmount()
  tmux.unload()
})

// The hover of the name Text in the row Button keyed `key`.
function nameHoverOf(node: any, key: string): unknown {
  if (typeof node !== 'object' || node === null) return undefined
  if (node.type === 'Button' && node.props?.key === key) {
    const name = (node.children ?? []).find((child: any) => child?.type === 'Text')
    return name ? (name.hover ?? null) : undefined
  }
  for (const child of node.children ?? []) {
    const hover = nameHoverOf(child, key)
    if (hover !== undefined) return hover
  }

  return undefined
}

test("another session's name brightens on its row's hover; the facing one's does not", async ($, on) => {
  const { tmux } = await start($, on, 1, CODEX)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tree = await ui.drawn()
  // %3 faces the user
  expect(nameHoverOf(tree, '%3')).toBeNull()
  expect(nameHoverOf(tree, '%5')).toEqual({ dimColor: false })
  expect(nameHoverOf(tree, '%10')).toEqual({ dimColor: false })
  // the rows themselves still never invert
  expect(hoverOf(tree, '%5')).toEqual({ inverse: false })
  await ui.unmount()
  tmux.unload()
})

test('the row a session was left from stays dim under the pointer until the next press there', async ($, on) => {
  const { tmux } = await start($, on, 1, CODEX)
  await $.command.run(COMMAND)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: '%5' })
  // %5 came forward; back here, the pointer this session kept rests on its row
  tmux.clickElsewhere('%3')
  await $.command.run(COMMAND)
  let tree = await ui.drawn()
  expect(nameHoverOf(tree, '%5')).toBeNull()
  expect(nameHoverOf(tree, '%10')).toEqual({ dimColor: false })
  // a press here, the first [x] ask, lifts it
  await ui.press({ key: 'close:%10' })
  tree = await ui.drawn()
  expect(nameHoverOf(tree, '%5')).toEqual({ dimColor: false })
  await ui.unmount()
  tmux.unload()
})
