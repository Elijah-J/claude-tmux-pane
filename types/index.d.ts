export type TmuxPane = {
  /** The tmux pane id, e.g. "%3". */
  id: string
  /** The tmux id of the window holding the pane, e.g. "@3". */
  windowId: string
  /** Display name: the pane title (its ✳ state glyph and session title), else the pane id. */
  name: string
  /** tmux's current foreground command for the pane; a Claude pane reports its version. */
  command: string
  /** True for the pane the user is looking at now: active pane of the active window. */
  isActive: boolean
  /** The session's state, drawn after its name: from the pane's @claude_state mark, else its registry status. */
  state: SessionState
}

/** `needs-you` while the pane is marked pending; `active` while marked active or its session is busy; else `idle`. */
export type SessionState = 'active' | 'needs-you' | 'idle'

export type TmuxSnapshot = {
  /** False when this session is not inside a tmux session (nothing to list). */
  inTmux: boolean
  /** The interactive Claude Code sessions, one per tmux pane running Claude. */
  rows: TmuxPane[]
}

declare module 'claude-code' {
  interface PluginState {
    tmux: {
      snapshot: Shaped<TmuxSnapshot>
      /** The [new] row's spinner frame while it starts a session; null when idle. */
      launching: number | null
    }
  }
}
