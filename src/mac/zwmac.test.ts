import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WS, judgeActivity } from '../win/windowState.ts'
import { filterWindows, toWindowInfo } from './zwmac.ts'
import type { AgentWindow } from './zwmac.ts'

const app = { pid: 7, appVersion: '5.1.84', appFilePath: '/x/cmake_build/bin/Debug/z-weave' }

function aw(p: Partial<AgentWindow>): AgentWindow {
  return {
    id: 1, owner: 0, title: '', class: 'QWidget', objectName: '', enabled: true, blocked: false, modal: false,
    popup: false, toolTip: false, active: false, minimized: false, x: 0, y: 0, width: 100, height: 100, dpr: 2, ...p,
  }
}

test('toWindowInfo — 모달에 막힌 창은 enabled=false + WS_DISABLED (Windows 의 Qt 모달과 같은 모양)', () => {
  const w = toWindowInfo(aw({ blocked: true }), app)
  assert.equal(w.enabled, false)
  assert.ok((w.style & WS.DISABLED) !== 0)
  assert.equal(w.fileVersion, '5.1.84')
})

test('toWindowInfo + judgeActivity — 메인 소유 다이얼로그가 있으면 busy, 없으면 idle', () => {
  const main = aw({ id: 10, class: 'zwQtMainWindow', width: 1512, height: 831 })
  const splash = aw({ id: 20, owner: 10, class: 'zwQtStartupSplashDialog', width: 602, height: 502 })
  assert.equal(judgeActivity([main, splash].map((x) => toWindowInfo(x, app))).state, 'busy')
  assert.equal(judgeActivity([toWindowInfo(main, app)]).state, 'idle')
})

test('filterWindows — 프로세스 이름(경로의 끝), 제목 부분 일치, 넓은 순', () => {
  const small = toWindowInfo(aw({ id: 1, title: 'Startup Splash', width: 10, height: 10 }), app)
  const big = toWindowInfo(aw({ id: 2, title: 'Untitled.zls', width: 100, height: 100 }), app)
  assert.deepEqual(filterWindows([small, big], { process: 'z-weave' }).map((w) => w.hwnd), [2, 1])
  assert.deepEqual(filterWindows([small, big], { process: 'z-weave.exe' }).map((w) => w.hwnd), [2, 1])
  assert.deepEqual(filterWindows([small, big], { process: 'other' }), [])
  assert.deepEqual(filterWindows([small, big], { title: 'splash' }).map((w) => w.hwnd), [1])
})
