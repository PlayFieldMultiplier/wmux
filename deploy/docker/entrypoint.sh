#!/bin/sh
# Start the daemon and `wmux web`, then stay in the foreground for as long as
# the daemon lives, so the container restarts when the daemon dies.
#
# Environment:
#   WMUX_WEB_PORT      port inside the container (default 7681)
#   WMUX_ALLOW_HOST    the proxy's public host name(s), comma-separated
#   WMUX_ALLOW_INPUT   1 (default) lets paired devices type into terminals
#   WMUX_INSTALL_CLAUDE 1 (default) installs Claude Code on first start
set -eu

port="${WMUX_WEB_PORT:-7681}"

if [ "${WMUX_INSTALL_CLAUDE:-1}" = "1" ] && ! command -v claude >/dev/null 2>&1; then
  echo "Installing Claude Code into $HOME/.local (first start only)..."
  curl -fsSL https://claude.ai/install.sh | bash || echo "Claude Code install failed; continuing without it." >&2
fi

wmux daemon start

set -- web --expose --port "$port"
[ "${WMUX_ALLOW_INPUT:-1}" = "1" ] && set -- "$@" --allow-input
if [ -n "${WMUX_ALLOW_HOST:-}" ]; then
  old_ifs=$IFS; IFS=,
  for h in $WMUX_ALLOW_HOST; do set -- "$@" --allow-host "$h"; done
  IFS=$old_ifs
fi
wmux "$@"

trap 'wmux daemon stop >/dev/null 2>&1; exit 0' TERM INT
while wmux daemon status >/dev/null 2>&1; do
  sleep 30 &
  wait $! || true
done
echo "wmux daemon is gone; exiting." >&2
exit 1
