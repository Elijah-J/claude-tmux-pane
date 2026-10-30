export type TmuxPane = {
  /** The tmux pane id, e.g. "%3". */
  id: string
  /** The tmux id of the window holding the pane, e.g. "@3". */
  windowId: string
  /** Display name: the pane title (its ✳ state glyph and session title), else the pane id; a Codex row gets the same ✳ in place of Codex's spinner. */
  name: string
  /** tmux's current foreground command for the pane; a Claude pane reports its version, a Codex pane `codex`. */
  command: string
  /** Which agent runs in the pane. */
  agent: Agent
  /** True for the pane the user is looking at now: active pane of the active window. */
  isActive: boolean
  /** The session's state, drawn after its name: from the pane's @claude_state mark, else (Claude Code only) its registry status. */
  state: SessionState
}

/** The agent a listed pane runs: Claude Code or Codex. */
export type Agent = 'claude' | 'codex'

/** `needs-you` while the pane is marked pending; `active` while marked active or its session is busy; else `idle`. */
export type SessionState = 'active' | 'needs-you' | 'idle'

export type TmuxSnapshot = {
  /** False when this session is not inside a tmux session (nothing to list). */
  inTmux: boolean
  /** The interactive Claude Code and Codex sessions, one per tmux pane running either. */
  rows: TmuxPane[]
}

/** Each agent's [new] row: its spinner frame while it starts a session; null when idle. */
export type Launching = Record<Agent, number | null>

declare module 'claude-code' {
  interface PluginState {
    tmux: {
      snapshot: Shaped<TmuxSnapshot>
      /** Each [new] row's spinner frame while it starts a session; null when idle. */
      launching: Shaped<Launching>
      /** The pane whose [x] was pressed once and asks [close?]; null when none. */
      closing: string | null
      /** The row whose press last left this session, kept dim under the pointer until the next press here; null when none. */
      leftFrom: string | null
    }
  }
}
