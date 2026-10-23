#!/usr/bin/env bash
# 대상 앱(Z-Weave) 리포의 위치를 /d/... 형태로 출력한다.
#
#   bash tools/zweave-root.sh
#
# `ZWEAVE_ROOT` 가 있으면 그것, 없으면 이 리포 옆의 `../Z-Weave`. src/win/zweaveRoot.ts 와
# 같은 규칙이다. /d/... 형태로 내는 이유: 부르는 스크립트가 `PATH="$QT/bin:$PATH"` 처럼
# 콜론으로 잇는데 `D:/...` 는 드라이브 콜론 때문에 PATH 가 깨진다.

set -euo pipefail

if [[ -n "${ZWEAVE_ROOT:-}" ]]; then
  # macOS 에는 cygpath 가 없고 경로도 이미 /... 형태다
  if command -v cygpath >/dev/null; then cygpath -u "$ZWEAVE_ROOT"; else echo "$ZWEAVE_ROOT"; fi
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "$(cd "$ROOT/.." && pwd)/Z-Weave"
fi
