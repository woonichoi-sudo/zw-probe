#!/usr/bin/env bash
# Z-Weave 를 `zwagent.dll` 을 얹어 띄운다.
#
#   bash tools/launch-zweave.sh [--debug-plugins]
#
# **대상 앱 리포에 아무것도 두지 않는다** (절대 규칙 2). `QT_PLUGIN_PATH` 로 이 리포의
# `bin/plugins` 를 가리키므로 복사할 것이 없다.
#
# **cmd 를 거치는 이유.** bash 에서 exe 를 직접 부르면 Qt 가 인자를 제대로 못 받는
# 경우가 있고, 무엇보다 `start` 로 띄워야 이 스크립트가 바로 돌아온다. cmd 호출에는
# 함정이 둘 있어서(CLAUDE.md "구성요소") **인용을 생성된 .bat 안으로 옮긴다.**
#   ① `cmd //c` 는 cmd 가 스위치로 못 읽어 대화형으로 멈춘다
#   ② `cmd /c "... \"경로\" ..."` 는 MSYS 가 따옴표를 재이스케이프해 깨진다
#
# 앱이 뜬 뒤 **위젯 트리가 정착하기까지 90초쯤 걸린다** (실측). 그 전에는 hello 파일이
# 없다 — 스플래시가 65초 떠 있고 그 동안 위젯이 계속 늘어나기 때문이다.
# 기다리는 것은 `bash tools/wait-zweave.sh` 가 한다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXE="$(bash "$ROOT/tools/zweave-root.sh")/cmake_build/bin/Debug/z-weave.exe"
DLL="$ROOT/bin/plugins/styles/zwagent.dll"
HELLO="$ROOT/runs/zwagent-hello.json"

if [[ ! -f "$EXE" ]]; then
  echo "대상 앱을 찾을 수 없다: $EXE" >&2
  exit 1
fi
if [[ ! -f "$DLL" ]]; then
  echo "zwagent.dll 이 없다: $DLL" >&2
  echo "  bash tools/zwagent/build.sh 를 먼저 실행한다." >&2
  exit 1
fi

DRY=0
DEBUG=0
for a in "$@"; do
  case "$a" in
    # 띄우지 않고 생성될 .bat 만 보여준다. **인용이 이 스크립트의 유일한 위험
    # 지점이므로** 앱을 재시작하지 않고 그것만 확인할 수 있어야 한다.
    --print) DRY=1 ;;
    --debug-plugins) DEBUG=1 ;;
    *) echo "모르는 인자: $a" >&2; exit 1 ;;
  esac
done

if [[ $DRY -eq 0 ]] && tasklist //FI "IMAGENAME eq z-weave.exe" 2>/dev/null | grep -qi "z-weave.exe"; then
  echo "z-weave.exe 가 이미 실행 중이다." >&2
  echo "  플러그인을 얹으려면 먼저 닫아야 한다 — 이미 얹혀 있는지는" >&2
  echo "  node src/cli.ts agent 의 \"채널\" 줄이 말해준다." >&2
  exit 1
fi

# 앞선 실행의 hello 를 지운다. **안 지우면 낡은 스냅샷을 새 것으로 착각한다** —
# pid 가 다르면 파이프도 안 열리는데 파일은 그럴듯해 보인다.
if [[ $DRY -eq 0 ]]; then rm -f "$HELLO"; fi

DEBUG_LINE=""
if [[ $DEBUG -eq 1 ]]; then
  # Qt 는 디버그/릴리스가 안 맞으면 조용히 로드를 건너뛴다. 이걸 켜야 이유가 보인다.
  # 다만 GUI 앱이라 stderr 가 아니라 OutputDebugString 으로 나간다.
  DEBUG_LINE="set QT_DEBUG_PLUGINS=1"
fi

BAT="$ROOT/build/launch-zweave.bat"
mkdir -p "$ROOT/build" "$ROOT/runs"
cat > "$BAT" <<BATEOF
@echo off
set QT_PLUGIN_PATH=$(cygpath -w "$ROOT/bin/plugins")
set ZWAGENT_HELLO=$(cygpath -w "$HELLO")
$DEBUG_LINE
start "" "$(cygpath -w "$EXE")" -style zwagent
BATEOF

if [[ $DRY -eq 1 ]]; then
  echo "생성될 $BAT:"
  echo "---"
  cat "$BAT"
  echo "---"
  echo "(--print 이므로 띄우지 않았다)"
  exit 0
fi

MSYS_NO_PATHCONV=1 cmd /c "$(cygpath -w "$BAT")"

echo "띄웠다. 위젯 트리 정착까지 90초쯤 걸린다."
echo "  기다리기: bash tools/wait-zweave.sh"
echo "  확인:     node src/cli.ts agent"
