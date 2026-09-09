#!/usr/bin/env bash
# Qt 픽스처 앱을 실행한다. Qt DLL 과 플러그인 경로를 세팅한다.
#
#   bash fixtures/qtapp/run.sh                  평범한 창
#   bash fixtures/qtapp/run.sh --modal          모달 다이얼로그를 띄운 상태
#   bash fixtures/qtapp/run.sh --modeless       비모달 다이얼로그를 띄운 상태
#   bash fixtures/qtapp/run.sh -style zwagent   스타일 플러그인을 얹어서
#
# **Qt 를 bin/ 에 복사하지 않는다.** 디버그 Qt DLL 은 크고, 대상 앱의 Qt 를 그대로
# 쓰는 것이 ABI 를 맞추는 가장 확실한 방법이다. 대신 환경변수로 가리킨다.
#
# **QT_PLUGIN_PATH 에 이 리포의 bin/plugins 를 먼저 둔다.** 스타일 플러그인을 Qt 의
# plugins/styles 에 넣으려면 대상 앱 리포 안에 파일을 만들어야 하는데, 절대 규칙 2가
# 그것을 금지한다. 경로를 두 개 주면 그럴 필요가 없다.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
QT="/d/z-emotion/Z-Weave/external/Qt-5.15.6-lts-lgpl-msvc2019_64"
EXE="$ROOT/bin/zwqtfixture.exe"

if [[ ! -f "$EXE" ]]; then
  echo "$EXE 가 없다. bash fixtures/qtapp/build.sh 를 먼저 실행한다." >&2
  exit 1
fi

export PATH="$QT/bin:$PATH"
export QT_PLUGIN_PATH="$(cygpath -w "$ROOT/bin/plugins");$(cygpath -w "$QT/plugins")"

exec "$EXE" "$@"
