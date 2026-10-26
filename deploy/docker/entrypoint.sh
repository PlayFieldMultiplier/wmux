#!/bin/sh
# Run the daemon in the foreground, start `wmux web` once it answers, and exit
# with the daemon so the container restarts when it dies.
#
# Environment:
#   WMUX_WEB_PORT       port inside the container (default 7681)
#   WMUX_ALLOW_HOST     the proxy's public host name(s), comma-separated
#   WMUX_ALLOW_INPUT    1 (default) lets paired devices type into terminals
#   WMUX_INSTALL_CLAUDE 1 (default) installs Claude Code on first start
set -eu

port="${WMUX_WEB_PORT:-7681}"

if [ "${WMUX_INSTALL_CLAUDE:-1}" = "1" ] && ! command -v claude >/dev/null 2>&1; then
  echo "Installing Claude Code into $HOME/.local (first start only)..."
  curl -fsSL https://claude.ai/install.sh | bash || echo "Claude Code install failed; continuing without it." >&2
fi
# Claude Code hooks, approval gate included, so tool approvals reach the browser.
if command -v claude >/dev/null 2>&1; then
  wmux setup-hooks >/dev/null || echo "wmux setup-hooks failed; remote approvals are off." >&2
fi

wmux daemon run &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null; wait "$daemon"; exit 0' TERM INT

tries=0
until wmux daemon status >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ] || ! kill -0 "$daemon" 2>/dev/null; then
    echo "wmux daemon did not come up." >&2
    exit 1
  fi
  sleep 1
done

set -- web --expose --port "$port"
[ "${WMUX_ALLOW_INPUT:-1}" = "1" ] && set -- "$@" --allow-input
if [ -n "${WMUX_ALLOW_HOST:-}" ]; then
  old_ifs=$IFS; IFS=,
  for h in $WMUX_ALLOW_HOST; do set -- "$@" --allow-host "$h"; done
  IFS=$old_ifs
fi
wmux "$@"

wait "$daemon"
