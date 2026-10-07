import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findPopupItem, parsePopup, popupLines } from './popup.ts'

// 플러그인 `popup` 응답 모양 — 열린 팝업 메뉴의 항목을 차례대로, 하위 메뉴는 items 로
const body = {
  open: true,
  items: [
    { text: 'Delete', enabled: true, checkable: false, separator: false },
    { text: '', enabled: true, checkable: false, separator: true },
    {
      text: 'Flip', enabled: true, checkable: false, separator: false,
      items: [
        { text: 'Flip horizontal', enabled: true, checkable: false, separator: false },
        { text: 'Flip vertical', enabled: false, checkable: false, separator: false },
      ],
    },
    { text: 'Line', enabled: true, checkable: true, checked: true, separator: false },
    { text: 'Scissor && Sew', enabled: true, checkable: false, separator: false },
  ],
}

test('parsePopup — 열린 메뉴의 항목·하위 메뉴·체크', () => {
  const p = parsePopup(body)
  assert.equal(p.open, true)
  assert.equal(p.items.length, 5)
  assert.equal(p.items[1]!.separator, true)
  assert.deepEqual(p.items[2]!.items?.map((i) => i.text), ['Flip horizontal', 'Flip vertical'])
  assert.equal(p.items[3]!.checked, true)
  assert.equal(p.items[0]!.checked, undefined)
  assert.equal(p.items[0]!.items, undefined)
})

test('parsePopup — 닫혀 있으면 open false·항목 없음', () => {
  assert.deepEqual(parsePopup({ open: false }), { open: false, items: [] })
  assert.deepEqual(parsePopup({}), { open: false, items: [] })
})

test('findPopupItem — " > " 경로로 찾는다, 글자는 Qt 원문 그대로(&&)', () => {
  const p = parsePopup(body)
  assert.deepEqual(findPopupItem(p.items, 'Flip > Flip horizontal'), { ok: true, path: ['Flip', 'Flip horizontal'] })
  assert.deepEqual(findPopupItem(p.items, 'Scissor && Sew'), { ok: true, path: ['Scissor && Sew'] })
})

test('findPopupItem — 없음·꺼짐·하위 메뉴 자체·구분선은 거절', () => {
  const p = parsePopup(body)
  const bad: Array<[string, RegExp]> = [
    ['Nope', /없다/],
    ['Flip > Flip vertical', /꺼져/],
    ['Flip', /하위 메뉴/],
    ['Delete > X', /없다/],
    ['', /없다/],
  ]
  for (const [path, why] of bad) {
    const r = findPopupItem(p.items, path)
    assert.equal(r.ok, false, path)
    if (!r.ok) assert.match(r.error, why, path)
  }
})

test('popupLines — 들여쓰기·표시(구분선 ─, 꺼짐, 체크)', () => {
  assert.deepEqual(popupLines(parsePopup(body).items), [
    'Delete',
    '─',
    'Flip ▸',
    '  Flip horizontal',
    '  Flip vertical [꺼짐]',
    'Line [✓]',
    'Scissor && Sew',
  ])
})
