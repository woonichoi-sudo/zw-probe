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

# UIAutomation 은 .NET Framework 에 들어 있지만 참조 어셈블리 폴더에는 없다.
# GAC 의 실물 DLL 을 직접 참조한다 — .NET SDK 가 없어도 이 경로는 항상 있다.
# System.Windows.Rect(BoundingRectangle 의 타입)가 WindowsBase 에 있어 셋이 다 필요하다.
GAC="C:/Windows/Microsoft.NET/assembly/GAC_MSIL"
UIA_REFS=()
for asm in UIAutomationClient UIAutomationTypes WindowsBase; do
  dll="$(find "$GAC/$asm" -name "$asm.dll" 2>/dev/null | head -1)"
  if [[ -z "$dll" ]]; then
    echo "$asm.dll 을 GAC 에서 찾을 수 없다: $GAC/$asm" >&2
    exit 1
  fi
  UIA_REFS+=("-r:$(cygpath -w "$dll")")
done

MSYS_NO_PATHCONV=1 "$CSC" \
  -nologo \
  -target:exe \
  -optimize+ \
  "-out:$OUT" \
  -r:System.dll \
  -r:System.Drawing.dll \
  "${UIA_REFS[@]}" \
  "$SRC"

echo "빌드 완료: $ROOT/bin/zwwin.exe"
