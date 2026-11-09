# Day-1 spike: SSH → Herdr socket

Date: 2026-10-13. Inputs: Herdr public source (github.com/herdrdev/herdr @ `212b710`, Apache-2.0),
the locally installed `herdr` 0.7.5 CLI, mwiede/jsch source, OpenSSH docs.

**Outcome: feasible.** No server-side helper is needed for M1.

## 1. Herdr socket API

Source: `docs/next/website/src/content/docs/socket-api.mdx`, `src/session.rs`, `src/config/io.rs`.

- **Transport:** newline-delimited JSON over a Unix domain socket. One request per line,
  `{"id":"req_1","method":"ping","params":{}}` → `{"id":"req_1","result":{"type":"pong"}}`.
  Errors: `{"id":…,"error":{"code":"not_found","message":"…"}}`. Invalid JSON gives an empty `id`.
  Clients must ignore unknown fields and treat unsupported methods as normal errors.
- **Socket path:** `config_dir()/herdr.sock` for the default session and
  `config_dir()/sessions/<name>/herdr.sock` for named sessions. `config_dir()` is
  `$XDG_CONFIG_HOME/herdr` when that variable is set, otherwise `~/.config/herdr`.
  `HERDR_SOCKET_PATH` can override it, but that is a server-side environment detail the
  client can't see.
- **Session discovery:** `herdr session list --json` prints
  `{"sessions":[{"name","default","running","session_dir","socket_path"}]}`. That's a read-only
  exec of the already-installed binary, so nothing is uploaded. Fallback when `herdr` isn't on
  the exec PATH: `$HOME/.config/herdr/herdr.sock`.
- **Bootstrap read:** `session.snapshot` returns
  `{type:"session_snapshot", snapshot:{version, protocol, focused_*_id, workspaces[], tabs[], panes[], layouts[], agents[]}}`.
  Workspaces carry `workspace_id, number, label, focused, agent_status, tab_count, pane_count, active_tab_id`.
  Tabs carry `tab_id, workspace_id, number, label, focused, pane_count, agent_status`.
  Panes carry `pane_id, tab_id, workspace_id, cwd, focused, agent_status, terminal_title_stripped, …`.
  Agent status values are `idle | working | blocked | done | unknown`.
- **Live updates (M2+):** `events.subscribe` keeps the connection open, and events follow as later lines.
  On `events_lost`, resubscribe and re-read the snapshot on a second connection. The docs say
  explicitly that events invalidate the cache and must not be replayed onto a snapshot.
- Full JSON Schema: `herdr api schema --json`.

## 2. Android SSH library: mwiede/jsch 2.28.8

| Requirement | JSch (mwiede fork) |
|---|---|
| `direct-streamlocal@openssh.com` | `ChannelDirectStreamLocal` (`session.openChannel("direct-streamlocal@openssh.com")`, `setSocketPath`) |
| Host key shown/confirmed before credentials | `Session.connect()` finishes KEX and calls `checkHost()` → `HostKeyRepository.check()` **before** any `userauth` |
| Modern crypto on Android | Ed25519/X25519/chacha20 via Bouncy Castle (`bcprov-jdk18on`) |
| Licence | BSD-style |

Pin-before-auth design (no blocking callbacks in the SSH thread):

1. **Probe:** connect with *no credentials configured*, `StrictHostKeyChecking=yes`, and a custom
   `HostKeyRepository` that records the server key blob and returns `NOT_INCLUDED`. JSch aborts with
   `JSchUnknownHostKeyException` right after KEX. We return the key type and `SHA256:` fingerprint
   (OpenSSH format: base64 of SHA-256 over the key blob, without padding).
2. **Confirm:** the UI shows the fingerprint. The user accepts, and the app pins the key blob in its store.
3. **Connect:** a new session with the pinned repository. `check()` returns `OK` only for an exact blob
   match and `CHANGED` otherwise, so JSch throws `JSchChangedHostKeyException` before auth and the UI
   blocks with a mismatch warning. The password is passed to JSch only in this step.

