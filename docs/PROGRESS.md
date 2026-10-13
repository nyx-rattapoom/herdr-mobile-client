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

## M4: agent status and notifications (2026-10-13)

- Agent status comes from `pane.agent_status_changed` subscriptions (applied right away) and from
  `session.snapshot` agents (authoritative). It shows next to panes, tabs and workspaces in the tree.
- Alert rules (`src/live/agents.ts`): **blocked** when an agent enters `blocked`; **completed** when a `working`
  agent becomes `idle`/`done` or disappears from the agent list (Herdr drops idle agents). The first snapshot
  after starting a session is a silent baseline, so agents that were already blocked at connect don't re-alert,
  but transitions missed during a reconnect do. Repeats per pane+kind are deduped for 15 s (`AlertDeduper`).
- Notifications use expo-notifications on a dedicated `agents` channel (high importance). There's no alert while
  the user is looking at that pane. Tapping a notification opens the pane, and also connects first if the app was on
  the server list.
- Background: while connected, a foreground service (`MonitorService`, type `dataSync`, ongoing "Watching agents
  on <server>" notification) keeps the process, the JS runtime and the SSH sockets alive. SSH keepalives (15 s × 3)
  detect dead links, and LiveSession reconnects.

Emulator evidence (screenshots `m4-*`, cropped to this app's notifications):
1. With the app backgrounded (HOME), fake-agent in w2:p2 posts "fake needs your input · Blocked in test box · api · w2:p2" on
   channel `agents`, next to the ongoing monitor notification (`m4-02`).
2. Tapping it opens w2:p2 at the `[y/n]` prompt (`m4-03`). Answering y and going HOME posts "fake finished ·
   Completed in …" (`m4-04`).
3. In the tree, w2:p2 shows `fake ● working`, then `● blocked` (`m4-05`, `m4-06`).
4. Answering while viewing w2:p2 posts no new "finished" notification.
5. Screen off + `dumpsys battery unplug` + `dumpsys deviceidle force-idle` (deep IDLE): the blocked alert
   still arrives within the 12 s window, and the service stays `isForeground=true`.

### Background limits (Android)
- Alerts need the process alive. If the user swipes the app away from recents, force-stops it, or the OS kills it
  under memory pressure, the service stops (`START_NOT_STICKY`) and no alerts arrive until the app is opened again.
  There is no push path without a server-side component (paired-device mode, M6, is future work).
- Some OEM battery managers kill foreground services regardless; users may need to exempt the app.
- Android 13+ asks for notification permission once. If it's denied, status is still shown in-app but nothing is posted.
- Android 14+ requires a foreground-service type. `dataSync` is time-limited on Android 15+ (about 6 h per 24 h). When
  the system times it out, the service stops itself and background alerts pause until the app is foregrounded.
- Doze: verified on Android 11 that a foreground-service process keeps its connection in forced deep idle. Newer
  versions and OEM builds weren't tested.
- Network changes (Wi-Fi ↔ cellular) drop the SSH session. Keepalives notice within about 45 s and the UI shows
  *offline* with Reconnect. Automatic SSH re-dial in the background is not implemented.

Known gap: a successful `agent.prompt` isn't exercised end to end. It needs a Herdr-detected agent CLI, and the test
server has none (no API keys). It's covered by unit tests (`inputRequest`) and the error-path evidence in M3.

## M5: key auth, install flow, biometrics, edit server, polish (2026-10-13)

- **Device key** (`Keys.kt`, `src/store/deviceKey.ts`, Settings screen): an Ed25519 key pair generated on the phone
  with JSch + Bouncy Castle. The private key (OpenSSH v1) lives only in Keystore-backed storage. The public key is
  shown with Copy / Share / Regenerate (regenerate asks for confirmation). Server auth can be **Device key** (the
  default for new servers, with the saved password as optional fallback) or **Password**. With both, JSch tries
  publickey first. A wrong password is tried exactly once, not retried until sshd's MaxAuthTries.
- **Edit server** (long-press → Edit): every field, the auth method, the password (empty keeps it, or
  "Remove saved password") and an optional herdr path.
- **Herdr discovery** (closes the M1 PATH-guess issue), in order: the configured herdr path (strictly validated so
  it can't inject shell) → `command -v herdr` → the login shell (`$SHELL -lc "command -v herdr"`) → the official
  installer's default `~/.local/bin/herdr`.
- **Install / start**: when herdr is missing, the sessions screen offers **Install Herdr**. It downloads the official
  `https://herdr.dev/install.sh` to a temp file and runs it with `sh` (installs into ~/.local/bin for the user), then
  starts a detached `herdr server` and waits for its socket. Failure reasons: no curl, can't reach herdr.dev, the
  installer's own `✗` messages (unsupported OS/arch, checksum, …), and server didn't start. When herdr is installed but
  not running: **Start Herdr**. Every generated script is checked with `sh -n` in tests.
- **Forwarding refused**: OpenSSH reports `AllowStreamLocalForwarding no` with the same generic failure as a missing
  socket. The app checks `test -S <socket>` over exec. If the socket exists, it shows "sshd doesn't allow Unix-socket
  forwarding (AllowStreamLocalForwarding)…" and stops retrying.
- **Biometric unlock** (Settings toggle): passwords and the device private key move into one SecureStore item that
  requires user authentication (`requireAuthentication`, own Keystore alias). One fingerprint prompt unlocks it, and it
  re-locks when the app goes to the background. Turning it off moves them back. Cancel and invalidation (changed
  biometrics) get clear messages.
- **Polish**: a monochrome notification icon (expo-notifications plugin), also used by the foreground-service
  notification. Agent panes default to Line mode while the agent is blocked. Server rows show the auth method.

Emulator evidence (screenshots `m5-*`):
1. Settings → Create device key → `ssh-ed25519 AAAA… herdr-client`, "Public key copied" (`m5-01`). The key was
   added to herdr-test's authorized_keys, and the server was edited to Device key (`m5-02`, `m5-03`). Connecting gives sshd
   `Accepted publickey … ED25519 SHA256:…`, which equals `ssh-keygen -lf` of the device key (`m5-04`).
2. Key removed from authorized_keys → `Accepted password` (fallback). Wrong password + no key → "Authentication
   failed. Check the user and password, or that the device public key is in ~/.ssh/authorized_keys…" (`m5-05`). sshd
   logs exactly one `Failed password`. (Before the fix, JSch retried until "Too many authentication failures".)
3. herdr-test-nofwd (2223): fingerprint Q2N8…6lw → *offline* with the AllowStreamLocalForwarding message (`m5-06`).
   sshd logs `refused streamlocal port forward`.
4. herdr-test-noherdr (2224), fresh container: "Herdr is not installed" → Install → herdr 0.9.3 installed and server
   started → *● live* (`m5-07`–`m5-09`). With `herdr.dev` pointed at 127.0.0.1 in the container: "The server could not
   download the installer from https://herdr.dev/install.sh. Check its internet access, proxy or firewall." (`m5-10`).
   After restoring the network, "Try again" → *● live*. With the server stopped: "Herdr is not running" → Start →
   *● live*.
5. Biometrics (temporary emulator PIN + fingerprint, removed afterwards): enable → system prompt "Protect saved
   credentials" (`m5-11`, `m5-12`). Connecting asks "Unlock saved server credentials" (`m5-13`). Cancel → "Unlock
   cancelled…" (`m5-14`). A fingerprint touch → *● live*. Disabled again → connects without a prompt.
6. Notification with the new icon (`m5-15`).

Tests: jest (protocol, live session, actions, alerts, discovery and scripts, stores, secrets vault, device key) and
JVM (`PinnedHostKeyRepositoryTest`, `KeysTest`, and `StreamLocalIntegrationTest` with pin mismatch, stream-local
ping and device-key login against test/server).

Open / future:
- **M6 (paired-device mode)** is not implemented. It's optional per SPEC. It's the only way to get alerts when the app
  process is dead (see the M4 limits).
- Successful `agent.prompt` isn't exercised end to end (no Herdr-detected agent CLI on the test server).
- Biometric-protected credentials were tested on the Android 11 emulator only. Keystore invalidation after a
  biometric change is handled by message but wasn't reproduced.
- iOS is not started (the native module is Android-only).

## Security review fixes (2026-10-13)

An independent review found 0 critical, 0 high, 2 medium and 10 low issues. It verified pin-before-auth clean end to end. Fixes:

| ID | Fix | Tests |
|---|---|---|
| M1 | `LineBuffer` is linear (it only splits when a chunk has a newline). Lines over 2M chars close the connection with a `protocol` error. Pane text is capped at 1M chars (newest kept) before ANSI parsing. Snapshot records are capped at 1000 per kind, with typed field copies. | client, paneReader, snapshot |
| M2 | The installer download uses `curl --proto =https --tlsv1.2`. The Install card says it "downloads and runs https://herdr.dev/install.sh as <user> on <host>". | sessions |
| L1 | Server-supplied socket paths go into a shell probe only if they match `^/[A-Za-z0-9_./+-]+$`. All generated scripts are single-line (csh/tcsh) and pass `sh -n`. | sessions |
| L2 | `Exec.run` has a deadline (120 s by default, 300 s for install). It drains stdout/stderr concurrently and always closes the channel and cancels readers. `openSocket` closes the channel on failure. | JVM `execTimesOutAndClosesTheChannel` |
| L3 | Keyboard-interactive answers one hidden prompt containing "password", once, and never 2FA/OTP prompts. | JVM `PasswordUserInfoTest` |
| L4 | Secret get/set/delete wait until settings have loaded. | secrets |
| L5 | Turning biometrics off needs a fresh `authenticateAsync` and re-reads the vault (no cached unlock). | secrets |
| L6 | `android.allowBackup=false`. The input bar has a hidden-input toggle for password prompts. Optional FLAG_SECURE setting. | — (emulator) |
| L7 | Agent alerts use a new channel `agent-alerts` with lock-screen visibility PRIVATE (the old channel is deleted). Names and labels in alerts are sanitised and truncated. | text |
| L8 | The ANSI parser drops C1 controls and bidi overrides/isolates. Snapshot labels, titles and agent names are sanitised (`cleanLabel`) and ids are type-checked. | ansi, text, snapshot |
| L9 | The host-key hint follows the algorithm (ed25519/ecdsa/rsa). "Forget host key" remembers the old fingerprint, and the next confirmation shows "Previously pinned … Same key as before / The key has changed". | pinning |
| L10 | `npx expo install --fix` aligned `@types/jest`. `npm audit` still reports advisories (braces, node-forge, sprintf-js, uuid). All of them come through Expo's CLI/config-plugin tooling (`@expo/cli`, `xcode`) or jest, none of which is in the app bundle. They're left for an Expo SDK update. | — |

Also found while verifying: removing a server profile purged the host-key pin of another profile on the same host:port. Pins are now kept while any profile uses the endpoint (`endpointInUse`).

Residual risk (M2): `install.sh` itself has no published checksum, so it's trusted through HTTPS/TLS to herdr.dev only. The installer then verifies the binary's SHA-256 against Herdr's release manifest. Install runs only after the user taps it on a card that names the URL, user and host.

Emulator evidence (screenshots `sec-*`):
- **M1**: a malicious socket on herdr-test (reverse stream-local forward to a local server that sends 15 MB without a newline), reached through a profile with herdr path `/home/herdr/fake-herdr`. The session shows "reconnecting… response line longer than 2097152 characters" within 4 s (`sec-01`). The server sees a broken pipe after about 2 MB. Retries back off (5 attempts in about 24 s), the UI keeps navigating, and logcat shows no ANR.
- **L3**: password logins still work: the fallback and password profiles connect (`Accepted password` in sshd). The 2FA/OTP refusal is covered by JVM tests (the test sshd has no keyboard-interactive challenge).
- **L6**: the installed package has no `ALLOW_BACKUP` in `pkgFlags`. The hidden-input toggle shows `••••••••` (`sec-02`). With "Hide app content from screenshots" on, the window flags include `SECURE` and `screencap` yields no image. Turned off, screenshots work again (`sec-03`).
- **L9**: after Forget host key, reconnecting shows "Confirming the host key again…", "Previously pinned … SHA256:9LrZ…/o · Same key as before" and `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (`sec-04`).
