import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Launching, SessionState, TmuxPane, TmuxSnapshot } from '../types'

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
  { shape: 'tmux-4' },
)

// Claude Code's session registry: one file per running session, naming the
// tmux pane it runs in ("<session>:<window_id>.<pane_id>") and its status,
// "busy" while it works and "waiting" while a permission prompt waits on the
// person (measured 2026-10-29).
const SESSIONS_DIR = '.claude/sessions'

type Registered = { pid: number; status: string; startedAt: number }

function parseEntry(text: string): (Registered & { paneId: string }) | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { pid, kind, tmux, status, startedAt } = value as Record<string, unknown>
  // A headless run started from a pane names that pane too.
  if (kind !== 'interactive' || typeof tmux !== 'string') return null
  const paneId = tmux.slice(tmux.lastIndexOf('.') + 1)
  if (!paneId.startsWith('%')) return null

  return {
    paneId,
    pid: typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0,
    status: typeof status === 'string' ? status : '',
    startedAt: typeof startedAt === 'number' ? startedAt : 0,
  }
}

// Claude Code's process names itself `claude`, or reads as its version where
// the binary runs under its own name; `ps` gives the name or the full path.
const CLAUDE_PROCESS = /^(claude|\d+\.\d+\.\d+.*)$/

// Of `pids`, those still running as Claude Code. `ps -p` lists each live pid
// asked about, skips a dead one, and exits 1 when none is left (measured
// 2026-10-31); a pid a stale entry names may since belong to another program.
async function liveClaude($: EngineInterface, pids: number[]): Promise<Set<number>> {
  const live = new Set<number>()
  if (pids.length === 0) return live
  let result
  try {
    result = await $.process.run(['ps', '-o', 'pid=,comm=', '-p', pids.join(',')])
  } catch {
    return live
  }
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const name = (match[2] ?? '').slice((match[2] ?? '').lastIndexOf('/') + 1)
    if (CLAUDE_PROCESS.test(name)) live.add(Number(match[1]))
  }

  return live
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

// Each [new] row's spinner frame while it starts a session; null when idle.
// The tag declines the single frame an earlier version stored.
const launching = atom(
  { plugin: 'tmux', key: 'launching' } as const,
  { claude: null, codex: null } as Launching,
  { shape: 'launching-2' },
)

// The pane whose [x] was pressed once and now asks [close?]; null when none.
const closing = atom(
  { plugin: 'tmux', key: 'closing' } as const,
  null as string | null,
)

