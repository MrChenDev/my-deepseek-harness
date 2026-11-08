#!/usr/bin/env bash
# 安装/升级 dshmarket（Linux / macOS 入口）。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/install-dshmarket.mjs" "$@"
