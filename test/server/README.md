# Test servers

Test-only credentials (`herdr` / `herdr-test`); bound to localhost only. From the Android emulator the host is `10.0.2.2`.

| Container | Port | Purpose |
|-----------|------|---------|
| `herdr-test` | 2222 | Normal: Herdr running, stream-local forwarding allowed |
| `herdr-test-nofwd` | 2223 | `AllowStreamLocalForwarding no` → forwarding-prohibited error |
| `herdr-test-noherdr` | 2224 | Herdr not installed → install flow |

    test/server/up.sh            # build images and (re)start all three
    REGEN_HOST_KEYS=1 test/server/up.sh herdr-test   # new host key → host-key-changed path

Fake agent (drives working → blocked → working → idle):

    docker exec herdr-test su herdr -c '~/.local/bin/herdr pane run w1:p1 "fake-agent 5"'

It blocks on a `[y/n]` prompt; answer from the app (send text/keys) or with `herdr pane send-text`.
Key auth: append the app's public key to `/home/herdr/.ssh/authorized_keys` in the container.
