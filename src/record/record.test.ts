// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/record/record.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  elapsedSeconds,
  judgeRecording,
  parseRecordResult,
  parseRecordingState,
  readMp4Summary,
  validateRecordOptions,
} from './record.ts'
import type { RecordResult, RecordingState } from './record.ts'

function result(over: Partial<RecordResult> = {}): RecordResult {
  return {
    ok: true,
    out: 'C:\\x.mp4',
    bytes: 1000,
    frames: 100,
    captureFailures: 0,
    duplicated: 0,
    seconds: 10,
    fps: 10,
    width: 1920,
    height: 1040,
    mode: 'screen',
    stopReason: 'stop',
    window: {
      hwnd: 1, pid: 2, title: 'z-weave', class: 'Qt', minimized: false, owner: 0, enabled: true,
      style: 0, exStyle: 0, fileVersion: '', exePath: '', x: 0, y: 0, width: 1920, height: 1040,
    },
    ...over,
  }
}

test('옵션 — 기본값', () => {
  const v = validateRecordOptions({ out: 'a.mp4' })
  assert.deepEqual(v, { ok: true, value: { out: 'a.mp4', fps: 10, maxSeconds: 600, mode: 'screen', cursor: true } })
})

test('옵션 — .mp4 가 아니면 거부한다', () => {
  assert.equal(validateRecordOptions({ out: 'a.avi' }).ok, false)
})

test('옵션 — fps 범위와 정수', () => {
  assert.equal(validateRecordOptions({ out: 'a.mp4', fps: '0' }).ok, false)
  assert.equal(validateRecordOptions({ out: 'a.mp4', fps: '61' }).ok, false)
  assert.equal(validateRecordOptions({ out: 'a.mp4', fps: '7.5' }).ok, false)
  assert.equal(validateRecordOptions({ out: 'a.mp4', fps: 'x' }).ok, false)
  const v = validateRecordOptions({ out: 'a.mp4', fps: '30' })
  assert.ok(v.ok && v.value.fps === 30)
})

test('옵션 — 모르는 mode 는 기본값으로 바꾸지 않고 거부한다', () => {
  assert.equal(validateRecordOptions({ out: 'a.mp4', mode: 'window' }).ok, false)
  const v = validateRecordOptions({ out: 'a.mp4', mode: 'printwindow', noCursor: true })
  assert.ok(v.ok && v.value.mode === 'printwindow' && v.value.cursor === false)
})

test('옵션 — max-seconds', () => {
  assert.equal(validateRecordOptions({ out: 'a.mp4', maxSeconds: '0' }).ok, false)
  assert.equal(validateRecordOptions({ out: 'a.mp4', maxSeconds: '3601' }).ok, false)
  const v = validateRecordOptions({ out: 'a.mp4', maxSeconds: '2.5' })
  assert.ok(v.ok && v.value.maxSeconds === 2.5)
})

test('상태 파일 — 필드가 빠지면 거부한다', () => {
  const good: RecordingState = {
    pid: 1, out: 'o.mp4', result: 'r.json', stop: 's.stop', startedAt: '2026-09-30T00:00:00.000Z',
    fps: 10, maxSeconds: 600, mode: 'screen',
  }
  assert.equal(parseRecordingState(JSON.stringify(good)).ok, true)
  const { pid: _pid, ...noPid } = good
  assert.equal(parseRecordingState(JSON.stringify(noPid)).ok, false)
  assert.equal(parseRecordingState('not json').ok, false)
})

test('경과·남은 시간', () => {
  const s = { startedAt: '2026-09-30T00:00:00.000Z', maxSeconds: 60 } as RecordingState
  const t = elapsedSeconds(s, new Date('2026-09-30T00:00:15.000Z'))
  assert.deepEqual(t, { elapsed: 15, remaining: 45 })
  assert.equal(elapsedSeconds(s, new Date('2026-09-30T00:05:00.000Z')).remaining, 0)
})

