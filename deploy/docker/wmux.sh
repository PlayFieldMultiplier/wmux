#!/bin/sh
# `wmux` on PATH inside the container: the CLI from the bundled runtime.
exec /opt/wmux/node/bin/node /opt/wmux/resources/cli-bundle/index.js "$@"
