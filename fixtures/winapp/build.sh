#!/usr/bin/env bash
# 캡처 테스트용 WinForms 픽스처 빌드. tools/zwwin/build.sh 와 같은 방식이다.
#
#   bash fixtures/winapp/build.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CSC="C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"

mkdir -p "$ROOT/bin"

SRC="$(cygpath -w "$ROOT/fixtures/winapp/Program.cs")"
OUT="$(cygpath -w "$ROOT/bin/zwfixture.exe")"

# -target:winexe 라야 콘솔 창이 따라 뜨지 않는다
MSYS_NO_PATHCONV=1 "$CSC" \
  -nologo \
  -target:winexe \
  "-out:$OUT" \
  -r:System.dll \
  -r:System.Drawing.dll \
  -r:System.Windows.Forms.dll \
  "$SRC"

echo "빌드 완료: $ROOT/bin/zwfixture.exe"
