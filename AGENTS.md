# AGENTS.md

## Project Purpose

This repository contains an opencode plugin named `opencode-wakeup`.

Its purpose is to wake an existing opencode session at a scheduled time by sending a new prompt back into that same session.

The plugin has two parts:

- A server plugin loaded by opencode from `opencode.json`
- A TUI plugin loaded by opencode from `tui.json`

Both are required for the full experience.

## User-Facing Behavior

The plugin exposes four tools:

- `wakeup_after`
- `wakeup_at`
- `wakeup_list`
- `wakeup_cancel`

### `wakeup_after`

Arguments:

- `seconds: number`
- `message?: string`

Behavior:

- Schedules a wakeup relative to now
- Returns JSON containing at least `status` and `id`

### `wakeup_at`

Arguments:

- `datetime: string`
- `message?: string`

Behavior:

- Schedules a wakeup for a specific future date/time
- Prefer ISO 8601 input
- A bare ISO date (`YYYY-MM-DD`) is interpreted as local midnight, not UTC midnight
- Returns JSON containing at least `status` and `id`

### `wakeup_list`

Arguments:

- `allSessions?: boolean`

Behavior:

- Lists currently scheduled wakeups
- By default only lists wakeups for the current session
- When `allSessions` is true, lists scheduled wakeups across all sessions this instance currently knows about (in memory)
- Returns JSON with `count` and a `wakeups` array

### `wakeup_cancel`

Arguments:

- `id: string`

Behavior:

- Cancels a previously scheduled wakeup if it is still pending

## Core Technical Decisions

### Runtime model: separate server and TUI runtimes

The server plugin and the TUI plugin do not share in-memory state. They run in
separate runtimes, so the in-memory store on the server side is not visible to
the TUI.

To bridge them, the server persists wakeups to disk and the TUI polls those
files. There is no database; the only runtime state files are the per-session
JSON files described below.

### Shared singleton store (per runtime)

Runtime state lives in `src/store.ts`.

The store is attached to `globalThis` under a stable key so imports from
different entrypoints within the same runtime reuse the same in-memory
instance. In practice only the server side schedules and arms timers; the TUI
reads from the shared files instead of from this store.

### Per-session persistence (multi-instance safe)

State is persisted to one JSON file per session, not per worktree.

- The path is derived from the session id via `wakeupStatePath(sessionID)` (a
  hash of the session id under `os.tmpdir()`).
- Each session is owned by exactly one opencode instance, so each instance
  fully owns its session files. No cross-instance merge logic is needed.
- Multiple concurrent opencode instances can run side by side without reading
  or writing each other's wakeups, which prevents lost entries and duplicate
  firing.

The TUI reads the active session's file via `wakeupStatePath(sessionID)` and
shows only that session's scheduled wakeups.

### Rehydration after restart

Scheduled wakeups survive an opencode restart.

- `enablePersistence(pathForSession, onFire)` only registers the path resolver
  and fire handler; it does not rehydrate at init because the server does not
  yet know which sessions it owns.
- `rehydrate(sessionID)` reads that session's file and re-arms scheduled,
  future wakeups for that session. It is idempotent (guarded by id) and safe to
  call repeatedly.
- The server triggers rehydration the first time it observes a session: from
  the `event` hook (any event carrying `properties.sessionID`) and at the start
  of each tool execution. A `Set` guards against rehydrating the same session
  twice.
- Wakeups whose target time is already past the orphan grace window
  (`ORPHAN_GRACE_MS`, 60s) are dropped as stale instead of being re-armed.

### Terminal entry GC

Terminal wakeups (`triggered`, `failed`, `cancelled`) are pruned from memory
after `TERMINAL_RETENTION_MS` (10 minutes), tracked via a `settledAt`
timestamp, so the in-memory map cannot grow without bound during long sessions.

### Wakeup IDs

IDs are generated with `crypto.randomUUID()` (`wakeup_<uuid>`) so concurrent
instances can never mint colliding ids.

### Long timers

JavaScript timers cannot reliably wait longer than `2_147_483_647` ms in a single `setTimeout`.

To support longer future dates, `src/store.ts` rearms timeouts in chunks until the final target time is reached.

Do not replace this with a single `setTimeout(runAt - Date.now())` unless you also reintroduce a hard scheduling limit.

### Wakeup mechanism

When a wakeup fires, the plugin uses:

- `client.session.prompt({ path: { id }, body: { parts: [...] } })`

It does not use `noReply: true`.

Reason:

- The goal is to actually wake the session and continue it
- `noReply: true` would only inject context without triggering the model

## File Map

### `src/index.ts`

Server plugin module export.

- Exports `default` with `{ id, server }`
- Re-exports the server plugin symbol

