import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SessionState, TmuxPane, TmuxSnapshot } from '../types'

const PANE = 'tmux-sessions'

// A click signals this tmux channel and every session's mod waits on it, so the
// session coming to the front redraws its highlight at once, not on its next
// poll. `tmux wait-for -S` wakes every waiter, and a signal sent while nobody
// waits is kept for the next wait alone.
const CHANNEL = 'claude-tmux-pane'

// Field separator for tmux -F output: the ASCII unit separator never appears in
// a pane title or command, so splitting on it is collision-proof.
const SEP = '\x1f'
const FORMAT = [
  '#{window_active}',
  '#{pane_active}',
  '#{window_id}',
  '#{pane_id}',
  '#{pane_current_command}',
  // A session marks its own pane with this user option: `pending` while it
  // waits on the person, `active` or `idle` otherwise; unset it reads empty.
  '#{@claude_state}',
  '#{pane_title}',
].join(SEP)

// Change the tag when a stored field changes: the engine then declines what an
// earlier version wrote, which outlives a reload.
const snapshot = atom(
  { plugin: 'tmux', key: 'snapshot' } as const,
  { inTmux: true, rows: [] } as TmuxSnapshot,
  { shape: 'tmux-3' },
)

// Claude Code's session registry: one file per running session, naming the
// tmux pane it runs in ("<session>:<window_id>.<pane_id>") and its status,
// "busy" while it works and "waiting" while a permission prompt waits on the
// person (measured 2026-10-29).
const SESSIONS_DIR = '.claude/sessions'

type Registered = { status: string; startedAt: number }

function parseEntry(text: string): (Registered & { paneId: string }) | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { kind, tmux, status, startedAt } = value as Record<string, unknown>
  // A headless run started from a pane names that pane too.
  if (kind !== 'interactive' || typeof tmux !== 'string') return null
  const paneId = tmux.slice(tmux.lastIndexOf('.') + 1)
  if (!paneId.startsWith('%')) return null

  return {
    paneId,
    status: typeof status === 'string' ? status : '',
    startedAt: typeof startedAt === 'number' ? startedAt : 0,
  }
}

// Each pane's session: a crashed session's file can outlive it, so the newest
// one started in the pane is the one running there. A file that can't be read
// (its session exited after the listing) is skipped; an unreadable registry is
// an empty one.
async function registry($: EngineInterface): Promise<Map<string, Registered>> {
  const byPane = new Map<string, Registered>()
  try {
    const home = await $.env.get('HOME')
    if (!home) return byPane
    const dir = `${home}/${SESSIONS_DIR}`
    for (const file of await $.fs.list(dir)) {
      if (file.kind !== 'file' || !file.name.endsWith('.json')) continue
      const entry = parseEntry(await $.fs.read(`${dir}/${file.name}`).catch(() => ''))
      if (entry === null) continue
      const last = byPane.get(entry.paneId)
      if (last === undefined || entry.startedAt > last.startedAt) byPane.set(entry.paneId, entry)
    }
  } catch {
    // no registry: every session reads by its mark alone
  }

  return byPane
}

// Needs you while the pane is marked pending or its session is waiting; active
// while it is marked active or its session is busy; idle otherwise.
function stateOf(mark: string, status: string | undefined): SessionState {
  if (mark === 'pending' || status === 'waiting') return 'needs-you'
  if (mark === 'active' || status === 'busy') return 'active'

  return 'idle'
}

// The suffix after each name: green while it works, bold yellow while it waits
// on the person, white when idle. It keeps its color on dimmed rows.
const SUFFIX: Record<SessionState, { text: string; color: 'green' | 'yellow' | 'white'; weight?: 'bold' }> = {
  active: { text: ' -- Active', color: 'green' },
  'needs-you': { text: ' -- Needs you', color: 'yellow', weight: 'bold' },
  idle: { text: ' -- Idle', color: 'white' },
}

// The spinner frame of the [new] row while it starts a session; null when idle.
const launching = atom(
  { plugin: 'tmux', key: 'launching' } as const,
  null as number | null,
)

// The pane whose [x] was pressed once and now asks [close?]; null when none.
const closing = atom(
  { plugin: 'tmux', key: 'closing' } as const,
  null as string | null,
)

// How long a pressed [x] waits for the second press before it turns back.
const CONFIRM_MS = 3000
// Each first press counts; a wait ends its ask only if no later press re-asked.
let asks = 0

// Claude Code's own spinner frames, turned once per readiness check.
const FRAMES = ['◐', '◓', '◑', '◒']
const TICK_MS = 150
// Switch even to a session that never reads as ready, so its window shows why.
const READY_TIMEOUT_MS = 20_000

// The session's working directory, where [new] starts its session.
let cwd: string | undefined

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

  const panes = result.stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const [
        windowActive,
        paneActive,
        windowId = '',
        id = '',
        command = '',
        mark = '',
        ...rest
      ] = line.split(SEP)
      const name = (rest.join(SEP) || id).trim()
      return {
        id,
        windowId,
        name,
        command,
        mark: mark.trim(),
        // The user faces the active pane of the active window.
        isActive: windowActive === '1' && paneActive === '1',
      }
    })
    .filter(pane => isClaude(pane.command))
  const sessions = panes.length === 0 ? new Map<string, Registered>() : await registry($)
  const rows: TmuxPane[] = panes.map(({ mark, ...pane }) => ({
    ...pane,
    state: stateOf(mark, sessions.get(pane.id)?.status),
  }))

  return { inTmux: true, rows }
}

async function refresh($: EngineInterface): Promise<void> {
  const snap = await probe($)
  await update($, snapshot, () => snap)
}

