#!/usr/bin/env bash
# 一键同步 dsh 插件基线（Linux / macOS 入口）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/sync-dsh-profile.mjs" "$@"
