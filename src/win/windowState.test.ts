// 1단 순수 단위 테스트 — 의존성 0. 창 목록만 만들어 넣는다.
//
//   node --test src/win/windowState.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WS,
  WS_EX,
  classifyWindows,
  hasBit,
  isInteractive,
  judgeActivity,
  styleNames,
} from './windowState.ts'
import type { WindowInfo } from './zwwin.ts'

/** 창 하나를 만든다. 관심 없는 필드는 기본값으로 둔다. */
function win(p: Partial<WindowInfo> & { hwnd: number }): WindowInfo {
  return {
    hwnd: p.hwnd,
    pid: p.pid ?? 100,
    title: p.title ?? '',
    class: p.class ?? 'TestClass',
    minimized: p.minimized ?? false,
    owner: p.owner ?? 0,
    enabled: p.enabled ?? true,
    style: p.style ?? WS.VISIBLE,
    exStyle: p.exStyle ?? 0,
    fileVersion: p.fileVersion ?? '5.0.34',
    exePath: p.exePath ?? 'C:\\app.exe',
    x: p.x ?? 0,
    y: p.y ?? 0,
    width: p.width ?? 800,
    height: p.height ?? 600,
  }
}

test('hasBit — 0x80000000 도 옳게 읽는다', () => {
  // JS 비트 연산이 ToInt32 를 거쳐 음수가 나오는 구간이다. 여기가 틀리면
  // WS_POPUP 이 달린 모든 창의 판정이 조용히 뒤집힌다.
  assert.equal(hasBit(0x9740_0000, WS.POPUP), true)
  assert.equal(hasBit(0x1740_0000, WS.POPUP), false)
  assert.equal(hasBit(0x9740_0000, WS.VISIBLE), true)
  assert.equal(hasBit(0x9740_0000, WS.DISABLED), false)
})

test('styleNames — 실측한 대상 앱 스타일을 풀어낸다', () => {
  // 2026-09-09 실측: Z-Weave 메인 창 style=0x97CF0000 exStyle=0x100
  const names = styleNames(0x97cf_0000, 0x0000_0100)
  assert.deepEqual(names, [
    'POPUP',
    'VISIBLE',
    'CLIPSIBLINGS',
    'CLIPCHILDREN',
    'MAXIMIZE',
    'BORDER',
    'DLGFRAME',
    'SYSMENU',
    'THICKFRAME',
    'MINIMIZEBOX',
    'MAXIMIZEBOX',
    'EX_WINDOWEDGE',
  ])
})

test('styleNames — 켜진 비트가 없으면 빈 목록', () => {
  assert.deepEqual(styleNames(0, 0), [])
})

test('isInteractive — enabled 와 WS_DISABLED 를 함께 본다', () => {
  assert.equal(isInteractive(win({ hwnd: 1 })), true)
  assert.equal(isInteractive(win({ hwnd: 1, enabled: false })), false)
  // 둘이 어긋나면 보수적으로 본다 — 못 누르는 창에 키를 보내는 쪽이 더 나쁘다
  assert.equal(isInteractive(win({ hwnd: 1, style: WS.VISIBLE | WS.DISABLED })), false)
})

test('classifyWindows — 소유자가 목록 밖이면 뿌리다', () => {
  // WinForms 픽스처에서 실제로 걸린 경우(2026-09-09): 메인 창의 소유자가
  // 보이지 않는 parking 창(985184)이라 열거에 없다. owner===0 만 뿌리로 봤다면
  // 메인 창을 못 찾는다.
  const main = win({ hwnd: 10, owner: 985184, width: 400, height: 300 })
  const dialog = win({ hwnd: 20, owner: 10, width: 200, height: 80 })
  const c = classifyWindows([main, dialog])

  assert.equal(c.main?.hwnd, 10)
  assert.equal(c.extras.length, 1)
  assert.equal(c.extras[0]!.relation, 'owned-by-main')
})

test('classifyWindows — owner 0 인 창도 뿌리다', () => {
  // Z-Weave 메인 창은 owner===0 이다. 두 경우가 같은 규칙으로 맞아야 한다.
  const c = classifyWindows([win({ hwnd: 10, owner: 0 })])
  assert.equal(c.main?.hwnd, 10)
  assert.equal(c.extras.length, 0)
})

test('classifyWindows — 뿌리가 여럿이면 면적이 가장 큰 것', () => {
  const small = win({ hwnd: 10, width: 400, height: 300 })
  const big = win({ hwnd: 20, width: 1920, height: 1040 })
  const c = classifyWindows([small, big])
  assert.equal(c.main?.hwnd, 20)
  assert.equal(c.extras[0]!.relation, 'root')
})

