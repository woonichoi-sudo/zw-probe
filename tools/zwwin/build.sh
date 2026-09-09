#!/usr/bin/env bash
# zwwin.exe 빌드. .NET SDK 없이 Windows 내장 csc.exe 만 쓴다.
#
#   bash tools/zwwin/build.sh
#
# Git Bash 가 csc 의 인자를 유닉스 경로로 변환해버리므로(`/nologo` → `C:/Program Files/Git/nologo`)
# 옵션은 대시 형태로 주고, 경로는 cygpath 로 Windows 형태로 바꿔 넘긴다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CSC="C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"

if [[ ! -x "$CSC" ]]; then
  echo "csc.exe 를 찾을 수 없다: $CSC" >&2
  exit 1
fi

mkdir -p "$ROOT/bin"

SRC="$(cygpath -w "$ROOT/tools/zwwin/Program.cs")"
OUT="$(cygpath -w "$ROOT/bin/zwwin.exe")"

MSYS_NO_PATHCONV=1 "$CSC" \
  -nologo \
  -target:exe \
  -optimize+ \
  "-out:$OUT" \
  -r:System.dll \
  -r:System.Drawing.dll \
  "$SRC"

echo "빌드 완료: $ROOT/bin/zwwin.exe"
