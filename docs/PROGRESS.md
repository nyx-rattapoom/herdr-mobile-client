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
