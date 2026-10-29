import { expect, test } from 'claude-code/testing'

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

// What `tmux list-panes -s -F FORMAT` prints: two Claude panes, one shell.
const LIST = [
  ['1', '1', '@3', '%3', '2.1.312', 'this session'],
  ['0', '1', '@5', '%5', '2.1.312', 'other session'],
  ['0', '1', '@6', '%6', 'zsh', 'a shell'],
]
  .map(fields => fields.join('\x1f'))
  .join('\n')

test('pressing a row brings its pane and window to the front', async ($, on) => {
  const ran: string[][] = []
  on('command.register', () => ({ value: { command: 'tmux' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const stdout = e.argv[1] === 'list-panes' ? LIST : ''

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

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'tmux',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    ran.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: '%5' })

    const selects = ran.filter(argv => argv[1] !== 'list-panes')
    expect(selects).toEqual([
      ['tmux', 'select-pane', '-t', '%5'],
      ['tmux', 'select-window', '-t', '@5'],
    ])
    await ui.unmount()
  }
})
