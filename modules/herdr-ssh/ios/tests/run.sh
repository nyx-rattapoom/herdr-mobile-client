#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${HERDR_TEST_SSH:?set HERDR_TEST_SSH=user:password@host:port}"
OUT="${TMPDIR:-/tmp}/herdr-ssh-ios-test"
OPENSSL_VERSION=3.6.2000
mkdir -p "$OUT"
FW="$OUT/OpenSSL.xcframework/macos-arm64_x86_64"
if [ ! -d "$FW/OpenSSL.framework" ]; then
  curl -sfL -o "$OUT/openssl.zip" \
    "https://github.com/krzyzanowskim/OpenSSL/releases/download/$OPENSSL_VERSION/OpenSSL.xcframework.zip"
  (cd "$OUT" && unzip -q -o openssl.zip)
fi
CFLAGS="-O1 -w -DHAVE_CONFIG_H=1 -DLIBSSH2_OPENSSL=1 -Ivendor/libssh2-config -Ivendor/libssh2/include -Ivendor/libssh2/src -Ishim -F$FW"
objs=""
for f in vendor/libssh2/src/*.c shim/*.c; do
  case "$(basename "$f")" in openssl.c|libgcrypt.c|mbedtls.c|wincng.c|os400qc3.c|agent_win.c) continue ;; esac
  o="$OUT/$(basename "$f" .c).o"
  if [ ! -f "$o" ] || [ "$f" -nt "$o" ]; then clang $CFLAGS -c "$f" -o "$o"; fi
  objs="$objs $o"
done
swiftc -O -import-objc-header tests/bridging.h -Ivendor/libssh2/include -Ishim -F"$FW" \
  SshSupport.swift SshSession.swift SshClient.swift tests/IntegrationTest.swift $objs \
  -framework OpenSSL -Xlinker -rpath -Xlinker "$FW" -o "$OUT/integration-test"
perl -e 'alarm 180; exec @ARGV' "$OUT/integration-test"
