#!/bin/sh
set -e
# Optionally regenerate host keys (exercises the host-key-changed path).
if [ "${REGEN_HOST_KEYS:-0}" = 1 ]; then rm -f /etc/ssh/ssh_host_*; ssh-keygen -A; fi
# Start a persistent Herdr server for the test user inside a detached tmux pty, if installed.
if [ -x /home/herdr/.local/bin/herdr ]; then
  su herdr -c 'cd ~ && TERM=xterm-256color tmux new-session -d -s host "$HOME/.local/bin/herdr"'
fi
exec /usr/sbin/sshd -D -e
