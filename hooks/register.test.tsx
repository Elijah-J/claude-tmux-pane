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
// brings one forward, wait-for blocks until wait-for -S wakes every waiter.
function fakeTmux(on: On) {
  const ran: string[][] = []
  let front = '%3'
  let isUnloaded = false
  let wake = () => {}
  let signalled = new Promise<void>(resolve => (wake = resolve))
  const signal = () => {
    wake()
    signalled = new Promise<void>(resolve => (wake = resolve))
  }
  const list = () =>
    PANES.map(p =>
      [p.pane === front ? '1' : '0', '1', p.window, p.pane, p.command, p.title]
        .join('\x1f'),
    ).join('\n')

  on('process.run', (_, e) => {
    const argv = [...e.argv]
    ran.push(argv)
    if (argv[1] === 'select-pane') front = argv[3] ?? front
    if (argv[1] === 'wait-for' && argv[2] === '-S') signal()

    return {
      value: {
        exitCode: 0,
        stdout: argv[1] === 'list-panes' ? list() : '',
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

async function start($: Parameters<TestBody>[0], on: On) {
  on('command.register', () => ({ value: { command: 'tmux' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  const tmux = fakeTmux(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(COMMAND)

  return { clock, tmux }
}

test('pressing a row brings its pane and window to the front', async ($, on) => {
  const { tmux } = await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    tmux.ran.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: '%5' })

    expect(tmux.ran.filter(argv => argv[1] !== 'list-panes').slice(0, 3)).toEqual([
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
