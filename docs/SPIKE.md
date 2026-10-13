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
