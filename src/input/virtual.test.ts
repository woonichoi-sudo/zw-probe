// 가상 커서 입력(virtual.ts)의 인자 조립과 판정 — 순수 단위 시험.
//
// 정답은 구현이 아니라 계약에서 온다: zwwin.exe 의 v* 동사가 받는 플래그(tools/zwwin/Virtual.cs 머리말)와
// "잘못된 요청은 보내기 전에 거부한다"(MCP 서버 절의 규칙 — 조용히 다른 명령을 조립하는 것이 가장 나쁜 실패).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeVirtual, textToHex, virtualArgs } from './virtual.ts'
import type { VirtualResult } from './virtual.ts'
import type { WindowInfo } from '../win/zwwin.ts'

test('click — 좌표·버튼·더블·누름 시간·수식키를 플래그로 옮긴다', () => {
  assert.deepEqual(virtualArgs({ op: 'click', x: 10, y: 20 }), ['vclick', '--x', '10', '--y', '20'])
  assert.deepEqual(
    virtualArgs({ op: 'click', x: 1, y: 2, button: 'right', double: true, holdMs: 300, mods: { ctrl: true, shift: true } }),
    ['vclick', '--x', '1', '--y', '2', '--button', 'right', '--double', '--hold', '300', '--ctrl', '--shift'],
  )
})

test('drag — 시작·끝 좌표와 단계 수를 옮긴다', () => {
  assert.deepEqual(
    virtualArgs({ op: 'drag', x: 5, y: 6, toX: 50, toY: 60 }),
    ['vdrag', '--x', '5', '--y', '6', '--to-x', '50', '--to-y', '60'],
  )
  assert.deepEqual(
    virtualArgs({ op: 'drag', x: 5, y: 6, toX: 50, toY: 60, steps: 4, button: 'middle', mods: { alt: true } }),
    ['vdrag', '--x', '5', '--y', '6', '--to-x', '50', '--to-y', '60', '--steps', '4', '--button', 'middle', '--alt'],
  )
})

test('wheel — 델타는 120 단위 그대로, 음수는 아래로', () => {
  assert.deepEqual(virtualArgs({ op: 'wheel', x: 3, y: 4, delta: -240 }), ['vwheel', '--x', '3', '--y', '4', '--delta', '-240'])
})

test('key — 가상 키 코드와 수식키', () => {
  assert.deepEqual(virtualArgs({ op: 'key', vk: 0x41, mods: { ctrl: true } }), ['vkey', '--vk', '65', '--ctrl'])
})

test('type — 글자는 UTF-16 16진수로 넘긴다 (한글·따옴표·"--" 로 시작하는 글자도 안전)', () => {
  assert.equal(textToHex('a한'), '0061d55c')
  assert.deepEqual(virtualArgs({ op: 'type', text: '--x "y"' }), ['vtype', '--text-hex', textToHex('--x "y"')])
})

test('move — 버튼 없이 옮긴다. 출발점을 주면 그 사이를 단계로 지난다 (마우스를 올려야 열리는 메뉴용)', () => {
  assert.deepEqual(virtualArgs({ op: 'move', x: 60, y: 70 }), ['vmove', '--x', '60', '--y', '70'])
  assert.deepEqual(
    virtualArgs({ op: 'move', x: 60, y: 70, fromX: 10, fromY: 20, steps: 4 }),
    ['vmove', '--x', '60', '--y', '70', '--from-x', '10', '--from-y', '20', '--steps', '4'],
  )
  assert.throws(() => virtualArgs({ op: 'move', x: 1, y: 1, fromX: 2 }), /from/)
  assert.throws(() => virtualArgs({ op: 'move', x: 1, y: 1, fromX: 2, fromY: 2, steps: 0 }), /steps/)
})

test('잘못된 요청은 보내기 전에 거부한다', () => {
  assert.throws(() => virtualArgs({ op: 'click', x: -1, y: 0 }), /좌표/)
  assert.throws(() => virtualArgs({ op: 'click', x: 1.5, y: 0 }), /좌표/)
  assert.throws(() => virtualArgs({ op: 'click', x: Number.NaN, y: 0 }), /좌표/)
  assert.throws(() => virtualArgs({ op: 'click', x: 1, y: 1, button: 'side' as 'left' }), /button/)
  assert.throws(() => virtualArgs({ op: 'click', x: 1, y: 1, holdMs: -5 }), /hold/)
  assert.throws(() => virtualArgs({ op: 'drag', x: 1, y: 1, toX: 2, toY: -2 }), /좌표/)
  assert.throws(() => virtualArgs({ op: 'drag', x: 1, y: 1, toX: 2, toY: 2, steps: 0 }), /steps/)
  assert.throws(() => virtualArgs({ op: 'wheel', x: 1, y: 1, delta: 0 }), /delta/)
  assert.throws(() => virtualArgs({ op: 'wheel', x: 1, y: 1, delta: 1.5 }), /delta/)
  assert.throws(() => virtualArgs({ op: 'key', vk: 0 }), /vk/)
  assert.throws(() => virtualArgs({ op: 'key', vk: 256 }), /vk/)
  assert.throws(() => virtualArgs({ op: 'type', text: '' }), /text/)
})

// ---- 판정 ----

const win = (hwnd: number, owner = 0, pid = 100): WindowInfo => ({
  hwnd, pid, title: 't', class: 'c', minimized: false, owner, enabled: true, style: 0, exStyle: 0,
  fileVersion: '', exePath: '', x: 0, y: 0, width: 400, height: 300,
})

const result = (target: Partial<VirtualResult['target']>, window = win(1)): VirtualResult => ({
  op: 'click',
  x: 10,
  y: 20,
  target: { hwnd: 11, root: 1, pid: 100, clientX: 10, clientY: 20, ...target },
  cursorBefore: { x: 5, y: 5 },
  cursorAfter: { x: 5, y: 5 },
  foregroundBefore: 77,
  foregroundAfter: 77,
  frame: false,
  window,
})

test('judgeVirtual — 대상 창(또는 그 자식)이 받으면 맞다', () => {
  assert.equal(judgeVirtual(result({})).onTarget, true)
})

test('judgeVirtual — 대상이 소유한 다이얼로그가 받으면 맞다 (실제 클릭과 같은 규칙)', () => {
  const before = [win(1), win(2, 1)]
  assert.equal(judgeVirtual(result({ root: 2 }), before).onTarget, true)
})

test('judgeVirtual — 다른 프로세스나 소유 관계 없는 창이 받으면 틀리다', () => {
  const other = judgeVirtual(result({ pid: 999 }))
  assert.equal(other.onTarget, false)
  assert.match(other.reason, /프로세스/)
  assert.equal(judgeVirtual(result({ root: 3 }), [win(1), win(3)]).onTarget, false)
})

test('judgeVirtual — 받은 창이 없으면(hwnd 0) 틀리다', () => {
  assert.equal(judgeVirtual(result({ hwnd: 0 })).onTarget, false)
})
