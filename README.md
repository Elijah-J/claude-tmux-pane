# tmux

A Claude Code mod that adds a pane listing the **interactive Claude Code sessions running in your current tmux session**, and highlights the one you're currently looking at.

When you're juggling several Claude Code sessions across tmux windows and panes, this gives you a live roster at a glance: which sessions are alive, what each is working on (from its pane title), and which one is facing you right now.

## What it shows

- One row per tmux pane that is running Claude Code, named by that session's title.
- The session **facing you** — the active pane of the active window — is bold, colored, and marked with `▶`. The rest are dimmed.
- Panes that aren't running Claude Code (plain shells, other programs) are left out.
- Click a row (or focus it and press Enter) to bring that session to the front: its tmux window becomes the current one and its pane the active pane.
- The list refreshes every couple of seconds, and in every session at once when you click a row, so the highlight is already right in the session you land on.
- `[new]` at the bottom opens a new tmux window, starts Claude Code in it, spins while it loads, and switches to it once it is ready for input.

A pane is detected as Claude Code by its tmux `pane_current_command`, which Claude Code reports as its version string (e.g. `2.1.312`); an ordinary shell reports `zsh`/`bash` and is ignored. Headless and subagent sessions aren't tmux panes, so they don't appear.

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

`[new]` types `claude` into the new window's shell, in the working directory of the session you clicked it from. To start sessions another way (with flags, say), set **New session command** in `/config`, or from a shell:

```
echo '{"new_session_command": "claude --model opus"}' | claude plugin configure tmux --values-stdin
```

## Requirements

- Claude Code running inside a `tmux` session (outside tmux the pane says so).
- `tmux` available on your `PATH`.
