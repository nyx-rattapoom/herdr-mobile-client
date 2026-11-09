# Android emulator evidence: Herdr Core backend

Date: 2026-11-09. Base: `fm/herdr-core-backend` at `4b6039d` (PR #4). App version 1.2.0 /
versionCode 10. Host: Intel MacBookPro16,1, macOS 26.3.1 (Darwin 25.3.0, x86_64, hardware virtualization
available). All 10 screenshots are in [`docs/emulator-evidence/`](emulator-evidence/).

## Verdict

The Core flow ran on a real Android emulator: add a Core profile, verify and pin the
host key, connect over the native Android `hc connect` exec stream, render the terminal
list and desktop layout, open a terminal, submit a prompt (`terminal.send`), and leave
with the hardware Back button. The pane stayed in observe mode throughout; typed input on
the attach channel was not exercised.

It closes two recorded gaps:

- hardware Back inside the Core terminal (`CoreConsoleScreen` BackHandler): screenshots
  09 and 10;
- the byte-safe native exec stream (`modules/herdr-ssh` `ExecStream.kt` / JSch): every
  Core screen (06–08) only renders if framed binary traffic crossed it intact in both
  directions.

These gaps stay open:

- **iOS Core gate** remains untested. This host has no full Xcode/iOS simulator lane; the
  gate is still only covered by the platform-mocked tests.
- **Real `hc`** remains untested. The server side below is a protocol-faithful fake, not
  herdr-core. No async server event was injected, so the live event/`missed` path was not
  exercised on-device.

## Screenshots

| File | Shows |
|---|---|
| `01-servers-empty.png` | Fresh launch: empty Servers screen and Add server |
| `02-add-server.png` | Add-server form; Herdr TUI selected by default |
| `03-add-server-core.png` | Same form with **Herdr Core** selected |
| `04-servers-with-core.png` | Saved row: `core box · herdr@10.0.2.2:2222 · password · Herdr Core` |
| `05-hostkey-verify.png` | Host-key verification with fingerprint `SHA256:XE446Yluv…REnTKvejvVAM` |
| `06-core-terminal-list.png` | Connected: `fakebox · Core`, space `work`, tab `api`, terminal card |
| `07-core-terminal-open.png` | Terminal open in observe mode, painted `fake core on fakebox` and `$` |
| `08-core-terminal-typed.png` | After submitting `echo hi`: `$ echo hi`, `hello from fake core`, `$` |
| `09-core-back-to-list.png` | One hardware Back press: back on the Core terminal list |
| `10-servers-after-back.png` | Second hardware Back: back on Servers; profile and pinned key persist |

## Fixture honesty

The server was a disposable `herdr-test` container on `127.0.0.1:2222` with a Python
`hc connect` peer installed at `/home/herdr/.local/bin/hc`. It implements the pinned
generation-1 shapes used by the app: plain `hello`, framed channel 0 requests, event
channel 2, attach channel 5, the `herdr-app` layout, `terminal.attach` first paint,
`terminal.send`/`keys`/`label`. It is **not** herdr-core and does not prove live-core
interoperability. The fake's source is not included in this repository.

The app found the fake through its normal `$HOME/.local/bin/hc` fallback; the profile's
hc path field stayed at its placeholder. The SSH route, host-key probe/pin, password
auth, native exec channel, base64 bridge envelope and raw VT bytes were all real.

## Environment and commands

The host started without a JDK, Android SDK or emulator. The run used home-directory
installs, not shared system paths:

- Temurin JDK 17.0.21+9 → `~/android-lab/jdk`
- Android SDK command-line tools → `~/Library/Android/sdk`; `platform-tools`,
  `platforms;android-36`, `build-tools;36.0.0`, `emulator`,
  `system-images;android-36;default;x86_64`
- AVD `herdr` (pixel_7, x86_64, API 36), headless:
  `emulator -avd herdr -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`
- App: `npx expo run:android` from the worktree (single attached device; `--device
  emulator-5554` is rejected by this Expo CLI, so the flag was omitted)
- Driving/capture: `adb shell input`, `uiautomator dump`, `adb exec-out screencap -p`

Host-key fingerprint was cross-checked with
`docker exec herdr-test ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`; it matched
screenshot 05. `logcat` showed no app crash during the flow.

## Run flow

1. Launch, dismiss the notification-permission dialog, empty Servers screen (01).
2. Add server: TUI is the default (02); tap Herdr Core and the form shows the Core
   explainer (03).
3. Save the Core profile (04), tap it, confirm the pinned fingerprint (05), trust and
   connect.
4. Core list shows the desktop space/tab grouping and the terminal card (06); open it
   (07).
5. Submit `echo hi`; the fake core paints the command and its response (08).
6. Hardware Back closes the terminal and returns to the list (09); a second Back returns
   to Servers with the profile and pin intact (10).

## Remaining gaps

- iOS Core gate: run on an Apple-silicon/Mac lane with an iOS simulator.
- Type text / first-input active-viewer reattach on the attach channel: typing in the
  terminal should reattach with `observe:false` and send DATA and RESIZE frames on the
  attach channel. Screenshot 08 still shows the observe banner.
- Shared labels: the `herdr.seen` raise on view and the pin/unpin `herdr.pinned` round-trip
  were not verified on the device. t7 still shows "done" in 09 after being viewed in
  07–08, and the fake `hc` may not emit the `labels` events the app waits for.
- Real herdr-core: repeat 06–08 against a live `hc` and inject a server event to exercise
  subscribe/`missed`/resnapshot on-device.
- The fake `hc` peer is a good candidate for `test/server/` so the next Core lane does
  not have to hand-wire it.