// Bring a row's pane to the front: make it the active pane of its window, then
// make that window the current one. Pane and window IDs are unique for the life
// of the tmux server, so neither target can hit the wrong pane or window.
async function bringToFront(
  $: EngineInterface,
  row: Pick<TmuxPane, 'id' | 'windowId'>,
): Promise<void> {
  await $.process.run(['tmux', 'select-pane', '-t', row.id])
  await $.process.run(['tmux', 'select-window', '-t', row.windowId])
  // Every session re-probes, this one included. A pane closed since the last
  // probe fails both selects, and the probe drops it.
  await $.process.run(['tmux', 'wait-for', '-S', CHANNEL])
}

// Close a row's session by killing its pane, which ends the Claude Code running
// there, and its window too where it was the window's only pane. Like a select,
// a kill of a pane closed since the last probe fails rather than hitting another.
async function closeSession($: EngineInterface, row: Pick<TmuxPane, 'id'>): Promise<void> {
  await $.process.run(['tmux', 'kill-pane', '-t', row.id])
  // Every session drops the row at once; one that closed itself is gone, and
  // the others catch it on their next poll.
  await $.process.run(['tmux', 'wait-for', '-S', CHANNEL])
}

// The first press on a row's [x] asks [close?]; a second press within
// CONFIRM_MS closes the session. Asking on another row moves the ask there.
async function pressClose($: EngineInterface, row: Pick<TmuxPane, 'id'>): Promise<void> {
  let isConfirmed = false
  await update($, closing, id => {
    isConfirmed = id === row.id
    return isConfirmed ? null : row.id
  })
  if (isConfirmed) {
    await closeSession($, row)
    return
  }

  const ask = ++asks
  try {
    await $.clock.sleep(CONFIRM_MS)
  } catch {
    // The module unloaded mid-wait; the next session.start clears the ask.
    return
  }
  if (ask === asks) await update($, closing, id => (id === row.id ? null : id))
}

// Open a new window in this tmux session, start Claude Code in it, and bring it
// to the front once the new session waits for input.
async function startSession($: EngineInterface, command: string): Promise<void> {
  await update($, launching, () => 0)
  try {
    // Given no command, tmux runs a login shell in the new window, as the
    // sessions here run in; -d keeps this window in front while the row spins.
    const created = await $.process.run([
      'tmux',
      'new-window',
      '-d',
      '-P',
      '-F',
      `#{window_id}${SEP}#{pane_id}`,
      ...(cwd ? ['-c', cwd] : []),
    ])
    if (created.exitCode !== 0) return
    const [windowId = '', id = ''] = created.stdout.trim().split(SEP)
    // Typed into that shell, the command runs as if typed by hand.
    await $.process.run(['tmux', 'send-keys', '-t', id, '-l', command])
    await $.process.run(['tmux', 'send-keys', '-t', id, 'Enter'])

    for (let tick = 1; tick * TICK_MS <= READY_TIMEOUT_MS; tick++) {
      const shown = await $.process.run([
        'tmux',
        'display',
        '-p',
        '-t',
        id,
        `#{pane_current_command}${SEP}#{pane_title}`,
      ])
      // The window was closed while starting.
      if (shown.exitCode !== 0) return
      const [current = '', title = ''] = shown.stdout.trim().split(SEP)
      // Claude Code titles its pane with ✳ once it waits for input.
      if (isClaude(current) && title.startsWith('✳')) break
      await $.clock.sleep(TICK_MS)
      await update($, launching, () => tick)
    }
    await bringToFront($, { id, windowId })
  } finally {
    await update($, launching, () => null)
  }
}

// Re-probe each time the channel is signalled, for the session's life. The
// module unloading kills the waiting child, which ends the loop.
async function watchClicks($: EngineInterface): Promise<void> {
  for (;;) {
    const wait = $.process.spawn({ argv: ['tmux', 'wait-for', CHANNEL] })
    try {
      // tmux wait-for prints nothing; the loop ends when it exits.
      for await (const _ of wait);
    } catch {
      return
    }
    const { code } = await wait.result
    if (code !== 0) return
    await refresh($)
  }
}

export const register: Register = (on, options) => {
  const newSessionCommand = String(options.new_session_command)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'tmux',
      description: 'Show the interactive Claude Code sessions in this tmux session',
    })
    // A start a reload cut short leaves its frame behind, and an ask its [close?].
    await update($, launching, () => null)
    await update($, closing, () => null)
    void $.ui.open({ id: PANE, title: 'tmux' })
    void refresh($)
    void watchClicks($)
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
    const frame = await read($, launching)
    const asking = await read($, closing)

    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text dimColor>Claude Code</Text>
        {rows.length === 0 && (
          <Text dimColor>No Claude Code sessions in this tmux session.</Text>
        )}
        {rows.map(row => (
          <Box key={`row:${row.id}`}>
            {/* One press anywhere on the row brings its window to the front. */}
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
              <Text
                color={SUFFIX[row.state].color}
                weight={SUFFIX[row.state].weight}
                dimColor={false}
              >
                {SUFFIX[row.state].text}
              </Text>
            </Button>
            <Box marginLeft={1}>
              <Button
                key={`close:${row.id}`}
                plain
                onPress={() => void pressClose($, row)}
              >
                {asking === row.id ? (
                  <Text color="error" weight="bold">[close?]</Text>
                ) : (
                  <Text dimColor>[x]</Text>
                )}
              </Button>
            </Box>
          </Box>
        ))}
        {frame === null ? (
          <Box marginLeft={2}>
            <Button
              key="new"
              label="[new]"
              plain
              dimColor
              onPress={() => void startSession($, newSessionCommand)}
            />
          </Box>
        ) : (
          <Text dimColor>
            {'  '}
            {FRAMES[frame % FRAMES.length]} starting Claude Code…
          </Text>
        )}
      </Box>
    )
  })
}
