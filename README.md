# herdr-client

Open-source mobile client for [Herdr](https://github.com/herdrdev/herdr) (Expo React Native, Android first).

See [docs/SPEC.md](docs/SPEC.md) for the product spec.

## Status: M1

Connect over SSH with the host key pinned before auth, then list Herdr sessions → workspaces → tabs → panes (read-only).
Android only. Password auth for now; key auth comes in a later milestone. See [docs/SPIKE.md](docs/SPIKE.md) for the design.

```bash
npm install
npx expo run:android          # dev build on a device/emulator (JDK 17)
npm test                      # TS unit tests (protocol client, pinning, discovery, stores)
npm run typecheck
# Native tests; the integration tests run only when HERDR_TEST_SSH is set (see test/server)
cd android && HERDR_TEST_SSH=herdr:herdr-test@127.0.0.1:2222 ./gradlew :herdr-ssh:testDebugUnitTest
```

Emulator walkthrough against `test/server` (screenshots in [docs/screenshots](docs/screenshots)):
add server → host key confirm (fingerprint shown, sshd logs only a `[preauth]` disconnect) → sessions tree →
reconnect after app restart uses the pin with no prompt → after host keys are regenerated, the connection is blocked with both
fingerprints shown (again `[preauth]` only) → long-press "Forget host key" allows re-pinning.
