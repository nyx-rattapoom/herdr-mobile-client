# Test servers

Test-only credentials (`herdr` / `herdr-test`); bound to localhost only. From the Android emulator the host is `10.0.2.2`.

| Container | Port | Purpose |
|-----------|------|---------|
| `herdr-test` | 2222 | Normal: Herdr running, stream-local forwarding allowed |
| `herdr-test-nofwd` | 2223 | `AllowStreamLocalForwarding no` → forwarding-prohibited error |
| `herdr-test-noherdr` | 2224 | Herdr not installed → install flow |
| `herdr-test-old` | 2226 | Herdr 0.7.5 (protocol 17), an old server: rejects newer event types such as `workspace.reordered` |
| `herdr-test-agent` | 2225 | Herdr + opencode (a real agent Herdr detects) on a free opencode Zen model; same host key as `herdr-test` |

    test/server/up.sh            # build images and (re)start all five
    REGEN_HOST_KEYS=1 test/server/up.sh herdr-test   # new host key → host-key-changed path

Fake agent (drives working → blocked → working → idle):

    docker exec herdr-test su herdr -c '~/.local/bin/herdr pane run w1:p1 "fake-agent 5"'

It blocks on a `[y/n]` prompt; answer from the app (send text/keys) or with `herdr pane send-text`.
Key auth: append the app's public key to `/home/herdr/.ssh/authorized_keys` in the container.

Real agent (opencode, for `agent.prompt` end to end). No API key: it uses the free `opencode/big-pickle`
model, so prompts are sent to opencode.ai. Don't put anything sensitive in test prompts.

    docker exec herdr-test-agent su herdr -c 'mkdir -p ~/demo && ~/.local/bin/herdr pane run w1:p1 "cd ~/demo && ~/.opencode/bin/opencode"'
    # then, from the app: Agent prompt → "Create a file named x.txt containing exactly: ok"
    docker exec herdr-test-agent su herdr -c 'cat ~/demo/x.txt'

Herdr lists opencode as an idle agent as soon as the process starts, before its TUI is drawn. Input sent
before then is silently lost, by the app and by `herdr agent prompt` alike. The image pre-installs
opencode's plugin deps so the TUI is up within a few seconds, not ~3 min. Wait for `herdr pane read w1:p1` to show it.
