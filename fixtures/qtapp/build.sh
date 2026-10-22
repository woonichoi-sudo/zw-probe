#!/usr/bin/env bash
# Qt 픽스처 앱 빌드. qmake + nmake 를 vcvars 안에서 돌린다.
#
#   bash fixtures/qtapp/build.sh
#
# **왜 qmake 를 쓰는가.** include/lib 경로와 디버그 접미사(Qt5Cored.lib)와 moc 를
# 손으로 챙기면 틀리기 쉽다. qmake 가 그것을 다 안다. zwwin 은 csc.exe 한 줄이라
# 직접 불렀지만 Qt 는 그렇게 되지 않는다.
#
# **디버그로 빌드한다.** 대상 앱이 Qt5Cored.dll 을 쓰므로 플러그인이 디버그여야 하고,
# 플러그인을 얹을 픽스처도 같은 구성이어야 한다.
#
# **cmd 호출에서 두 번 걸렸다 (2026-09-09 실측). 둘 다 조용히 실패한다.**
#   ① `MSYS_NO_PATHCONV=1 cmd //c` — cmd 가 `//c` 를 스위치로 못 읽어 **대화형으로
#      입력을 기다린다.** 빌드가 멈춘 채 아무 출력도 없다
#   ② `cmd /c "... \"경로\" ..."` — MSYS 가 인자 안의 따옴표를 `\"` 로 재이스케이프해
#      cmd 에 리터럴 백슬래시가 간다
# 그래서 **인용을 .bat 파일 안으로 옮긴다.** cmd 에 넘기는 인자에 따옴표를 두지 않는다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QT="$(bash "$ROOT/tools/zweave-root.sh")/external/Qt-5.15.6-lts-lgpl-msvc2019_64"
VCVARS="C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvars64.bat"

for p in "$QT/bin/qmake.exe" "$VCVARS"; do
  if [[ ! -f "$p" ]]; then
    echo "찾을 수 없다: $p" >&2
    exit 1
  fi
done

BUILD="$ROOT/build/qtapp"
mkdir -p "$ROOT/bin" "$BUILD"

# 생성되는 .bat 은 build/ 안에 두어 커밋되지 않는다. 경로가 PC마다 다르므로
# 체크인하지 않고 매번 만든다.
cat > "$BUILD/build.bat" <<BATEOF
@echo off
call "$(cygpath -w "$VCVARS")" >nul || exit /b 1
cd /d "$(cygpath -w "$BUILD")" || exit /b 1
"$(cygpath -w "$QT/bin/qmake.exe")" "$(cygpath -w "$ROOT/fixtures/qtapp/qtapp.pro")" -spec win32-msvc CONFIG+=debug || exit /b 1
nmake /NOLOGO || exit /b 1
BATEOF

MSYS_NO_PATHCONV=1 cmd /c "$(cygpath -w "$BUILD/build.bat")"

if [[ ! -f "$ROOT/bin/zwqtfixture.exe" ]]; then
  echo "빌드가 zwqtfixture.exe 를 만들지 못했다" >&2
  exit 1
fi

echo
echo "빌드 완료: $ROOT/bin/zwqtfixture.exe"
echo "실행은 bash fixtures/qtapp/run.sh [--modal|--modeless] — Qt DLL·플러그인 경로를 세팅한다"
