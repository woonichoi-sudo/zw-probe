#!/usr/bin/env bash
# zwagent.dll (Qt 스타일 플러그인) 빌드.
#
#   bash tools/zwagent/build.sh
#
# 산출물: bin/plugins/styles/zwagent.dll
# Qt 는 QT_PLUGIN_PATH 의 각 경로 아래 `styles/` 에서 스타일 플러그인을 찾는다.
# 대상 앱 리포 안(Qt 의 plugins/styles)에 두지 않는다 — 절대 규칙 2.
#
# **디버그 구성이어야 한다.** 대상 앱이 Qt5Cored.dll 을 쓰고, Windows 에서
# 디버그/릴리스 CRT 는 섞이지 않는다. Qt 는 플러그인 메타데이터의 디버그 플래그가
# 안 맞으면 **조용히 로드를 건너뛴다** — QT_DEBUG_PLUGINS=1 로만 보인다.
#
# cmd 호출의 두 함정은 fixtures/qtapp/build.sh 머리말과 같다. 인용을 .bat 안으로 옮긴다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QT="/d/z-emotion/Z-Weave/external/Qt-5.15.6-lts-lgpl-msvc2019_64"
VCVARS="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat"

for p in "$QT/bin/qmake.exe" "$VCVARS"; do
  if [[ ! -f "$p" ]]; then
    echo "찾을 수 없다: $p" >&2
    exit 1
  fi
done

BUILD="$ROOT/build/zwagent"
OUT="$ROOT/bin/plugins/styles"
mkdir -p "$BUILD" "$OUT"

cat > "$BUILD/build.bat" <<BATEOF
@echo off
call "$(cygpath -w "$VCVARS")" >nul || exit /b 1
cd /d "$(cygpath -w "$BUILD")" || exit /b 1
"$(cygpath -w "$QT/bin/qmake.exe")" "$(cygpath -w "$ROOT/tools/zwagent/zwagent.pro")" -spec win32-msvc CONFIG+=debug || exit /b 1
nmake /NOLOGO || exit /b 1
BATEOF

MSYS_NO_PATHCONV=1 cmd /c "$(cygpath -w "$BUILD/build.bat")"

if [[ ! -f "$OUT/zwagent.dll" ]]; then
  echo "빌드가 zwagent.dll 을 만들지 못했다" >&2
  exit 1
fi

echo
echo "빌드 완료: $OUT/zwagent.dll"
echo "확인: bash fixtures/qtapp/run.sh -style zwagent  → \$TEMP/zwagent-hello.json"
