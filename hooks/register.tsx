import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TmuxPane, TmuxSnapshot } from '../types'

const PANE = 'tmux-sessions'

// Field separator for tmux -F output: the ASCII unit separator never appears in
// a pane title or command, so splitting on it is collision-proof.
const SEP = '\x1f'
const FORMAT = [
  '#{window_active}',
  '#{pane_active}',
  '#{window_id}',
  '#{pane_id}',
  '#{pane_current_command}',
  '#{pane_title}',
].join(SEP)

// Change the tag when a stored field changes: the engine then declines what an
// earlier version wrote, which outlives a reload.
const snapshot = atom(
  { plugin: 'tmux', key: 'snapshot' } as const,
  { inTmux: true, rows: [] } as TmuxSnapshot,
  { shape: 'tmux-2' },
)

// A tmux pane running Claude Code reports its version (e.g. "2.1.312") as the
// current command; a plain shell reports "zsh"/"bash", so this filters out the
// non-Claude windows and panes.
const isClaude = (command: string) => /^\d+\.\d+\.\d+/.test(command.trim())

async function probe($: EngineInterface): Promise<TmuxSnapshot> {
  let result
  try {
    // -s lists every pane in the current session (all its windows); run outside
    // tmux it exits non-zero, which we read as "not in a tmux session".
    result = await $.process.run(['tmux', 'list-panes', '-s', '-F', FORMAT])
  } catch {
    return { inTmux: false, rows: [] }
  }
  if (result.exitCode !== 0) return { inTmux: false, rows: [] }

  const rows = result.stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [
        windowActive,
        paneActive,
        windowId = '',
        id = '',
        command = '',
        ...rest
      ] = line.split(SEP)
      const name = (rest.join(SEP) || id).trim()
      return {
        id,
        windowId,
        name,
        command,
        // The user faces the active pane of the active window.
        isActive: windowActive === '1' && paneActive === '1',
      }
    })
    .filter(row => isClaude(row.command))

  return { inTmux: true, rows }
}

async function refresh($: EngineInterface): Promise<void> {
  const snap = await probe($)
  await update($, snapshot, () => snap)
}

// Bring a row's pane to the front: make it the active pane of its window, then
// make that window the current one. Pane and window IDs are unique for the life
// of the tmux server, so neither target can hit the wrong pane or window.
async function bringToFront($: EngineInterface, row: TmuxPane): Promise<void> {
  await $.process.run(['tmux', 'select-pane', '-t', row.id])
  await $.process.run(['tmux', 'select-window', '-t', row.windowId])
  // A pane closed since the last probe fails both selects; the probe drops it.
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tmux',
      description: 'Show the interactive Claude Code sessions in this tmux session',
    })
    void $.ui.open({ id: PANE, title: 'tmux' })
    void refresh($)
    // Keep the list live; a hot reload drops this timer with the module.
    $.clock.every(2000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'tmux' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'tmux' })

    return { text: 'tmux pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)

    if (!snap.inTmux) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Not in a tmux session.</Text>
        </Box>
      )
    }

    const { rows } = snap

    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text dimColor>Claude Code</Text>
        {rows.length === 0 && (
          <Text dimColor>No Claude Code sessions in this tmux session.</Text>
        )}
        {rows.map(row => (
          // One press anywhere on the row brings its window to the front.
          <Button
            key={row.id}
            plain
            onPress={() => void bringToFront($, row)}
          >
            <Text
              color={row.isActive ? 'claude' : undefined}
              weight={row.isActive ? 'bold' : undefined}
              dimColor={!row.isActive}
            >
              {row.isActive ? '▶ ' : '  '}
              {row.name}
            </Text>
          </Button>
        ))}
      </Box>
    )
  })
}
