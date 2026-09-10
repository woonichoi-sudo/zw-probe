#!/usr/bin/env bash
# Z-Weave 의 위젯 트리가 정착할 때까지 기다린다.
#
#   bash tools/wait-zweave.sh [상한초]
#
# **왜 필요한가.** 앱을 띄우고 바로 물어보면 아무것도 없다. 스플래시가 65초 떠 있고
# 그 동안 위젯이 계속 늘어나므로 플러그인이 보고를 미룬다 — 실측 90초쯤에 hello 가
# 나온다. 앞선 세션에서 폴링 루프를 성급하게 짜서 "로드 실패" 로 오진할 뻔했다.
#
# 종료 코드: 0=정착, 1=상한 안에 안 나옴.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELLO="$ROOT/runs/zwagent-hello.json"
# **Windows 형식이어야 한다.** Node 는 MSYS 경로(`/d/...`)를 못 연다 — 이걸 안 바꾸면
# hello 가 멀쩡히 있어도 "정착하지 않았다" 가 나온다 (2026-09-10 에 실제로 겪었다).
HELLO_WIN="$(cygpath -w "$HELLO")"
LIMIT="${1:-180}"

started=$(date +%s)
while true; do
  now=$(date +%s)
  elapsed=$((now - started))
  if [[ -f "$HELLO" ]]; then
    # settled 까지 봐야 한다. 파일만 있고 정착 전이면 스플래시 시절 트리일 수 있다.
    # 경로는 환경변수로 넘긴다 — 스크립트 안에 끼워 넣으면 백슬래시가 이스케이프로 먹힌다.
    if ZWHELLO="$HELLO_WIN" node -e '
      const { readFileSync } = require("node:fs")
      let h
      try { h = JSON.parse(readFileSync(process.env.ZWHELLO, "utf8")) } catch { process.exit(1) }
      if (h.settled !== true) process.exit(1)
      const secs = Math.round((h.elapsedMs ?? 0) / 1000)
      console.log(`정착: 위젯 ${h.widgetTotal}개 · ${secs}초 · 파이프 ${h.pipeListening ? "열림" : "안 열림"}`)
    ' 2>/dev/null; then
      exit 0
    fi
  fi
  if (( elapsed >= LIMIT )); then
    echo "${LIMIT}초 안에 정착하지 않았다." >&2
    if [[ -f "$HELLO" ]]; then
      echo "  hello 는 있다 — 정착 전 스냅샷이다. 더 기다리거나 앱이 멈췄는지 본다." >&2
    else
      echo "  hello 가 없다. 플러그인이 로드되지 않았을 수 있다:" >&2
      echo "    bash tools/launch-zweave.sh --debug-plugins 로 다시 띄운다." >&2
    fi
    exit 1
  fi
  printf '\r  %d초 경과…' "$elapsed"
  sleep 5
done