### `src/plugin.ts`

Server plugin implementation.

Contains:

- Tool registration (`wakeup_after`, `wakeup_at`, `wakeup_list`, `wakeup_cancel`)
- Input validation for schedule arguments (including local-midnight handling
  for bare ISO dates)
- Wakeup prompt construction
- Per-session persistence wiring (`enablePersistence`)
- Session rehydration via the `event` hook and at tool-execution time
- Logging hooks
- Store cleanup on plugin dispose

### `src/store.ts`

Central scheduling store plus per-session persistence helpers.

Contains:

- Wakeup type definitions
- Timer lifecycle management (chunked long timers)
- Cancellation
- Status tracking and terminal-entry GC
- Per-session persistence (`persist`, `wakeupStatePath`, `readScheduledWakeups`)
- Rehydration (`rehydrate`)
- Listener subscription API for TUI refreshes

Wakeup statuses currently used:

- `scheduled`
- `triggering`
- `triggered`
- `cancelled`
- `failed`

### `src/tui.tsx`

TUI plugin implementation.

Registers a sidebar section using the `sidebar_content` slot.

Current behavior:

- Shows `Wakeups` in the session sidebar
- Filters to scheduled wakeups for the active session only
- Reads the active session's state file via `wakeupStatePath(sessionID)`
- Displays countdown, target time, short ID, and truncated message
- Polls the shared state file on a 1-second interval tick

### `scripts/prepare-tui-dist.mjs`

Build helper for TUI packaging.

Important detail:

- The package ships `dist/tui.tsx`, not only transpiled JS
- This follows the pattern used by `opencode-quota`
- The OpenTUI/Bun runtime is expected to load TSX with the proper preload/transform support

## Packaging Decisions

### Package format

The package is configured in `package.json` with:

- `type: module`
- `oc-plugin: ["server", "tui"]`
- exports for `.` / `./server` / `./tui`

### TUI export

The TUI export points to:

- `./dist/tui.tsx`

This is intentional.

Directly importing the TUI module with plain Bun can fail unless preload support is enabled:

- `@opentui/solid/preload`

That is normal and consistent with the OpenTUI runtime model.

## External Knowledge Used

### opencode plugin model

Used official docs and reference patterns for:

- server plugins from `@opencode-ai/plugin`
- custom tools with `tool(...)`
- TUI plugins from `@opencode-ai/plugin/tui`
- slot registration via `api.slots.register(...)`

### opencode-quota as TUI reference

This project used `@slkiser/opencode-quota` as the main practical reference for:

- package layout with both server and TUI plugin exports
- TUI packaging pattern using `dist/tui.tsx`
- sidebar slot registration

### OpenTUI Solid runtime detail

`@opentui/solid` relies on Bun runtime transform support for TSX.

Important detail discovered during validation:

- TUI import works when Bun is started with `--preload @opentui/solid/preload`

This matters if future debugging tries to run `dist/tui.tsx` directly outside the normal opencode host.

## Local Environment Assumptions

At implementation time:

- `opencode` version was `1.17.2`
- `bun` was available
- `pnpm` was not installed

Validation was done with Bun and TypeScript.

## Validation Commands

These commands were used successfully:

```sh
bun install
bun run typecheck
bun run build
npm pack --dry-run
```

Additional validation used during development:

```sh
node -e "import('./dist/index.js').then((m) => { if (!m.default?.server) process.exit(1) })"
bun --preload @opentui/solid/preload -e "import('./dist/tui.tsx').then((m) => { if (!m.default?.tui) process.exit(1) })"
```

## Installed opencode Configuration

During setup, the plugin was added to the global opencode config files:

- `~/.config/opencode/opencode.json`
- `~/.config/opencode/tui.json`

It was registered as the local package path pointing to the project directory.

If the package path changes, those configs must be updated.

## Editing Guidance

When modifying this project, prefer these constraints:

- Keep the store simple and in one file unless there is a real need to split it
- Preserve the per-session persistence model; do not move back to a single
  worktree-scoped file (it reintroduces cross-instance interference)
- Preserve idempotent rehydration; never re-arm a wakeup that is already known
- Preserve the `client.session.prompt(...)` wakeup behavior unless the requirement changes
- Preserve the TUI `sidebar_content` integration unless a different surface is explicitly requested
- Keep changes minimal; avoid adding infrastructure that is not required

## Common Follow-up Tasks

If asked to extend this plugin, likely directions are:

- show more metadata in the sidebar
- add home screen or prompt status surfaces
- improve schedule formatting or timezone handling
- add listing or inspection tools
- add optional recurring wakeups

If recurrence is ever added, do not bolt it onto the current one-shot timer flow without rethinking cancellation and status transitions first.
