#!/usr/bin/env bash
# zwmac-encode (Swift) 빌드 — macOS 의 녹화 인코더. Xcode 명령줄 도구의 swiftc 만 있으면 된다.
#
#   bash tools/zwmac/build.sh   → bin/zwmac-encode
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then echo "macOS 전용이다." >&2; exit 1; fi
mkdir -p "$ROOT/bin"
swiftc -O -o "$ROOT/bin/zwmac-encode" "$ROOT/tools/zwmac/encode.swift"
echo "빌드 완료: $ROOT/bin/zwmac-encode"
