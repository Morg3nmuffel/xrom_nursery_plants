#!/bin/zsh
cd -- "$(dirname "$0")" || exit 1
nursery_node="$(command -v node)"
if [[ -z "$nursery_node" ]]; then
  nursery_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$nursery_node" ]]; then
  print 'Установите Node.js 24.4 или новее и откройте этот файл ещё раз.'
  exit 1
fi
exec "$nursery_node" server.mjs --open
