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

# **macOS (2026-10-12).** 대상 앱 Mac 디버그 빌드(Qt 6.5.3)를 백그라운드로 띄운다. cmd 함정이 없다.
if [[ "$(uname -s)" == "Darwin" ]]; then
  EXE="$(bash "$ROOT/tools/zweave-root.sh")/cmake_build/bin/Debug/z-weave"
  DYLIB="$ROOT/bin/plugins/styles/libzwagent_debug.dylib"
  HELLO="$ROOT/runs/zwagent-hello.json"
  [[ -x "$EXE" ]] || { echo "대상 앱을 찾을 수 없다: $EXE" >&2; exit 1; }
  [[ -f "$DYLIB" ]] || { echo "zwagent 가 없다: $DYLIB — bash tools/zwagent/build.sh 를 먼저 실행한다." >&2; exit 1; }
  DEBUG=0
  OPEN=""
  while [[ $# -gt 0 ]]; do
    a="$1"; shift
    case "$a" in
      # **파일을 열며 띄운다.** 메인 창이 첫 인자가 있는 파일이면 연다(zwQtMainWindow::InitLoadingFile)
      # — 파일 다이얼로그를 안 거치고, 최근 파일 목록에도 들어가 그 뒤로는 openRecent 가 닿는다.
      --open) [[ -f "${1:-}" ]] || { echo "열 파일이 없다: ${1:-}" >&2; exit 1; }; OPEN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; shift ;;
      --debug-plugins) DEBUG=1 ;;
      --print) echo "QT_PLUGIN_PATH=$ROOT/bin/plugins ZWAGENT_HELLO=$HELLO $EXE ${OPEN:+\"$OPEN\" }-style zwagent"; exit 0 ;;
      *) echo "모르는 인자: $a" >&2; exit 1 ;;
    esac
  done
  if pgrep -f "$EXE" >/dev/null; then
    echo "z-weave 가 이미 실행 중이다 (pid $(pgrep -f "$EXE" | tr "\\n" " ")). 플러그인을 얹으려면 먼저 닫는다." >&2
    exit 1
  fi
  # **단축키 파일의 버전 폴더를 만들어 둔다.** 앱은 시작할 때 shortcut.ini 기본값을 쓰는데 폴더를
  # 안 만들고 열어서(zwShortcutManager::WriteToDisk) macOS 에서는 조용히 실패한다. 버전은 가장
  # 로그 파일 이름(z-weave_<버전>_<시각>.log)에서 읽는다.
  SUPPORT="$HOME/Library/Application Support/z-emotion/z-weave"
  log_version() { basename "$1" | sed -E "s/^z-weave_([^_]+)_.*/\\1/"; }
  LAST_LOG="$(ls -t "$SUPPORT/log"/z-weave_*.log 2>/dev/null | head -1 || true)"
  if [[ -n "$LAST_LOG" ]]; then
    mkdir -p "$SUPPORT/$(log_version "$LAST_LOG")"
  fi
  mkdir -p "$ROOT/runs"
  rm -f "$HELLO"
  if [[ $DEBUG -eq 1 ]]; then export QT_DEBUG_PLUGINS=1; fi
  QT_PLUGIN_PATH="$ROOT/bin/plugins" ZWAGENT_HELLO="$HELLO" \
    nohup "$EXE" ${OPEN:+"$OPEN"} -style zwagent >"$ROOT/runs/zweave-stdout.log" 2>&1 &
  PID=$!
  # **띄운 앱의 버전이 다를 수 있다** — Z-Weave 를 새 버전으로 빌드한 뒤 처음 띄우면 위의 최근 로그는
  # 옛 버전이다(2026-10-23, 5.1.93 폴더만 만들고 5.1.101 앱이 shortcut.ini 를 못 썼다). 이번 실행의
  # 로그가 생기면 그 버전 폴더도 만든다. 실측 로그 생성 → shortcut.ini 쓰기가 8초라 그 안에 닿는다.
  for _ in $(seq 1 75); do
    NEW_LOG="$(ls -t "$SUPPORT/log"/z-weave_*.log 2>/dev/null | head -1 || true)"
    if [[ -n "$NEW_LOG" && "$NEW_LOG" != "$LAST_LOG" ]]; then
      VER="$(log_version "$NEW_LOG")"
      if [[ ! -d "$SUPPORT/$VER" ]]; then
        mkdir -p "$SUPPORT/$VER"
        echo "  새 버전 $VER 의 단축키 폴더를 만들었다. key 가 shortcut.ini 를 못 찾으면 앱을 다시 띄운다."
      fi
      break
    fi
    sleep 0.2
  done
  echo "띄웠다 (pid $PID). 위젯 트리 정착까지 기다린다: bash tools/wait-zweave.sh"
  echo "  앱의 stdout·stderr: runs/zweave-stdout.log"
  exit 0
fi
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
