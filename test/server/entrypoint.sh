#!/bin/sh
set -e
# Start a persistent Herdr server for the test user inside a detached tmux pty.
su herdr -c 'cd ~ && TERM=xterm-256color tmux new-session -d -s host "$HOME/.local/bin/herdr"'
exec /usr/sbin/sshd -D -e
