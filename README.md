# herdr-client

Open-source mobile client for [Herdr](https://github.com/herdrdev/herdr) (Expo React Native, Android first).

See [docs/SPEC.md](docs/SPEC.md) for the product spec.

## Status

M1–M5 from [docs/SPEC.md](docs/SPEC.md) are implemented on Android. Per-milestone evidence is in
[docs/PROGRESS.md](docs/PROGRESS.md), and the design is in [docs/SPIKE.md](docs/SPIKE.md).

- SSH straight to Herdr's socket (direct-streamlocal). Nothing is uploaded to the server. The host key is shown and
  pinned before any credential is sent, and a mismatch blocks the connection.
- Ed25519 device key (generated on the phone), with password as fallback. Optional biometric unlock for saved
  credentials.
- Live sessions → workspaces → tabs → panes. Pane output with scrollback. Text, keys and agent prompts. Focus,
  create and close tabs, panes and workspaces (closes ask for confirmation).
- Agent status and local notifications when an agent is blocked or finishes, kept alive in the background by a
  foreground service (limits are in PROGRESS.md).
- Installs Herdr with the official installer when it's missing, or starts its server.

Future: paired-device mode (M6), iOS.

```bash
npm install
npx expo run:android          # dev build (JDK 17)
npm test                      # jest
npm run typecheck && npx expo lint
# Native tests; integration tests run against test/server when HERDR_TEST_SSH is set
cd android && HERDR_TEST_SSH=herdr:herdr-test@127.0.0.1:2222 ./gradlew :herdr-ssh:testDebugUnitTest
```
