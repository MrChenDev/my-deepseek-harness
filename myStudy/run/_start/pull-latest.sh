#!/usr/bin/env bash
# 一键拉取最新代码（Linux / macOS 入口）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/pull-latest.mjs" "$@"
