# Context Pilot

A Claude Code mod that manages context for long agentic sessions. Set a context target, like 300k. When the conversation reaches it, Context Pilot has Claude write a checkpoint, runs `/clear`, then has Claude resume from that checkpoint. You don't have to stop and do it by hand.

It also draws a context bar under the prompt. The bar is measured against your target while Auto is on, and against the model's full window otherwise.

## How a cycle works

1. **Watch.** After each main-conversation turn, Context Pilot reads the session's context size from Claude Code. Watching costs no tokens, because it reads numbers Claude Code already tracks. Subagent turns don't count.
2. **Checkpoint.** At or over the target, it asks Claude to write a checkpoint file. Each checkpoint gets a unique marker so the mod can confirm the file was really written.
3. **Clear.** Once the file is confirmed, it runs `/clear`.
4. **Resume.** It asks the fresh conversation to read the checkpoint and carry on.

### Safety rules

- **Pressing Esc during the checkpoint turn:** nothing is cleared, and Auto turns off for the session.
- **Checkpoint file missing or stale:** nothing is cleared.
- **A message or agent report arrives during the checkpoint turn:** it skips the clear and checkpoints again after that turn, so the new information goes into the file.
- **Resume turn interrupted:** a toast names the checkpoint file, so you can resume by hand.
- **Two resumes in a row that end over the target:** Auto turns off. The target is too low for the work, so raise it.

## Where checkpoints go

Context Pilot works in any project, with no setup:

| Project | Checkpoint file | Committed? |
|---|---|---|
| Has `docs/CHECKPOINT.md` or `docs/STATUS.md` | `docs/CHECKPOINT.md` | Yes, if it's a git repo |
| Anything else | `.context-pilot/CHECKPOINT.md` (gitignored automatically) | No |

The checkpoint uses the same layout as a typical lead-agent checkpoint:
- the respawn table of running agents
- what just landed
- the next action
- what not to do

If your project has its own `resume` procedure (a `.claude/commands/*.md` file whose `resume` mode reads `docs/CHECKPOINT.md`), the resume follows it instead of the built-in steps.

### Handoff modes

- **full** (default) adds four sections:
  - the task, with the original request quoted
  - every instruction and correction you gave, quoted
  - the current state, with files as `path:line`
  - decisions made, including approaches rejected

  The next context can carry on without asking you anything.
- **lean** keeps only the in-flight table, what just landed, the next action and the do-not-do list. Use it when the project already keeps its state in files such as `docs/STATUS.md`.

## Usage

| Command | Does |
|---|---|
| `/ctx` | Shows the settings and opens the picker |
| `/ctx on` / `/ctx off` | Turns Auto on or off for this session |
| `/ctx 300k` | Sets the target (`k` and `m` suffixes, or a plain number) |

`/ctx` runs immediately, even while Claude is working. You don't have to wait for the turn to end.

### The picker

**In the terminal**, the picker opens under the prompt:

| Key | Does |
|---|---|
| `,` or `[` | Lowers the target |
| `.` or `]` | Raises the target |
| `;` | Turns Auto on or off |
| `'` | Switches the handoff between full and lean |
| Any other key | Closes the picker |

Changes save as you go. Close the picker with Space rather than Esc: while Claude is working, Esc interrupts the turn, and mods can't intercept it.

**In the desktop app**, `/ctx` shows clickable buttons for the target, Auto and the handoff mode.

### Settings scope

- **Auto on/off is per session.** It's off in every new session, and it stays on through `/clear` and `/reload-plugins` in a session where you turned it on. Turning it on in one project never triggers another.
- **The target and handoff mode are shared** across all sessions.
- If the target is at or above the model's context window, `/ctx` warns you that it can never be reached.

### The context bar

| Usage | Color |
|---|---|
| Below 75% | Green |
| 75–89% | Yellow |
| 90% and up | Red |

In the terminal, the bar sits under the prompt. In the desktop app, a compact version with a smooth bar appears in the footer. Both end with the session's total cost so far, the same figure `/usage` shows as Total cost:

```
context ━━━━━━━━━━━━──────── 62% · 186k / 300k target · $2.07
```

## Choosing a target

The check runs between turns, so one long turn can go past the target before the cycle starts. Leave room below the model's window for one big turn plus the checkpoint turn. For example, 300k on a 1M-context model, or about 150k on a 200k model.

## Install

Requires Claude Code 2.1.287 or later, where mods load by default.

```sh
claude plugin marketplace add Tost-1/ContextPilot
claude plugin install context-pilot@context-pilot-mod --scope user
```

Start a new session, then run `/ctx on`.

### Update

```sh
claude plugin update context-pilot@context-pilot-mod
```

Then start a new session. Don't run `/reload-plugins` while a cycle is in progress, because the mod forgets the cycle.

## Development

```sh
claude plugin test .
claude plugin validate .
```

The hooks are in `hooks/register.tsx`, and the tests are in `tests/context-pilot.test.tsx`.
