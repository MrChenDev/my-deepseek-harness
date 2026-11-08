#!/usr/bin/env bash
# 升级 dsh profile 插件（Linux / macOS 入口）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/upgrade-plugins.mjs" "$@"
