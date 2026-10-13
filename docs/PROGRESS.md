# Progress

Milestones from [SPEC.md](SPEC.md). Each one is verified on emulator-5554 against `test/server` before the next starts.

## M1: connect, pin before auth, list sessions (2026-10-13)

See [SPIKE.md](SPIKE.md) and the README. Screenshots `01`–`08`.

## M2: live updates and pane output with scrollback (2026-10-13)

- `src/live/LiveSession.ts` opens one subscription connection (`events.subscribe`) for all tree lifecycle events
  plus `pane.agent_status_changed` per pane. Events only invalidate the cache: a debounced, serialised
  `session.snapshot` read on a separate request connection refreshes the tree, as Herdr's docs prescribe.
  When the pane set changes, it re-subscribes; the new subscription is open before the old one closes.
  On `events_lost` or a channel close it reconnects with exponential backoff (1 s up to 15 s). If the SSH session
  itself is gone, the session shows *offline* with a Reconnect button that redoes the pinned connect.
- `src/live/PaneReader.ts`: Herdr has no output-stream event, so the pane view polls
  `pane.read {source: recent, format: ansi}` every second while it is on screen. Polls never overlap, and unchanged
  text doesn't re-render. Scrollback starts at 300 lines and grows ×4 per "Load more" up to 10 000.
- `src/live/ansi.ts`: SGR colours (16/256/truecolor, bold/dim/italic/underline/inverse). Other escapes
  are stripped.
- `expo lint` is configured (eslint-config-expo) and clean.

Emulator evidence (screenshots `m2-*`):
1. With the sessions screen open, `herdr workspace create --label api` and `herdr tab create --label logs` run on
   the server. The tree updates without any user action (`m2-01`).
2. `seq 1 1500` in w1:p1, with colours (`m2-02`). A `live-tick-1..3` loop appears while the pane is open.
3. Scrolled to the top: "Load more scrollback (showing last 300 lines)", line 1207 (`m2-03`). After Load more:
   "last 1200 lines", line 507 (`m2-04`).
4. `docker restart herdr-test` shows *offline · connection lost* with Reconnect (`m2-05`). Reconnect brings it back to *● live*.

Tests: `liveSession.test.ts` (subscribe shape, burst coalescing, resubscribe on pane change, agent events,
events_lost backoff, offline), `paneReader.test.ts`, `ansi.test.ts`, `agents.test.ts`.

Open: polling costs one `pane.read` per second per open pane, and only while the pane view is visible.
Long lines wrap; there's no horizontal terminal emulation.

## M3: input and tab/pane/workspace actions (2026-10-13)

- Pane view input bar (`src/screens/InputBar.tsx`). There are three modes: **Line ⏎** (`pane.send_input` with the text plus
  `enter` in one request), **Text only** (`pane.send_text`) and **Agent prompt** (`agent.prompt`, the default when the
  pane has an agent). A special-key row sends Herdr key combos: Esc, ^C, ⏎, Tab, arrows, ⌫, ⇧Tab, ^D, ^Z, ^L, ^R.
- Long-pressing a workspace, tab or pane opens an action sheet: focus, new tab, new workspace, split right/down,
  close. The session card has a "+ Workspace" button. New tab/workspace asks for an optional name. Every close
  first shows a confirmation that says what will be terminated (`confirmText`). Herdr errors are translated
  (`describeActionError`).
- The pane view and prompt dialog avoid the keyboard (edge-to-edge Android doesn't resize the window).

Emulator evidence (screenshots `m3-*`):
1. `echo m3-input-ok` was sent from the input bar and echoed in w1:p1. `sleep 100`, then ^C, interrupts it and returns to the prompt (`m3-02`).
2. Tab action sheet (`m3-03`) → New tab "m3tab" (`m3-04`) appears in the tree. Split right on w1:p3 creates w1:p4.
3. Close pane w1:p4 shows the confirm dialog "Close pane w1:p4? Its process will be terminated." (`m3-05`). Cancel
   keeps it; confirming removes it. Closing tab m3tab asks "Close tab m3tab and all 1 pane(s)…" and removes it.
4. Focus workspace "api" moves the focus (`herdr workspace list` confirms `api` focused). "+ Workspace" →
   "m3ws" creates workspace 3 (`m3-06`).
5. Fake agent: an agent prompt while it is blocked shows "The agent is waiting for an answer (blocked)…" (`m3-07`).
   Answering "y" in Line mode gives "approved … done." (`m3-08`).

Open:
- `agent.prompt` only accepts *named* agents that Herdr itself detects (claude, codex, …). The test fixture's
  self-reported `fake` agent gets "agent w1:p1 is not an active named agent" (`m3-09`), so a successful
  agent prompt is untested here. It needs a real agent CLI on the test server.
- Fixture bug, reported to the test-infra owner: fake-agent restarts `--seq` at 1 on every run, and Herdr ignores
  reports whose seq isn't above the last one for the same source. So only the first run in a pane changes status.
