# Local changes to libssh2 1.11.1

Upstream: https://libssh2.org/download/libssh2-1.11.1.tar.gz (SHA-256
d9ec76cbe34db98eec3539fe2c899d26b0c837cb3eb466a56b0f109cabf658f7). Only `src/` and `include/` are vendored,
plus `COPYING`.

- `src/transport.c` (`_libssh2_transport_send`): a call that continues the pending half-sent packet completes it
  before the key re-exchange redirect. Without this, a server rekey that arrives while a channel packet is
  half-sent deadlocks a non-blocking session (see docs/SPIKE.md §6).

Search for `herdr-client patch` to find it.
