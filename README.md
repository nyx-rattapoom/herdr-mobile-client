# herdr-client

Open-source mobile client for [Herdr](https://github.com/herdrdev/herdr) (Expo React Native, Android and iOS).

See [docs/SPEC.md](docs/SPEC.md) for the product spec.

## Status

M1–M5 from [docs/SPEC.md](docs/SPEC.md) are implemented on Android. iOS uses the same app with a libssh2-based
SSH module (see [docs/SPIKE.md](docs/SPIKE.md) §6 for what differs). Per-milestone evidence is in
[docs/PROGRESS.md](docs/PROGRESS.md), and the design is in [docs/SPIKE.md](docs/SPIKE.md).

- SSH straight to Herdr's socket (direct-streamlocal). Nothing is uploaded to the server. The host key is shown and
  pinned before any credential is sent, and a mismatch blocks the connection.
- Optional per-server **Herdr Core** backend next to the default **Herdr TUI** backend. Core speaks `hc connect`
  over SSH (binary-framed) and needs `hc` on the server; the app never installs or upgrades it and never falls back
  to TUI. Core is Android-first; iOS keeps its existing TUI path and gates Core profiles with an explanation.
- Jump hosts (like `ssh -J`): a server can hop through another saved server, which can itself hop through another
  (up to 8 hops), e.g. phone → office gateway → Pi → box on the Pi's LAN. Each hop uses its own password or device
  key, its host key is pinned separately, and each jump host only relays the encrypted session to the next.
- Ed25519 device key (generated on the phone), with password as fallback. Optional biometric unlock for saved
  credentials.
- Live sessions → workspaces → tabs → panes. Pane output with scrollback. Text, keys and agent prompts. Focus,
  create and close tabs, panes and workspaces (closes ask for confirmation).
- Agent status and local notifications when an agent is blocked or finishes, kept alive in the background by a
  foreground service on Android (limits are in PROGRESS.md). iOS only gets a short grace period in the background.
- Installs Herdr with the official installer when it's missing, or starts its server.

For Herdr Core, install the herdr-core package on the server so `hc` is on the login `PATH` (or set the profile's
`hc` path). A Core profile can share an endpoint with a TUI profile; each has its own executable path and backend.
Core support in this version is Android-only; see [docs/PROGRESS.md](docs/PROGRESS.md) for the tested and untested
parts.

Future: paired-device mode (M6).

```bash
npm install
npx expo run:android          # dev build (JDK 17)
npx expo run:ios              # dev build (Xcode, CocoaPods)
npm test                      # jest
npm run typecheck && npx expo lint
# Native tests; integration tests run against test/server when HERDR_TEST_SSH is set
cd android && HERDR_TEST_SSH=herdr:herdr-test@127.0.0.1:2222 ./gradlew :herdr-ssh:testDebugUnitTest
# iOS SSH core (same Swift + libssh2, built for macOS)
HERDR_TEST_SSH=herdr:herdr-test@127.0.0.1:2222 HERDR_TEST_NOFWD=127.0.0.1:2223 modules/herdr-ssh/ios/tests/run.sh
```

## License

MIT. See [LICENSE](LICENSE).