test('classifyWindows — 최소화된 창은 더 크더라도 메인이 아니다', () => {
  // 최소화되면 사각형이 화면 밖 값이 되어 면적을 믿을 수 없다.
  const mini = win({ hwnd: 10, minimized: true, width: 3000, height: 3000 })
  const shown = win({ hwnd: 20, width: 400, height: 300 })
  assert.equal(classifyWindows([mini, shown]).main?.hwnd, 20)
})

test('classifyWindows — 면적이 같으면 hwnd 가 작은 쪽. 순서를 바꿔도 같은 답', () => {
  const a = win({ hwnd: 77 })
  const b = win({ hwnd: 12 })
  assert.equal(classifyWindows([a, b]).main?.hwnd, 12)
  assert.equal(classifyWindows([b, a]).main?.hwnd, 12)
})

test('classifyWindows — 다이얼로그가 띄운 다이얼로그는 owned-by-other', () => {
  const main = win({ hwnd: 10, width: 1920, height: 1040 })
  const dialog = win({ hwnd: 20, owner: 10, width: 400, height: 200 })
  const nested = win({ hwnd: 30, owner: 20, width: 300, height: 100 })
  const c = classifyWindows([main, dialog, nested])

  const byHwnd = new Map(c.extras.map((e) => [e.window.hwnd, e.relation]))
  assert.equal(byHwnd.get(20), 'owned-by-main')
  assert.equal(byHwnd.get(30), 'owned-by-other')
})

test('classifyWindows — 빈 목록', () => {
  const c = classifyWindows([])
  assert.equal(c.main, null)
  assert.deepEqual(c.extras, [])
})

test('judgeActivity — 메인 창만 있고 입력을 받으면 idle', () => {
  const a = judgeActivity([win({ hwnd: 10, title: 'z-weave' })])
  assert.equal(a.state, 'idle')
})

test('judgeActivity — 창이 없으면 unknown', () => {
  assert.equal(judgeActivity([]).state, 'unknown')
})

test('judgeActivity — 메인 창이 최소화면 busy', () => {
  const a = judgeActivity([win({ hwnd: 10, minimized: true })])
  assert.equal(a.state, 'busy')
  assert.match(a.reason, /최소화/)
})

test('judgeActivity — 모달이 소유자를 비활성으로 만든 경우', () => {
  // 픽스처 실측(2026-09-09): 모달이 뜨면 메인 창이 enabled=false + WS_DISABLED 가 된다.
  const main = win({ hwnd: 10, enabled: false, style: WS.VISIBLE | WS.DISABLED })
  const dialog = win({ hwnd: 20, owner: 10, width: 200, height: 80, title: '진행 중' })
  const a = judgeActivity([main, dialog])

  assert.equal(a.state, 'busy')
  assert.match(a.reason, /입력을 받지 않는다/)
  assert.equal(a.classified.extras.length, 1)
})

test('judgeActivity — 메인 창이 살아 있어도 다른 창이 있으면 busy', () => {
  // 비모달 다이얼로그. 메인 창은 눌리지만 시나리오가 예상한 화면이 아니다.
  const main = win({ hwnd: 10, width: 1920, height: 1040 })
  const dialog = win({ hwnd: 20, owner: 10, width: 360, height: 100, title: 'Loading..' })
  const a = judgeActivity([main, dialog])

  assert.equal(a.state, 'busy')
  assert.match(a.reason, /Loading\.\./)
  assert.match(a.reason, /360x100/)
})

test('judgeActivity — 이유에 창을 전부 싣는다', () => {
  const main = win({ hwnd: 10, width: 1920, height: 1040 })
  const d1 = win({ hwnd: 20, owner: 10, title: '첫째' })
  const d2 = win({ hwnd: 30, owner: 10, title: '둘째' })
  const a = judgeActivity([main, d1, d2])

  assert.match(a.reason, /2개/)
  assert.match(a.reason, /첫째/)
  assert.match(a.reason, /둘째/)
})

test('WS_EX 비트 이름이 겹치지 않는다', () => {
  // 같은 값에 두 이름을 달아두면 styleNames 가 늘 둘 다 뱉어 판정을 흐린다.
  const values = Object.values(WS_EX)
  assert.equal(new Set(values).size, values.length)
  const wsValues = Object.values(WS)
  assert.equal(new Set(wsValues).size, wsValues.length)
})