// The row this session was left from: a press on it brought another session
// forward, and the pointer this session keeps rests there until the person
// moves it here again, which no hook sees. The row does not brighten on hover
// until the next press in this pane, so coming back finds no lit name where
// the pointer only was (measured 2026-10-30); null when none.
const leftFrom = atom(
  { plugin: 'tmux', key: 'leftFrom' } as const,
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
// non-Claude windows and panes. Under `claude-codex run` the command stays
// `claude-codex`, and only the ✳ title tells an interactive Claude Code from a
// headless one, whose pane keeps the shell's title (measured 2026-10-31).
const isClaude = (command: string, title: string) =>
  /^\d+\.\d+\.\d+/.test(command.trim()) ||
  (command.trim() === 'claude-codex' && title.startsWith('✳'))

// A tmux pane running the Codex CLI reports `codex` (measured 2026-10-30).
function agentOf(command: string, title: string): Agent | null {
  if (isClaude(command, title)) return 'claude'
  if (command.trim() === 'codex') return 'codex'

  return null
}

// The facing row's name: Claude Code's own color, or Codex's accent, ChatGPT
// Blue 200 (`UI_ACCENT` in codex-rs/tui/src/style.rs, Codex 0.165.0).
const HIGHLIGHT: Record<Agent, string> = { claude: 'claude', codex: '#63A8F8' }

// Codex opens its title with one of these frames while it works
// (TERMINAL_TITLE_SPINNER_FRAMES in codex-rs/tui/src/chatwidget/status_surfaces.rs,
// Codex 0.165.0); the row's state already says so.
const CODEX_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /

// A Claude Code pane's title opens with Claude's ✳; a Codex row gets the same
// bullet in place of Codex's spinner.
function nameOf(agent: Agent, title: string): string {
  return agent === 'codex' ? `✳ ${title.replace(CODEX_SPINNER, '')}` : title
}

const AGENT_NAME: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' }

// When the session [new] started is ready to show: Claude Code titles its pane
// with ✳ once it waits for input; Codex draws on the alternate screen at once
// but writes its own title only when its session is up, 4 to 20 s in (measured
// 2026-10-30), so its screen is the sign.
const isReady: Record<Agent, (command: string, title: string, isAlternate: boolean) => boolean> = {
  claude: (command, title) => isClaude(command, title) && title.startsWith('✳'),
  codex: (command, title, isAlternate) => agentOf(command, title) === 'codex' && isAlternate,
}

async function probe($: EngineInterface): Promise<TmuxSnapshot> {
  // Outside tmux a running server still answers, for its most recently used
  // session (tmux(1), target-session), so only TMUX_PANE says this session is
  // in tmux, and its pane names the session to list.
  const pane = await $.env.get('TMUX_PANE')
  if (!pane) return { inTmux: false, rows: [] }
  let result
  try {
    // -s lists every pane in that pane's session (all its windows).
    result = await $.process.run(['tmux', 'list-panes', '-s', '-t', pane, '-F', FORMAT])
  } catch {
    return { inTmux: false, rows: [] }
  }
  if (result.exitCode !== 0) return { inTmux: false, rows: [] }

  const all = result.stdout
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
      const title = (rest.join(SEP) || id).trim()
      const agent = agentOf(command, title)
      return {
        id,
        windowId,
        title,
        name: agent === null ? title : nameOf(agent, title),
        command,
        agent,
        mark: mark.trim(),
        // The user faces the active pane of the active window.
        isActive: windowActive === '1' && paneActive === '1',
      }
    })
  const sessions = await registry($)
  // A Claude Code that a launcher script runs as its child leaves the script's
  // shell as the pane's command (measured 2026-10-31: `sh launch.sh` running
  // claude-codex reads `bash`). Its registry entry names the pane, and a live
  // Claude Code process under that entry's pid confirms it.
  const wrapped = all.filter(pane => pane.agent === null && (sessions.get(pane.id)?.pid ?? 0) > 0)
  const live = await liveClaude($, wrapped.map(pane => sessions.get(pane.id)?.pid ?? 0))
  const panes = all
    .map(pane =>
      pane.agent === null && live.has(sessions.get(pane.id)?.pid ?? 0)
        ? { ...pane, agent: 'claude' as const, name: pane.title }
        : pane,
    )
    .flatMap(({ agent, title: _title, ...pane }) => (agent === null ? [] : [{ ...pane, agent }]))
  // The registry is Claude Code's: a Codex pane reads by its mark alone, so a
  // stale Claude entry left in its pane cannot mark it.
  const rows: TmuxPane[] = panes.map(({ mark, ...pane }) => ({
    ...pane,
    state: stateOf(mark, pane.agent === 'claude' ? sessions.get(pane.id)?.status : undefined),
  }))

  return { inTmux: true, rows }
}

async function refresh($: EngineInterface): Promise<void> {
  const snap = await probe($)
  await update($, snapshot, () => snap)
}

// The command that draws this list in a pane beside a Codex window, which has
// no mods to draw it; empty, Codex windows get none.
let rosterCommand = ''

// Give a Codex window a pane running rosterCommand beside its Codex pane, as wide
// as this pane's dock, unless a pane of it carries @claude_roster 1. The new pane
// is marked at once, so a second press cannot add another.
async function ensureRoster($: EngineInterface, row: Pick<TmuxPane, 'id' | 'windowId'>): Promise<void> {
  const marks = await $.process.run(['tmux', 'list-panes', '-t', row.windowId, '-F', '#{@claude_roster}'])
  if (marks.exitCode !== 0 || marks.stdout.split('\n').some(mark => mark.trim() === '1')) return
  const split = await $.process.run([
    'tmux',
    'split-window',
    '-h',
    '-d',
    '-l',
    '32%',
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    row.id,
    rosterCommand,
  ])
  if (split.exitCode !== 0) return
  await $.process.run(['tmux', 'set-option', '-p', '-t', split.stdout.trim(), '@claude_roster', '1'])
}

// Bring a row's pane to the front: make it the active pane of its window, then
// make that window the current one. Pane and window IDs are unique for the life
// of the tmux server, so neither target can hit the wrong pane or window.
async function bringToFront(
  $: EngineInterface,
  row: Pick<TmuxPane, 'id' | 'windowId' | 'agent'>,
): Promise<void> {
  if (row.agent === 'codex' && rosterCommand !== '') await ensureRoster($, row)
  await $.process.run(['tmux', 'select-pane', '-t', row.id])
  await $.process.run(['tmux', 'select-window', '-t', row.windowId])
  // Every session re-probes, this one included. A pane closed since the last
  // probe fails both selects, and the probe drops it.
  await $.process.run(['tmux', 'wait-for', '-S', CHANNEL])
}

