// 1단 순수 단위 테스트 — `zwprobe mouse` 의 플래그 → 이벤트 목록.
//
//   node --test src/input/mouseArgs.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { needsWidgetSize, planMouse } from './mouseArgs.ts'

const f = (o: Record<string, string>) => new Map(Object.entries(o))

test('planMouse — --from·--to 는 끌기. steps 기본 10', () => {
  const r = planMouse(f({ object: '2dview', from: '10,20', to: '110,20' }))
  assert.ok(r.ok, r.ok ? '' : r.error)
  if (!r.ok) return
  assert.equal(r.objectName, '2dview')
  assert.equal(r.events.length, 12)
  assert.deepEqual(r.events[0], { type: 'press', x: 10, y: 20, button: 'left' })
  assert.deepEqual(r.events[1], { type: 'move', x: 20, y: 20, button: 'left' })
  assert.deepEqual(r.events[11], { type: 'release', x: 110, y: 20, button: 'left' })
})

test('planMouse — --at 은 클릭 (누름·뗌, move 없음)', () => {
  const r = planMouse(f({ object: '2dview', at: '5,6' }))
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.events, [
    { type: 'press', x: 5, y: 6, button: 'left' },
    { type: 'release', x: 5, y: 6, button: 'left' },
  ])
})

test('planMouse — 수정키·버튼·steps 가 실린다', () => {
  const r = planMouse(f({ object: 'p', from: '0,0', to: '4,0', steps: '2', button: 'middle', shift: '', ctrl: '' }))
  assert.ok(r.ok)
  if (!r.ok) return
  assert.equal(r.events.length, 4)
  assert.ok(r.events.every((e) => e.button === 'middle' && e.modifiers?.shift === true && e.modifiers?.ctrl === true && e.modifiers?.alt === undefined))
})

test('planMouse — --events 는 JSON 배열을 그대로 쓴다', () => {
  const ev = [{ type: 'move', x: 1, y: 2, button: 'left' }]
  const r = planMouse(f({ object: 'p', events: JSON.stringify(ev) }))
  assert.ok(r.ok)
  if (r.ok) assert.deepEqual(r.events, ev)
})

test('planMouse — --world reset 은 월드 cm 를 리셋 카메라로 위젯 px 로 바꾼다', () => {
  // 800x600 리셋 카메라: (0,90) → (400,300), (11,90) → (430,300) — view2d.test.ts 와 같은 정답
  const flags = f({ object: '2dview', from: '0,90', to: '11,90', steps: '1', world: 'reset' })
  assert.equal(needsWidgetSize(flags), true)
  const r = planMouse(flags, { width: 800, height: 600 })
  assert.ok(r.ok, r.ok ? '' : r.error)
  if (!r.ok) return
  assert.ok(Math.abs(r.events[0]!.x - 400) < 1e-9 && Math.abs(r.events[0]!.y - 300) < 1e-9)
  assert.ok(Math.abs(r.events[2]!.x - 430) < 1e-9 && Math.abs(r.events[2]!.y - 300) < 1e-9)
  assert.deepEqual(r.camera, { cx: 0, cy: 90, filmHeight: 220, width: 800, height: 600 })
})

test('needsWidgetSize — 월드 좌표가 아니면 크기가 필요 없다', () => {
  assert.equal(needsWidgetSize(f({ object: 'p', at: '1,1' })), false)
})

test('planMouse — 거부: 무엇을 할지가 하나로 정해지지 않으면', () => {
  const bad: Array<[Record<string, string>, RegExp]> = [
    [{ at: '1,1' }, /object/],
    [{ object: 'p' }, /--at|--from|--events/],
    [{ object: 'p', at: '1,1', from: '1,1', to: '2,2' }, /하나만/],
    [{ object: 'p', from: '1,1' }, /--to/],
    [{ object: 'p', at: '1,x' }, /x,y/],
    [{ object: 'p', at: '1,1', button: 'side' }, /button/],
    [{ object: 'p', from: '0,0', to: '1,1', steps: '0' }, /steps/],
    [{ object: 'p', events: '{"a":1}' }, /배열/],
    [{ object: 'p', events: 'not json' }, /JSON/],
    [{ object: 'p', at: '1,1', world: 'fit' }, /reset/],
  ]
  for (const [o, why] of bad) {
    const r = planMouse(f(o))
    assert.equal(r.ok, false, JSON.stringify(o))
    if (!r.ok) assert.match(r.error, why, JSON.stringify(o))
  }
  // 월드 좌표인데 크기를 안 줬다 — 지어내지 않는다
  const r = planMouse(f({ object: 'p', at: '1,1', world: 'reset' }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /크기/)
})

test('planMouse — 오른쪽 버튼(문맥 메뉴 — 2D 메뉴는 popup 이라 응답을 막지 않는다)', () => {
  const r = planMouse(f({ object: 'p', at: '3,4', button: 'right' }))
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(r.events.length === 2 && r.events.every((e) => e.button === 'right'))
})
