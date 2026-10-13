This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Project rules

- Product spec: docs/SPEC.md. Server protocol: Herdr public docs/source.
- Navigation is a small state machine in `App.tsx` (four screens); no router yet.
- SSH lives in the local Expo module `modules/herdr-ssh` (Kotlin, JSch). Native changes need a rebuild: `npx expo run:android`.
- Host keys: never send credentials before the host key is pinned and matches (see docs/SPIKE.md).
- No unsigned OTA updates (SPEC non-goal); don't add `expo-updates`/EAS Update.
- `ios/` and `android/` are generated (Continuous Native Generation). Never edit them by hand; configure via `app.json` and config plugins.
- Unit tests: `npm test`. Typecheck: `npm run typecheck`.
