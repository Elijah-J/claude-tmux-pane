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

// One pane per window: two Claude sessions and a shell.
const PANES = [
  { window: '@3', pane: '%3', command: '2.1.312', title: 'this session' },
  { window: '@5', pane: '%5', command: '2.1.312', title: 'other session' },
  { window: '@6', pane: '%6', command: 'zsh', title: 'a shell' },
]

// tmux as the mod meets it: list-panes reports the pane in front, select-pane
// brings one forward, wait-for blocks until wait-for -S wakes every waiter, and
// new-window opens a shell whose typed command reads as Claude Code, ready for
// input, from the `readyAt`th display on.
function fakeTmux(on: On, readyAt = 1) {
  const ran: string[][] = []
  const panes = PANES.map(p => ({ ...p }))
  let front = '%3'
  let displays = 0
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
        [p.pane === front ? '1' : '0', '1', p.window, p.pane, p.command, p.title]
          .join('\x1f'),
      )
      .join('\n')
  const display = (pane: string) => {
    const p = panes.find(one => one.pane === pane)
    if (!p) return ''
    displays += 1
    if (displays >= readyAt) Object.assign(p, { command: '2.1.312', title: '✳ Claude Code' })

    return `${p.command}\x1f${p.title}\n`
  }

  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    let stdout = ''
    if (argv[1] === 'list-panes') stdout = list()
    if (argv[1] === 'select-pane') front = argv[3] ?? front
    if (argv[1] === 'wait-for' && argv[2] === '-S') signal()
    if (argv[1] === 'new-window') {
      panes.push({ window: '@7', pane: '%7', command: 'zsh', title: 'host' })
      stdout = '@7\x1f%7\n'
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

async function start($: Parameters<TestBody>[0], on: On, readyAt = 1) {
  on('command.register', () => ({ value: { command: 'tmux' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  const tmux = fakeTmux(on, readyAt)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(COMMAND)

  return { clock, tmux }
}

test('pressing a row brings its pane and window to the front', async ($, on) => {
  const { tmux } = await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    tmux.ran.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
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

const NEW_WINDOW = [
  'tmux', 'new-window', '-d', '-P', '-F', '#{window_id}\x1f#{pane_id}', '-c', '/',
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
