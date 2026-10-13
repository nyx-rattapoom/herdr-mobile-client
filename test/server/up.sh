#!/bin/sh
# Build and (re)start test servers. Usage: up.sh [container ...]  (default: all)
set -e
cd "$(dirname "$0")"
docker build -q -t herdr-test-server . >/dev/null
docker build -q -t herdr-test-server:nofwd --build-arg STREAMLOCAL=no . >/dev/null
docker build -q -t herdr-test-server:noherdr --build-arg INSTALL_HERDR=0 . >/dev/null
docker build -q -t herdr-test-server:agent --build-arg INSTALL_OPENCODE=1 . >/dev/null
docker build -q -t herdr-test-server:old --build-arg HERDR_VERSION=0.7.5 . >/dev/null
start() { docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" -e REGEN_HOST_KEYS="${REGEN_HOST_KEYS:-0}" -p "127.0.0.1:$2:22" "$3" >/dev/null
  echo "$1 127.0.0.1:$2"; }
for c in ${@:-herdr-test herdr-test-nofwd herdr-test-noherdr herdr-test-agent herdr-test-old}; do
  case "$c" in
    herdr-test) start herdr-test 2222 herdr-test-server ;;
    herdr-test-nofwd) start herdr-test-nofwd 2223 herdr-test-server:nofwd ;;
    herdr-test-noherdr) start herdr-test-noherdr 2224 herdr-test-server:noherdr ;;
    herdr-test-agent) start herdr-test-agent 2225 herdr-test-server:agent ;;
    herdr-test-old) start herdr-test-old 2226 herdr-test-server:old ;;
  esac
done
