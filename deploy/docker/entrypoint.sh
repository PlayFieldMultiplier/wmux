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
wmux "$@" >/dev/null

# The web UI starts from existing terminals, so a fresh home gets one, and the
# log names the address to open first (the token is the user's own secret).
json() { /opt/wmux/node/bin/node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String($1))})"; }
token=$(wmux web --status --json | json 'j.token')
api() { curl -fsS -H "Authorization: Bearer $token" -H "Origin: http://127.0.0.1:$port" -H 'Content-Type: application/json' "$@"; }
if [ "$(api "http://127.0.0.1:$port/api/sessions" | json 'j.sessions.length')" = "0" ]; then
  api -X POST -d '{"workspaceId":"ws-main","workspaceName":"main"}' "http://127.0.0.1:$port/api/sessions" >/dev/null \
    || echo "Could not create the first terminal." >&2
fi
if [ -n "${WMUX_ALLOW_HOST:-}" ]; then
  echo "wmux is ready. Open: https://${WMUX_ALLOW_HOST%%,*}/?token=$token"
else
  echo "wmux is ready on port $port. Token: $token"
fi

wait "$daemon"