// A press on a row leaves this session from it, then brings that row forward.
async function pressRow($: EngineInterface, row: TmuxPane): Promise<void> {
  await update($, leftFrom, () => row.id)
  await bringToFront($, row)
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
  await update($, leftFrom, () => null)
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

// Open a new window in this tmux session, start Claude Code or Codex in it, and
// bring it to the front once the new session waits for input.
async function startSession($: EngineInterface, agent: Agent, command: string): Promise<void> {
  await update($, leftFrom, () => null)
  const spin = (frame: number | null) => update($, launching, l => ({ ...l, [agent]: frame }))
  await spin(0)
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
    const [windowId = '', id = ''] = created.stdout.replace(/\n$/, '').split(SEP)
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
        `#{pane_current_command}${SEP}#{pane_title}${SEP}#{alternate_on}`,
      ])
      // The window was closed while starting.
      if (shown.exitCode !== 0) return
      const [current = '', title = '', alternate = ''] = shown.stdout.replace(/\n$/, '').split(SEP)
      if (isReady[agent](current, title, alternate === '1')) break
      await $.clock.sleep(TICK_MS)
      await spin(tick)
    }
    await bringToFront($, { id, windowId, agent })
  } finally {
    await spin(null)
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
  const newCommand: Record<Agent, string> = {
    claude: String(options.new_session_command),
    codex: String(options.new_codex_command),
  }
  rosterCommand = String(options.codex_roster_command ?? '').trim()

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'tmux',
      description: 'Show the interactive Claude Code and Codex sessions in this tmux session',
    })
    // A start a reload cut short leaves its frame behind, and an ask its [close?].
    await update($, launching, () => ({ claude: null, codex: null }))
    await update($, closing, () => null)
    await update($, leftFrom, () => null)
    void $.ui.open({ id: PANE, title: 'tmux' })
    void refresh($)
    void watchClicks($)
    // Every other session re-probes now and lists this one, not on its next poll.
    void $.process.run(['tmux', 'wait-for', '-S', CHANNEL]).catch(() => {})
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

    const claudeRows = snap.rows.filter(row => row.agent === 'claude')
    const codexRows = snap.rows.filter(row => row.agent === 'codex')
    const frames = await read($, launching)
    const asking = await read($, closing)
    const left = await read($, leftFrom)

    const drawRow = (row: TmuxPane) => (
      <Box key={`row:${row.id}`}>
        {/* One press anywhere on the row brings its window to the front. A
            session left behind keeps the pointer where the click was, and a
            Button inverts under the pointer, so on coming back the row
            clicked there would be a bar: the row never inverts (measured
            2026-10-30), and only the facing row's name is colored. Another
            session's name brightens from dim while the pointer is on its row. */}
        <Button
          key={row.id}
          plain
          hover={{ inverse: false }}
          onPress={() => void pressRow($, row)}
        >
          <Text
            color={row.isActive ? HIGHLIGHT[row.agent] : undefined}
            weight={row.isActive ? 'bold' : undefined}
            dimColor={!row.isActive}
            hover={row.isActive || row.id === left ? undefined : { dimColor: false }}
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
            hover={{ inverse: false }}
            onPress={() => void pressClose($, row)}
          >
            {asking === row.id ? (
              <Text color="error" weight="bold">[close?]</Text>
            ) : (
              <Text dimColor hover={{ dimColor: false }}>[x]</Text>
            )}
          </Button>
        </Box>
      </Box>
    )

    // Each agent's [new] ends its list. It switches windows too, so it never
    // inverts under the pointer, as the rows do; it brightens from dim, as a
    // name does. Its keyed Box scopes the hover.
    const drawNew = (agent: Agent) => {
      const frame = frames[agent]
      return frame === null ? (
        <Box key={`new-row:${agent}`} marginLeft={2}>
          <Button
            key={agent === 'claude' ? 'new' : 'new-codex'}
            plain
            hover={{ inverse: false }}
            onPress={() => void startSession($, agent, newCommand[agent])}
          >
            <Text dimColor hover={{ dimColor: false }}>[new]</Text>
          </Button>
        </Box>
      ) : (
        <Text dimColor>
          {'  '}
          {FRAMES[frame % FRAMES.length]} starting {AGENT_NAME[agent]}…
        </Text>
      )
    }

    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text dimColor>Claude Code</Text>
        {claudeRows.length === 0 && (
          <Text dimColor>No Claude Code sessions in this tmux session.</Text>
        )}
        {claudeRows.map(drawRow)}
        {drawNew('claude')}
        {/* Drawn with no Codex session too, so its [new] can start one. */}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Codex</Text>
          {codexRows.map(drawRow)}
          {drawNew('codex')}
        </Box>
      </Box>
    )
  })
}