Android specifics: JSch is a multi-release jar. D8 uses the base (Java 8) classes, so JSch selects
its `bc.*` implementations, and `bcprov-jdk18on` must be on the classpath.

I picked JSch because I verified both requirements in its source. I didn't evaluate sshj, Apache MINA
SSHD, or libssh2 (JNI) in depth, so they remain options if JSch hits a blocker.

## 3. Server prerequisites and UX

- OpenSSH `AllowStreamLocalForwarding` defaults to `yes`. A `no` setting, `DisableForwarding yes`,
  or `restrict`/`no-port-forwarding` in authorized_keys makes the channel open fail with
  `SSH_OPEN_ADMINISTRATIVELY_PROHIBITED`. The UX shows "This server's sshd doesn't allow Unix-socket
  forwarding (AllowStreamLocalForwarding). Ask the admin to enable it for your user."
- A missing socket (server not running) also fails at channel open, with "connect failed". The UX shows
  "Herdr isn't running on this server" (the install/start flow is M5).
- sshd's stream-local open runs as the authenticated user, so normal Unix permissions on
  `~/.config/herdr/herdr.sock` apply.

## 4. Fallback

Not needed. Per SPEC.md it would be a small, reproducibly built, open-source helper written against the
public API, used only when stream-local forwarding is disabled.

## 5. Jump hosts

