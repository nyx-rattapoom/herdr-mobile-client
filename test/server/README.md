# Test server

    docker build -t herdr-test-server test/server
    docker run -d --name herdr-test -p 127.0.0.1:2222:22 herdr-test-server

SSH: `herdr@localhost:2222` (password `herdr-test`). From the Android emulator: `10.0.2.2:2222`.
Test-only credentials; never expose this container beyond localhost.
