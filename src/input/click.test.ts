// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/input/click.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeClick } from './click.ts'
import type { ClickResult } from '../win/zwwin.ts'
import type { WindowInfo } from '../win/zwwin.ts'

const TARGET_HWND = 4242

function targetWindow(): WindowInfo {
  return {
    hwnd: TARGET_HWND,
    pid: 100,
    title: 'z-weave',
    class: 'Qt5156dQWindowIcon',
    minimized: false,
    owner: 0,
    enabled: true,
    style: 0x9740_0000,
    exStyle: 0x100,
    fileVersion: '5.0.34',
    exePath: 'C:\\z-weave.exe',
    x: 0,
    y: 0,
    width: 1920,
    height: 1040,
  }
}

/** 성공한 클릭 결과. 각 테스트가 한 곳만 무너뜨린다. */
function result(p: Partial<ClickResult> = {}): ClickResult {
  return {
    button: 'left',
    double: false,
    x: 100,
    y: 200,
    screenX: 100,
    screenY: 200,
    activated: true,
    moved: true,
    foregroundAfter: TARGET_HWND,
    hwndAtPoint: 9999, // 자식 위젯일 수 있으므로 대상 hwnd 와 달라도 정상이다
    rootAtPoint: TARGET_HWND,
    cursorRestored: true,
    window: targetWindow(),
    ...p,
  }
}

test('judgeClick — 최상위 조상이 대상이면 정상. 자식 위젯 hwnd 는 달라도 된다', () => {
  const v = judgeClick(result())
  assert.equal(v.onTarget, true)
  assert.match(v.reason, /\(100,200\)/)
})

test('judgeClick — 커서를 못 옮기면 누른 자리를 알 수 없다', () => {
  const v = judgeClick(result({ moved: false }))
  assert.equal(v.onTarget, false)
  assert.match(v.reason, /SetCursorPos/)
})

test('judgeClick — 그 자리에 창이 없으면 실패', () => {
  const v = judgeClick(result({ hwndAtPoint: 0, rootAtPoint: 0 }))
  assert.equal(v.onTarget, false)
  assert.match(v.reason, /창이 없다/)
})

test('judgeClick — 다른 창이 가리고 있으면 실패로 잡는다', () => {
  // 캡처는 가려진 창도 잡지만 클릭은 못 뚫는다. 이 비대칭이 조용히 틀리는 지점이다.
  const v = judgeClick(result({ rootAtPoint: 777 }))
  assert.equal(v.onTarget, false)
  assert.match(v.reason, /가려져 있다/)
  assert.match(v.reason, /777/)
  assert.match(v.reason, /4242/)
})

test('judgeClick — 좌표는 맞아도 포그라운드를 못 잡으면 의심한다', () => {
  // 첫 클릭이 창 활성화로만 소비되는 흔한 패턴이라 성공으로 볼 수 없다.
  const v = judgeClick(result({ activated: false }))
  assert.equal(v.onTarget, false)
  assert.match(v.reason, /포그라운드/)
})

test('judgeClick — 가려짐을 포그라운드 실패보다 먼저 보고한다', () => {
  // 둘이 같이 틀렸을 때 더 근본적인 원인을 말해야 한다.
  const v = judgeClick(result({ rootAtPoint: 777, activated: false }))
  assert.match(v.reason, /가려져 있다/)
})
