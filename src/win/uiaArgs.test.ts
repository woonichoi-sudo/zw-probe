// uia 인자 조립 — 순수 단위 시험.
//
// 가상 클릭을 이름으로 할 때(click --name --virtual) UIA 좌표가 캡처 픽셀과 같은 계여야 한다. zwwin.exe 는
// 기본으로 시스템 DPI 인식이라 배율이 다른 모니터에서 UIA 좌표가 배율만큼 작게 나온다 — 2026-11-15 실앱(250% 모니터
// Z-Weave)에서 `click --name Help --virtual` 이 Window 메뉴를 열었다. --per-monitor 면 zwwin 이 PMv2 로 읽는다.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { uiaArgs } from './zwwin.ts'

test('uiaArgs — 기본은 그대로, perMonitor 면 --per-monitor', () => {
  assert.deepEqual(uiaArgs({ process: 'z-weave' }), ['uia', '--process', 'z-weave'])
  assert.deepEqual(uiaArgs({ pid: 7, depth: 3, max: 9, perMonitor: true }), ['uia', '--pid', '7', '--depth', '3', '--max', '9', '--per-monitor'])
})
