# tmux

A Claude Code mod that adds a pane listing the **interactive Claude Code and Codex sessions running in your current tmux session**, and highlights the one you're currently looking at.

When you're juggling several Claude Code sessions across tmux windows and panes, this gives you a live roster at a glance: which sessions are alive, what each is working on (from its pane title), and which one is facing you right now.

## What it shows

- One row per tmux pane that is running Claude Code, named by that session's title, under a `Claude Code` header; below them, under a `Codex` header, one row per pane running the Codex CLI. A Codex row opens with the same `✳` bullet a Claude Code session's title does, in place of the spinner Codex puts in its title while it works.
- The session **facing you** — the active pane of the active window — is bold, colored, and marked with `▶`: in Claude Code's color for a Claude Code session, in Codex blue (`#63A8F8`, the accent of Codex's own TUI) for a Codex one. The rest are dimmed.
- Each row ends with the session's state: ` -- Active` in green while it works, ` -- Needs you` in bold yellow while it waits on you, ` -- Idle` in white otherwise. The state keeps its color on dimmed rows.
- Panes that run neither (plain shells, other programs) are left out.
- Click a row (or focus it and press Enter) to bring that session to the front: its tmux window becomes the current one and its pane the active pane.
- Click a row's `[x]` to close that session: it turns into `[close?]` for 3 seconds, and a second click kills the session's tmux pane (and its window, where that was the window's only pane). Without the second click it turns back to `[x]`.
- The list refreshes every couple of seconds, and in every session at once when you click a row, so the highlight is already right in the session you land on.
- Rows and `[new]` don't invert under the pointer. A session you leave keeps the pointer where you clicked, so an inverting row would come back as a bar on the row you last clicked there; instead the only highlight is the facing session's colored name.
- Each list ends with a `[new]`: it opens a new tmux window, starts Claude Code (or, under `Codex`, Codex) in it, spins while it loads, and switches to it once it is ready for input. Claude Code is ready once it titles its pane with `✳`, Codex once it writes its own title. The `Codex` list shows with its `[new]` even while no Codex session runs.

A pane is detected as Claude Code by its tmux `pane_current_command`, which Claude Code reports as its version string (e.g. `2.1.312`), and as Codex where it reports `codex`; an ordinary shell reports `zsh`/`bash` and is ignored. Headless and subagent sessions aren't tmux panes, so they don't appear.

## Session state

A Claude Code session's state comes from two places; a Codex session's from its pane's `@claude_state` option alone, since the registry is Claude Code's:

- **Claude Code's session registry,** `~/.claude/sessions/<pid>.json`. Each interactive session's file names its tmux pane (`"tmux": "<session>:<window_id>.<pane_id>"`) and its `status`. A `waiting` status, which Claude Code sets while a permission prompt waits on you, reads Needs you; a `busy` status reads Active; any other status reads Idle. Where a crash left a second file for the same pane, the newest `startedAt` counts. A file that can't be read (a session exiting mid-poll) is skipped, and an unreadable registry leaves every unmarked row Idle.
- **The pane's `@claude_state` user option,** which a session sets on its own pane. `pending` reads Needs you, and it wins over a busy status. `active` reads Active, unless the registry says `waiting`. Anything else, or no option at all, defers to the registry. A session marks its pane with:

  ```
  tmux set-option -p -t "$TMUX_PANE" @claude_state pending   # or active, idle
  tmux set-option -p -u -t "$TMUX_PANE" @claude_state        # clear it
  ```

  tmux passes each pane's ID to its processes as `TMUX_PANE`. This plugin only reads the option; your own setup sets it. Mark the pane `pending` just before handing the person a question. Your session's hooks can keep it current: `UserPromptSubmit` setting `active`, and `Stop` setting `idle` unless the turn just set `pending`. A pane left `active` reads Active even while its session is idle, which is how background work that outlives a turn shows.

  Set the option on the pane (`-p`). tmux reads an unset pane option from its window and then from the global options, so a window or global `@claude_state` marks every pane under it.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install tmux --marketplace Elijah-J/claude-tmux-pane
```

Press `y` to add the marketplace, then Enter to install at the user scope.

From a shell:

```
claude plugin install tmux --marketplace Elijah-J/claude-tmux-pane
```

## Use

The pane opens automatically when a session starts. Run `/tmux` any time to reopen it.

`[new]` types `claude` (under `Codex`, `codex`) into the new window's shell, in the working directory of the session you clicked it from. To start sessions another way (with flags, say), set **New session command** or **New Codex session command** in `/config`, or from a shell:

```
echo '{"new_session_command": "claude --model opus", "new_codex_command": "codex"}' | claude plugin configure tmux@claude-tmux-pane --values-stdin
```

## Requirements

- Claude Code running inside a `tmux` session (outside tmux the pane says so).
- `tmux` available on your `PATH`.
