// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/input/view2d.test.ts
//
// **정답은 Z-Weave 소스에서 손으로 계산한 값이다** — 구현을 돌려 받은 값이 아니다.
//   · 변환     Z-Weave/view_2d/zw2DCameraControlls.cpp:58-67 (GetTransform), :98-107 (CadToView — y 뒤집음)
//   · 리셋     zw2DCameraControlls.h:81-82 — 중심 (0, 90) cm, 필름 높이 220 cm
//   · 맞춤     zw2DCameraControlls.cpp:22-31 — 여백 = 상자 폭 × 0.2, 필름 높이 = max(H/W, 상자 h/w) × (폭 + 여백)
//   · 필름 폭  zw2DCameraControlls.cpp:124-129 — 필름 폭 = (W/H) × 필름 높이

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dragEvents, fitCamera, resetCamera, viewToWorld, worldToView } from './view2d.ts'

const close = (a: number, b: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} ≠ ${b}`)

test('resetCamera — 선택이 비었을 때의 Shift+F. 중심 (0,90) cm, 필름 높이 220 cm', () => {
  assert.deepEqual(resetCamera(800, 600), { cx: 0, cy: 90, filmHeight: 220, width: 800, height: 600 })
})

test('worldToView — 리셋 카메라 800x600. 축척 s = 600/220', () => {
  const cam = resetCamera(800, 600)
  const s = 600 / 220
  const at = (wx: number, wy: number) => worldToView(cam, { x: wx, y: wy })

  // 카메라 중심은 위젯 한가운데
  close(at(0, 90).x, 400, '중심 x')
  close(at(0, 90).y, 300, '중심 y')
  // 오른쪽 11 cm → 30 px 오른쪽
  close(at(11, 90).x, 430, '+x')
  close(at(11, 90).y, 300, '+x 의 y')
  // 위로 11 cm → 30 px **위**(화면 y 는 아래로 자란다)
  close(at(0, 101).x, 400, '+y 의 x')
  close(at(0, 101).y, 270, '+y')
  // 원점 = 중심에서 90 cm 아래
  close(at(0, 0).y, 300 + 90 * s, '원점 y')
})

test('viewToWorld — worldToView 의 역', () => {
  const cam = resetCamera(1234, 567)
  for (const p of [{ x: 0, y: 0 }, { x: -37.5, y: 12.25 }, { x: 100, y: 180 }]) {
    const back = viewToWorld(cam, worldToView(cam, p))
    close(back.x, p.x, 'x', 1e-9)
    close(back.y, p.y, 'y', 1e-9)
  }
  // 한가운데 픽셀 = 카메라 중심
  const c = viewToWorld(cam, { x: 617, y: 283.5 })
  close(c.x, 0, '중심 x', 1e-9)
  close(c.y, 90, '중심 y', 1e-9)
})

test('fitCamera — 선택이 있을 때의 Shift+F. 넓은 위젯이면 H/W 가 이긴다', () => {
  // 상자 x −50~50, y 0~40 (폭 100, 높이 40) · 위젯 800x600
  // 여백 20 → 0.75 × 120 = 90, 중심 (0, 20)
  const cam = fitCamera(800, 600, { minX: -50, minY: 0, maxX: 50, maxY: 40 })
  close(cam.filmHeight, 90, '필름 높이')
  close(cam.cx, 0, 'cx')
  close(cam.cy, 20, 'cy')
  assert.equal(cam.width, 800)
  assert.equal(cam.height, 600)
  // 상자 오른쪽 위 (50, 40): s = 600/90
  const p = worldToView(cam, { x: 50, y: 40 })
  close(p.x, 50 * (600 / 90) + 400, '오른쪽 위 x')
  close(p.y, (20 - 40) * (600 / 90) + 300, '오른쪽 위 y')
})

test('fitCamera — 상자가 키가 크면 상자 비율이 이긴다. 여백은 폭 기준 하나뿐', () => {
  // 상자 폭 10, 높이 40 · 위젯 800x600 → max(0.75, 4) × (10 + 2) = 48
  const cam = fitCamera(800, 600, { minX: 10, minY: -20, maxX: 20, maxY: 20 })
  close(cam.filmHeight, 48, '필름 높이')
  close(cam.cx, 15, 'cx')
  close(cam.cy, 0, 'cy')
})

test('dragEvents — 누름 하나, 끝점을 포함한 등간격 move N개, 뗌 하나', () => {
  const ev = dragEvents({ x: 10, y: 20 }, { x: 50, y: 100 }, { steps: 4 })
  assert.deepEqual(
    ev.map((e) => [e.type, e.x, e.y]),
    [
      ['press', 10, 20],
      ['move', 20, 40],
      ['move', 30, 60],
      ['move', 40, 80],
      ['move', 50, 100],
      ['release', 50, 100],
    ],
  )
  // 기본 버튼은 왼쪽, 수정키는 안 붙인다
  assert.ok(ev.every((e) => e.button === 'left' && e.modifiers === undefined))
})

test('dragEvents — 버튼·수정키가 모든 이벤트에 같이 실린다 (데스크톱은 move 마다 수정키를 읽는다)', () => {
  const ev = dragEvents({ x: 0, y: 0 }, { x: 3, y: 0 }, { steps: 3, button: 'middle', modifiers: { shift: true } })
  assert.equal(ev.length, 5)
  assert.ok(ev.every((e) => e.button === 'middle' && e.modifiers?.shift === true))
})

test('dragEvents — steps 는 1 이상의 정수여야 한다. 0 이면 누름 자리에서 떼는 클릭이 되므로 거부한다', () => {
  assert.throws(() => dragEvents({ x: 0, y: 0 }, { x: 1, y: 1 }, { steps: 0 }), /steps/)
  assert.throws(() => dragEvents({ x: 0, y: 0 }, { x: 1, y: 1 }, { steps: 2.5 }), /steps/)
})
