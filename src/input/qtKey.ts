// Windows 가상키(KeyStroke) → Qt 키 값과 글자. 순수 — I/O 없음 (CLAUDE.md 절대 규칙 5).
//
// zwagent 의 `key` op 이 위젯에 QKeyEvent 를 직접 보낼 때 쓴다. 대상 앱 2D 뷰는
// `event->key()` 와 `event->modifiers()` 만 읽는다(zwQt2DView.cpp:930-964) — 그래서 키 값이
// 맞으면 실제 키 입력과 같다. 값의 출처는 Qt 헤더 qnamespace.h:604-688.
//
// **모르는 키는 던진다** — shortcut.ts 와 같은 규칙. 틀린 키는 다른 명령을 실행한다.

import type { KeyStroke } from './shortcut.ts'

const NAMED = new Map<number, { key: number; text: string }>([
  [0x1b, { key: 0x01000000, text: '' }], // Escape
  [0x09, { key: 0x01000001, text: '' }], // Tab
  [0x08, { key: 0x01000003, text: '' }], // Backspace
  [0x0d, { key: 0x01000004, text: '' }], // Return (본 키보드 Enter)
  [0x2e, { key: 0x01000007, text: '' }], // Delete
  [0x25, { key: 0x01000012, text: '' }], // Left
  [0x26, { key: 0x01000013, text: '' }], // Up
  [0x27, { key: 0x01000014, text: '' }], // Right
  [0x28, { key: 0x01000015, text: '' }], // Down
  [0x20, { key: 0x20, text: ' ' }], // Space
  [0xbc, { key: 0x2c, text: ',' }], // VK_OEM_COMMA → Key_Comma
  [0xbd, { key: 0x2d, text: '-' }], // VK_OEM_MINUS → Key_Minus
])

export function toQtKey(s: KeyStroke): { key: number; text: string } {
  const vk = s.vk
  if (vk === 0xbb) {
    throw new Error(
      'VK_OEM_PLUS(0xbb) 는 "=" 자리 키라 Qt 키가 Key_Equal 인지 Key_Plus 인지 정해지지 않는다 — 추측하지 않는다',
    )
  }
  const named = NAMED.get(vk)
  if (named !== undefined) return { ...named }
  if (vk >= 0x70 && vk <= 0x7b) return { key: 0x01000030 + (vk - 0x70), text: '' } // F1..F12
  const letter = vk >= 0x41 && vk <= 0x5a
  const digit = vk >= 0x30 && vk <= 0x39
  if (letter || digit) {
    // Ctrl·Alt 조합은 글자를 싣지 않는다 — 대상 앱은 text 를 안 읽고, 실어도 제어 문자다
    if (s.ctrl || s.alt) return { key: vk, text: '' }
    const ch = String.fromCharCode(vk)
    return { key: vk, text: letter && !s.shift ? ch.toLowerCase() : ch }
  }
  throw new Error(`가상키 0x${vk.toString(16)} 를 Qt 키로 바꿀 수 없다 — 추측하지 않는다`)
}
