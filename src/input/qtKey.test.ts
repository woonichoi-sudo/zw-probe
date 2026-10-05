// 1단 순수 단위 테스트 — Windows 가상키 → Qt 키.
//
//   node --test src/input/qtKey.test.ts
//
// 정답은 Qt 헤더 값이다 (external/Qt-5.15.6…/include/QtCore/qnamespace.h:604-688) —
// Key_Escape 0x01000000 · Tab …01 · Backspace …03 · Return …04 · Delete …07 ·
// Left …12 · Up …13 · Right …14 · Down …15 · F1 …30 · Space 0x20 · Comma 0x2c · Minus 0x2d.
// 글자·숫자는 Key_A=0x41 … 처럼 ASCII 대문자·숫자와 같다.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { toQtKey } from './qtKey.ts'
import { parseShortcut } from './shortcut.ts'

const k = (spec: string) => toQtKey(parseShortcut(spec))

test('toQtKey — 글자는 ASCII 대문자 값, text 는 Shift 에 따라 소문자/대문자', () => {
  assert.deepEqual(k('S'), { key: 0x53, text: 's' })
  assert.deepEqual(k('Shift+F'), { key: 0x46, text: 'F' })
  assert.deepEqual(k('2'), { key: 0x32, text: '2' })
})

test('toQtKey — Ctrl·Alt 가 붙으면 글자를 싣지 않는다 (Qt 도 제어 문자를 싣는다 — 대상 앱은 text 를 안 읽는다)', () => {
  assert.deepEqual(k('Ctrl+Z'), { key: 0x5a, text: '' })
  assert.deepEqual(k('Alt+A'), { key: 0x41, text: '' })
})

test('toQtKey — 이름 있는 키', () => {
  assert.deepEqual(k('ESC'), { key: 0x01000000, text: '' })
  assert.deepEqual(k('TAB'), { key: 0x01000001, text: '' })
  assert.deepEqual(k('BACKSPACE'), { key: 0x01000003, text: '' })
  assert.deepEqual(k('ENTER'), { key: 0x01000004, text: '' })
  assert.deepEqual(k('DEL'), { key: 0x01000007, text: '' })
  assert.deepEqual(k('LEFT'), { key: 0x01000012, text: '' })
  assert.deepEqual(k('UP'), { key: 0x01000013, text: '' })
  assert.deepEqual(k('RIGHT'), { key: 0x01000014, text: '' })
  assert.deepEqual(k('DOWN'), { key: 0x01000015, text: '' })
  assert.deepEqual(k('F1'), { key: 0x01000030, text: '' })
  assert.deepEqual(k('F12'), { key: 0x0100003b, text: '' })
  assert.deepEqual(k('SPACE'), { key: 0x20, text: ' ' })
  assert.deepEqual(k('COMMA'), { key: 0x2c, text: ',' })
  assert.deepEqual(k('-'), { key: 0x2d, text: '-' })
})

test('toQtKey — PLUS 는 거부한다. VK_OEM_PLUS 는 "=" 자리 키라 Key_Equal 인지 Key_Plus 인지 정해지지 않는다', () => {
  assert.throws(() => k('PLUS'), /추측/)
})

test('toQtKey — 모르는 가상키는 던진다', () => {
  assert.throws(() => toQtKey({ vk: 0x91, ctrl: false, alt: false, shift: false }), /0x91/)
})