A server profile may name another saved server as its jump host, and that server may name its own, so a
route is the chain of `jumpId`s (at most 8 hops; loops are rejected when saving and again when connecting).
The app opens the hops in order, each through a `direct-tcpip` channel on the one before it (`JumpProxy`, a
JSch `Proxy`). Every hop's pin must already exist and is enforced before that hop's credentials are sent, and
each hop authenticates with its own password or device key. The connection owns the whole chain and closes
it from the inside out. The target's SSH session runs the same way through the last hop. The target does
its own key exchange end to end, so probe → confirm → pin works exactly as for a direct server, and the
target's credentials are only sent after its pin matches. Pins of anything reached through a jump are keyed
by `<jumpId>>host:port` (the immediate jump only, since that hop's own pin already identifies its route), so
the same LAN address behind two different jump hosts are different endpoints.

Every jump host's sshd must allow TCP forwarding (`AllowTcpForwarding`, default `yes`). Open failure reason
1 maps to `ERR_JUMP_PROHIBITED`, and reason 2 (the jump host can't reach the target) to `ERR_JUMP_UNREACHABLE`.

Proxied sessions have no socket, so JSch can't apply its read timeout to them. Two consequences:
`JumpProxy.connect` arms a watchdog that disconnects a handshake that hasn't finished within the connect
timeout (a target that accepts TCP and then stays silent), and native `ServerAliveInterval` doesn't detect a
target that dies silently while the jump host stays up. The app-level liveness check (`alive()`) covers that.

## 6. iOS SSH library: libssh2 1.11.1 + OpenSSL 3.6

Date: 2026-11-03. The iOS half of `modules/herdr-ssh` (`modules/herdr-ssh/ios`) implements the same JS API and
error codes as the Kotlin module.

| Requirement | SwiftNIO SSH | libssh2 1.11.1 (OpenSSL backend) |
|---|---|---|
| `direct-streamlocal@openssh.com` | **No.** `SSHChannelType` has only `session`, `directTCPIP`, `forwardedTCPIP`, and the enum and wire parsing are internal, so it would need a fork | `libssh2_channel_direct_streamlocal_ex` |
| `direct-tcpip` (jump hosts) | yes | `libssh2_channel_direct_tcpip_ex` |
| Host key before credentials | yes (validation delegate) | `libssh2_session_handshake` ends after KEX; `libssh2_session_hostkey` returns the blob before any `userauth` call |
| Ed25519 user and host keys | yes | yes with OpenSSL ≥ 1.1.1 (not with mbedTLS) |
| Ciphers/KEX | AES-GCM only, curve25519/ECDH | the usual OpenSSH set incl. chacha20-poly1305, curve25519, DH-GEX |
| Integration | SPM only (awkward from a CocoaPods-linked Expo module) | plain C, vendored into the pod |

**Choice: libssh2.** SwiftNIO SSH can't open the Herdr socket channel without a fork. libssh2 has every
primitive we need, but it's a C library with a non-blocking API that isn't thread-safe per session, so the
module wraps it carefully:

- **Packaging.** libssh2 1.11.1 is vendored as source in `modules/herdr-ssh/ios/vendor/libssh2` (BSD-3-Clause,
  tarball SHA-256 `d9ec76cb…f658f7`, the same as Homebrew's) and compiled into the `HerdrSsh` pod with a
  hand-written `libssh2_config.h`. OpenSSL comes from the `OpenSSL-Universal` pod (3.6.2000, an xcframework with
  device and simulator slices). There's no prebuilt binary in the repo.
- **Threading.** Each SSH session owns one loop thread, which makes every libssh2 call after login. The loop
  runs libssh2 non-blocking, services every channel on each pass (exec, Herdr sockets, jump bridges), then
  waits in `poll()` on the socket plus a wake pipe. A small C shim (`herdr_libssh2_pump`) drains the transport
  each pass, so an idle session still notices the server closing it.
- **libssh2 pitfalls the loop works around:**
  - Channel opens keep their state per *session*, so only one open runs at a time. A timed-out open is still
    driven to completion before the next one starts. The catch is that a direct-tcpip open to a host that
    drops SYNs holds the slot until sshd gives up.
  - libssh2 has one outbound packet buffer per session, and a half-sent packet can only be finished by a call
    with the same buffer. No other packet goes out before it.
    - Before a channel is freed, the shim (`herdr_libssh2_channel_flush_owned`) finishes any half-sent packet
      that belongs to it (data, window adjust, exec request).
    - `closeChannel` sends queued writes first, for up to 5 s.
    - The vendored `transport.c` carries one patch (`vendor/libssh2/PATCHES.md`): such a continuation is sent
      before a server-initiated rekey takes over. Otherwise a rekey during a half-sent packet deadlocks the
      session.
  - `libssh2_session_free` would try to close open channels over the socket and, being non-blocking, give up
    and leak. The shim marks the socket disconnected first, and the native test checks that every session is
    freed.
  - Keepalives use `want_reply=0`, because libssh2 queues every reply packet forever, and a 1-byte reply makes
    `libssh2_poll_channel_read` fail.
  - A command killed by a signal has no exit status. libssh2 reports 0 there; the module reports -1, as JSch
    does. Known gap: a channel that sshd closes with neither an exit status nor an exit signal still reports 0
    (JSch reports -1).
- **Pin before auth.** Same as Android: probe = handshake → read the host key → disconnect. Connect =
  handshake → constant-time compare with the pin → `ERR_HOSTKEY_MISMATCH` before `userauth_list` ever runs.
  Auth order is publickey (device key), then password, then keyboard-interactive (one non-echo password prompt).
- **Jump hosts.** The next hop's session runs over one end of a `socketpair`. The previous hop's loop pumps
  the other end through a `direct-tcpip` channel, so the chain is arbitrarily deep, and closing a hop
  closes the sockets of everything behind it. The 15 s connect deadline covers the channel open, the
  handshake and auth, so a target that accepts TCP and then stays silent fails with `ERR_TIMEOUT`. Open
  failure reason 1/2 → `ERR_JUMP_PROHIBITED`/`ERR_JUMP_UNREACHABLE` (libssh2 reports the reason as fixed text).
- **Liveness.** libssh2 has no ServerAliveCountMax. Direct sockets use TCP keepalive (10 s idle, 3 × 10 s
  probes). Sessions behind a jump host have no socket of their own. A target that dies silently while the
  jump host stays up is caught only by the app's `alive()` check. Android covers that case with
  ServerAliveCountMax on every hop.
- **Host key algorithm preference** is ed25519 → ECDSA → RSA (JSch's order), so a server offering several
  keys pins the same one on both platforms.

Platform differences:

- `startMonitoring`: iOS has no foreground service. The module requests background time when the app leaves
  the foreground (about 30 s), and iOS then suspends the app. Connections drop and the app reconnects on
  return. Agent alerts can't arrive while the app is suspended.
- `setSecureScreen`: iOS apps can't block screenshots, so the module covers the window while the app is
  inactive. That keeps the terminal out of the app-switcher snapshot.
- Credentials: `expo-secure-store` uses the Keychain. The biometric vault (`requireAuthentication`) uses
  Face ID/Touch ID with `NSFaceIDUsageDescription` from the `expo-local-authentication` plugin.

Native test: `HERDR_TEST_SSH=herdr:herdr-test@127.0.0.1:2222 HERDR_TEST_NOFWD=127.0.0.1:2223
modules/herdr-ssh/ios/tests/run.sh` builds the same Swift core plus libssh2 for macOS and runs the
probe/pin/auth/exec/socket/key/jump/multi-hop cases against the Docker servers.

## 7. Herdr Core transport (protocol generation 1)

Date: 2026-11-09. Sources pinned at herdr-core `3ba03e6fc59fb974a4e2627586646f87ebbaf2ee`:
`schema/README.md`, `hc.openrpc.json`, `docs/labels.md`, and the event producers in `crates/herdr-core/src/events.rs`,
`runtime.rs`, `viewers.rs`, `foreground.rs`, and `api.rs`.

- **Transport.** `ssh box hc connect` speaks JSON-RPC 2.0, one line per message, until `hello {generation:1,
  framed:true}`. After that reply the same connection switches to frames
  `[channel u32 LE][kind u8][len u32 LE][payload]` (≤ 16 MiB). Channel 0 carries JSON-RPC; one JSON message per
  DATA frame (no newline needed). Other channels carry raw terminal bytes.
- **Android implementation.** A no-PTY `ChannelExec` (`ExecStream.kt`) exposes `openExecStream`,
  `startExecStream`, `writeBytes` and `closeExecStream`. Base64 is only the JS bridge envelope; bytes are never
  UTF-8 decoded. stdout is buffered until `startExecStream`, so the attach first paint cannot race listener setup.
  The pending queue is bounded (16 MiB); a consumer that falls further behind closes the stream with
  `output queue overflow` (a hard bound, not SSH-window backpressure). stderr is capped at 64 KiB, and exit 97 means "hc not found" rather than a
  protocol loss.
- **Attach streams.** `terminal.attach` returns a channel, then the first paint, then live bytes. The viewer sends
  keys as DATA, RESIZE/FOCUS/FACTS for viewer activity, and CLOSE to detach (never `terminal.kill`). Streams start
  with 256 KiB credit; CREDIT reports consumed bytes. A stream also requests `resize_notifications:true`, and the
  reply is honored only when confirmed.
- **Events.** `events.subscribe` returns `{seq, terminals, channel}` and notifications arrive as JSON lines:
  `event` (`created`, `restarted`, `lost`, `finished`, `removed`, `keep`, `status`, `turn`, `title`, `labels`,
  `size`, `foreground`, `doc`), `heartbeat {seq}`, and `missed {seq, terminals}`. The client resnapshots on
  `missed`/reconnect and reads documents after subscribe, `missed`, docs events and reconnects.
- **Shared state.** `herdr.seen=<turn>` is raise-only; a missing label is not turn 0: the client applies its own
  rule (this app shows any finished turn, `turn > 0`, as done) and keeps no separate local seen counter.
  Unpin writes `herdr.pinned=""`; pin writes `herdr.pinned=1`. No bulk upload of local pins happens.
- **Layout.** The `herdr-app` document is read only (`doc.get`): spaces → tabs → nodes (block/row/column/stack,
  optional floating blocks). Unknown content is ignored and never written back.
- **iOS.** Core transport is deliberately absent in this delivery. The Swift module keeps its existing Herdr TUI
  API, so a saved Core profile is gated in the UI/JS before any native call.
