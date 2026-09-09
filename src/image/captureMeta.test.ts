// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/image/captureMeta.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bufferMatchesMeta, checkBaseline, parseCaptureMeta } from './captureMeta.ts'
import type { CaptureMeta } from './captureMeta.ts'

/** 실앱에서 실제로 나온 사이드카 (2026-09-09). */
const REAL = {
  format: 'bgra8',
  width: 1920,
  height: 1040,
  takenAt: '2026-09-09T07:02:28.757Z',
  mode: 'printwindow',
  window: {
    title: 'z-weave',
    class: 'Qt5156dQWindowIcon',
    pid: 7900,
    fileVersion: '5.0.34',
    width: 1920,
    height: 1040,
  },
}

function meta(p: Partial<CaptureMeta> = {}): CaptureMeta {
  const parsed = parseCaptureMeta(REAL)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('unreachable')
  return { ...parsed.meta, ...p, window: { ...parsed.meta.window, ...(p.window ?? {}) } }
}

test('parseCaptureMeta — 실앱 사이드카를 읽는다', () => {
  const r = parseCaptureMeta(REAL)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.meta.width, 1920)
  assert.equal(r.meta.height, 1040)
  assert.equal(r.meta.window.fileVersion, '5.0.34')
  assert.equal(r.meta.mode, 'printwindow')
})

test('parseCaptureMeta — 던지지 않고 이유를 돌려준다', () => {
  // 오래된 baseline 을 읽다가 스택 트레이스를 보는 것보다 이유를 보는 것이 낫다.
  for (const bad of [null, 42, 'x', []]) {
    const r = parseCaptureMeta(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 는 거부해야 한다`)
  }
})

test('parseCaptureMeta — format 이 다르면 거부한다', () => {
  const r = parseCaptureMeta({ ...REAL, format: 'rgba8' })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /format/)
})

test('parseCaptureMeta — 크기가 양의 정수가 아니면 거부한다', () => {
  for (const bad of [0, -1, 1.5, '1920', null, undefined]) {
    const r = parseCaptureMeta({ ...REAL, width: bad })
    assert.equal(r.ok, false, `width=${JSON.stringify(bad)} 는 거부해야 한다`)
  }
  assert.equal(parseCaptureMeta({ ...REAL, height: 0 }).ok, false)
})

test('parseCaptureMeta — takenAt 이 없으면 거부한다', () => {
  assert.equal(parseCaptureMeta({ ...REAL, takenAt: '' }).ok, false)
  const noField = { ...REAL } as Record<string, unknown>
  delete noField.takenAt
  assert.equal(parseCaptureMeta(noField).ok, false)
})

test('parseCaptureMeta — window 가 없어도 이미지는 쓸 수 있다', () => {
  // 못 쓰게 만들면 사람이 사이드카를 손으로 고치게 되고, 그러면 더 틀린다.
  const noWindow = { format: 'bgra8', width: 8, height: 4, takenAt: '2026-09-09T00:00:00Z' }
  const r = parseCaptureMeta(noWindow)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.meta.window.fileVersion, '')
  assert.equal(r.meta.window.pid, 0)
  // window 크기를 모르면 이미지 크기로 채운다
  assert.equal(r.meta.window.width, 8)
  assert.equal(r.meta.window.height, 4)
})

test('parseCaptureMeta — 여분 필드는 버린다', () => {
  const r = parseCaptureMeta({ ...REAL, 무엄한필드: 1, window: { ...REAL.window, 또: 2 } })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(Object.keys(r.meta).sort(), [
    'format',
    'height',
    'mode',
    'takenAt',
    'width',
    'window',
  ])
})

test('bufferMatchesMeta — 크기×4 여야 한다', () => {
  const m = meta({ width: 10, height: 3 })
  assert.equal(bufferMatchesMeta(m, 120), true)
  assert.equal(bufferMatchesMeta(m, 119), false)
  assert.equal(bufferMatchesMeta(m, 121), false)
})

test('checkBaseline — 같은 크기·같은 버전이면 경고 없이 통과', () => {
  const c = checkBaseline(meta(), meta())
  assert.equal(c.usable, true)
  assert.deepEqual(c.warnings, [])
})

test('checkBaseline — 크기가 다르면 진행할 수 없다', () => {
  const c = checkBaseline(meta({ width: 1920, height: 1040 }), meta({ width: 1600, height: 900 }))
  assert.equal(c.usable, false)
  assert.match(c.reason, /1920x1040/)
  assert.match(c.reason, /1600x900/)
})

test('checkBaseline — 앱 버전이 다르면 진행하되 경고한다', () => {
  // 여기서 막아버리면 버전을 올린 날 baseline 전체가 못 쓰게 된다.
  const c = checkBaseline(meta(), meta({ window: { ...meta().window, fileVersion: '5.1.0' } }))
  assert.equal(c.usable, true)
  assert.equal(c.warnings.length, 1)
  assert.match(c.warnings[0]!, /5\.0\.34/)
  assert.match(c.warnings[0]!, /5\.1\.0/)
})

test('checkBaseline — 버전을 모르면 경고하지 않는다', () => {
  // 빈 문자열은 "못 읽었다" 는 뜻이다. 그걸로 다르다고 말하면 거짓 경고가 된다.
  const unknown = meta({ window: { ...meta().window, fileVersion: '' } })
  assert.deepEqual(checkBaseline(unknown, meta()).warnings, [])
  assert.deepEqual(checkBaseline(meta(), unknown).warnings, [])
})

test('checkBaseline — 캡처 모드가 다르면 경고한다', () => {
  // 가려진 창에서는 screen 이 다른 창을 담는다. 섞어 쓰면 원인을 못 짚는다.
  const c = checkBaseline(meta(), meta({ mode: 'screen' }))
  assert.equal(c.usable, true)
  assert.equal(c.warnings.length, 1)
  assert.match(c.warnings[0]!, /모드가 다르다/)
})

test('checkBaseline — 경고가 둘이면 둘 다 싣는다', () => {
  const c = checkBaseline(
    meta(),
    meta({ mode: 'screen', window: { ...meta().window, fileVersion: '5.1.0' } }),
  )
  assert.equal(c.usable, true)
  assert.equal(c.warnings.length, 2)
})