test('결과 파일 — 실패 JSON 은 원인을 그대로 싣는다', () => {
  const f = parseRecordResult('{"ok":false,"error":"창 없음"}')
  assert.deepEqual(f, { ok: false, error: '창 없음' })
  assert.equal(parseRecordResult('{"ok":true}').ok, false)
  assert.equal(parseRecordResult('garbage').ok, false)
})

test('판정 — 정상', () => {
  assert.deepEqual(judgeRecording(result()), { usable: true, notes: [] })
})

test('판정 — 프레임이 없으면 쓸 수 없다', () => {
  assert.equal(judgeRecording(result({ frames: 0 })).usable, false)
})

test('판정 — 캡처 실패가 절반을 넘으면 쓸 수 없다', () => {
  assert.equal(judgeRecording(result({ frames: 100, captureFailures: 51 })).usable, false)
  const r = judgeRecording(result({ frames: 100, captureFailures: 3 }))
  assert.ok(r.usable && r.notes.some((n) => n.includes('3 번')))
})

test('판정 — 복제가 많으면 쓸 수는 있지만 알린다', () => {
  const r = judgeRecording(result({ frames: 100, duplicated: 40 }))
  assert.ok(r.usable && r.notes.some((n) => n.includes('40%')))
  assert.deepEqual(judgeRecording(result({ frames: 100, duplicated: 10 })).notes, [])
})

test('판정 — 창이 사라졌거나 상한에 닿았으면 알린다', () => {
  assert.ok(judgeRecording(result({ stopReason: 'window-gone' })).notes[0]!.includes('사라져'))
  assert.ok(judgeRecording(result({ stopReason: 'max-seconds' })).notes[0]!.includes('최대 시간'))
})

// ── MP4 박스 ───────────────────────────────────────────────

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const bodyLen = children.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(8 + bodyLen)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let off = 8
  for (const c of children) {
    out.set(c, off)
    off += c.length
  }
  return out
}

function raw(bytes: number[]): Uint8Array {
  return new Uint8Array(bytes)
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}

test('MP4 — moov 안의 mvhd 길이와 stsz 샘플 수를 읽는다', () => {
  // mvhd v0: version+flags(4) creation(4) modification(4) timescale(4) duration(4)
  const mvhd = box('mvhd', raw([0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(10000), ...u32(50000)]))
  // stsz: version+flags(4) sample_size(4) sample_count(4)
  const stsz = box('stsz', raw([0, 0, 0, 0, ...u32(0), ...u32(50)]))
  const file = new Uint8Array([
    ...box('ftyp', raw([...u32(0)])),
    ...box('mdat', raw([1, 2, 3])),
    ...box('moov', mvhd, box('trak', box('mdia', box('minf', box('stbl', stsz))))),
  ])
  assert.deepEqual(readMp4Summary(file), { hasMoov: true, samples: 50, seconds: 5 })
})

test('MP4 — moov 가 없으면(마무리 안 된 파일) 그렇다고 말한다', () => {
  const file = new Uint8Array([...box('ftyp', raw([...u32(0)])), ...box('mdat', raw([1, 2, 3]))])
  assert.deepEqual(readMp4Summary(file), { hasMoov: false, samples: 0, seconds: 0 })
})

test('MP4 — 잘린 박스에서 멈추고 던지지 않는다', () => {
  const file = box('moov', raw([0, 0, 0, 99, 115, 116, 115, 122]))
  assert.equal(readMp4Summary(file).hasMoov, true)
  assert.equal(readMp4Summary(new Uint8Array([0, 0])).hasMoov, false)
})

test('판정 — 파일에 moov 가 없으면 쓸 수 없다', () => {
  assert.equal(judgeRecording(result(), { hasMoov: false, samples: 0, seconds: 0 }).usable, false)
})

test('판정 — 파일의 샘플 수가 보고와 다르면 알린다', () => {
  const r = judgeRecording(result({ frames: 50 }), { hasMoov: true, samples: 43, seconds: 4.3 })
  assert.ok(r.usable && r.notes.some((n) => n.includes('43')))
  assert.deepEqual(judgeRecording(result({ frames: 50 }), { hasMoov: true, samples: 50, seconds: 5 }).notes, [])
})
