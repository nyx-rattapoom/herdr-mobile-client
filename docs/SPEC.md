# Herdr mobile client — plan

Status: plan approved 2026-10-13. Decisions: **SSH direct to Herdr socket (no server binary)**, **Expo React Native, Android first**.

## Functional spec
1. Add a server (host, port, user); connect over SSH.
2. Show the server host-key fingerprint and require user confirmation **before** sending any credential; pin it. On mismatch later, block and warn.
3. Auth: device-generated Ed25519 key (export public key for authorized_keys); password as fallback.
4. If Herdr is not installed on the server, offer install via the official installer with clear failure reasons.
5. List Herdr sessions → workspaces → tabs → panes; live updates.
6. View pane output with scrollback.
7. Send text, special keys, agent prompts; focus/create/close tabs, panes, workspaces.
8. Show per-agent status (working / blocked / completed); local notification when an agent becomes blocked or completes.
9. Credentials in Android Keystore / iOS Keychain; optional biometric unlock.
10. Optional later: paired-device mode for persistent access.

Non-goals: unsigned OTA code updates; password-only auth; uploading binaries to the server.

## Architecture (to be confirmed by clean side from public sources)
- Expo React Native app, Android first; native SSH module.
- Server link: SSH channel forwarded directly to Herdr's Unix socket (OpenSSH stream-local forwarding), speaking Herdr's public socket API. No helper binary on the server.

### Day-1 spike (clean side)
- Confirm Herdr's socket path and API from public docs/source.
- Confirm an Android SSH library supports stream-local (Unix socket) forwarding and pin-before-auth host-key flow.
- Confirm default sshd allows stream-local forwarding (`AllowStreamLocalForwarding`); define UX when disabled.
- Fallback if blocked: small open-source, reproducibly built, signed helper written from Herdr's public API.

## Milestones
- M1: connect + pin-before-auth + list sessions (read-only).
- M2: live pane output + scrollback.
- M3: input (text, keys, prompts, tab/pane/workspace actions).
- M4: agent status + notifications.
- M5: Herdr install flow, keychain/biometric, polish.
- M6 (optional): paired-device mode.

## Verification
- Security review: SSH host-key handling, credential storage, command/argument injection.
