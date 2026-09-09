// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/image/diff.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diff, judgeChanged, judgeSame } from './diff.ts'
import type { Bgra } from './stats.ts'

/** 한 색으로 채운 이미지. BGRA 순서로 채운다. */
function solid(width: number, height: number, r: number, g: number, b: number): Bgra {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = b
    data[i * 4 + 1] = g
    data[i * 4 + 2] = r
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

/** (x,y) 픽셀을 칠한다. */
function put(img: Bgra, x: number, y: number, r: number, g: number, b: number): Bgra {
  const o = (y * img.width + x) * 4
  img.data[o] = b
  img.data[o + 1] = g
  img.data[o + 2] = r
  return img
}

test('diff — 같은 이미지는 변화 0', () => {
  const r = diff(solid(4, 3, 10, 20, 30), solid(4, 3, 10, 20, 30))
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.compared, 12)
  assert.equal(r.changed, 0)
  assert.equal(r.changedRatio, 0)
  assert.equal(r.bounds, null)
  assert.equal(r.maxDelta, 0)
})

test('diff — 한 픽셀만 다르면 bounds 가 그 픽셀 하나다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = put(solid(10, 10, 0, 0, 0), 3, 7, 255, 0, 0)
  const r = diff(a, b)
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 1)
  assert.deepEqual(r.bounds, { x: 3, y: 7, width: 1, height: 1 })
  assert.equal(r.maxDelta, 255)
})

test('diff — bounds 는 달라진 픽셀 전부를 감싼다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = solid(10, 10, 0, 0, 0)
  put(b, 2, 1, 255, 255, 255)
  put(b, 6, 4, 255, 255, 255)
  const r = diff(a, b)
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 2)
  assert.deepEqual(r.bounds, { x: 2, y: 1, width: 5, height: 4 })
})

test('diff — tolerance 이하 차이는 같다고 본다', () => {
  // 캡처 경로에서 1~2 는 흔들린다. 이걸 변화로 세면 baseline 이 매번 실패한다.
  const a = solid(4, 4, 100, 100, 100)
  const b = solid(4, 4, 102, 100, 100)
  const r = diff(a, b)
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 0)
  // 임계값 안이어도 실제 차이는 보고한다 — 얼마나 아슬아슬한지 알아야 한다
  assert.equal(r.maxDelta, 2)
})

test('diff — tolerance 를 0 으로 주면 1 도 변화다', () => {
  const r = diff(solid(4, 4, 100, 100, 100), solid(4, 4, 101, 100, 100), { tolerance: 0 })
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 16)
})

test('diff — 알파는 보지 않는다', () => {
  // PrintWindow 가 알파를 채우지 않는 경우가 있어, 알파를 세면 색이 같은데도
  // 전부 "변경" 으로 잡힌다.
  const a = solid(2, 2, 50, 60, 70)
  const b = solid(2, 2, 50, 60, 70)
  for (let i = 0; i < 4; i++) b.data[i * 4 + 3] = 0
  const r = diff(a, b)
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 0)
})

test('diff — ignore 영역은 비교에서 뺀다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = solid(10, 10, 0, 0, 0)
  put(b, 1, 1, 255, 255, 255)
  const r = diff(a, b, { ignore: [{ x: 0, y: 0, width: 5, height: 5 }] })
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 0)
  assert.equal(r.compared, 75, '10x10 에서 5x5 를 뺀 75개만 비교해야 한다')
})

test('diff — ignore 사각형의 오른쪽·아래 경계는 포함하지 않는다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = put(solid(10, 10, 0, 0, 0), 5, 5, 255, 255, 255)
  // (0,0) 5x5 는 x,y 가 0..4 다. (5,5) 는 밖이므로 변화로 잡혀야 한다.
  const r = diff(a, b, { ignore: [{ x: 0, y: 0, width: 5, height: 5 }] })
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 1)
})

test('diff — 전부 무시하면 비교한 픽셀이 0 이고 비율은 0', () => {
  // 0 으로 나누는 자리다.
  const r = diff(solid(4, 4, 0, 0, 0), solid(4, 4, 255, 255, 255), {
    ignore: [{ x: 0, y: 0, width: 4, height: 4 }],
  })
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.compared, 0)
  assert.equal(r.changed, 0)
  assert.equal(r.changedRatio, 0)
})

test('diff — 크기가 다르면 "전부 다르다" 가 아니라 비교 불가다', () => {
  // 창 크기가 바뀐 것과 내용이 바뀐 것은 원인이 다르다.
  const r = diff(solid(4, 4, 0, 0, 0), solid(4, 5, 0, 0, 0))
  assert.equal(r.comparable, false)
  if (r.comparable) return
  assert.match(r.reason, /크기가 다르다/)
  assert.match(r.reason, /4x4/)
  assert.match(r.reason, /4x5/)
})

test('diff — 버퍼 길이가 안 맞으면 비교 불가다', () => {
  const broken: Bgra = { width: 4, height: 4, data: new Uint8Array(10) }
  const r = diff(broken, solid(4, 4, 0, 0, 0))
  assert.equal(r.comparable, false)
  if (r.comparable) return
  assert.match(r.reason, /첫 이미지가 깨졌다/)

  const r2 = diff(solid(4, 4, 0, 0, 0), broken)
  assert.equal(r2.comparable, false)
  if (r2.comparable) return
  assert.match(r2.reason, /둘째 이미지가 깨졌다/)
})

test('judgeSame — 기본은 픽셀 하나도 다르면 실패', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = put(solid(10, 10, 0, 0, 0), 5, 5, 255, 255, 255)
  const v = judgeSame(diff(a, b))
  assert.equal(v.same, false)
  assert.match(v.reason, /1개/)
  assert.match(v.reason, /달라진 영역 \(5,5\) 1x1/)
})

test('judgeSame — 같으면 통과하고 비교한 개수를 말한다', () => {
  const v = judgeSame(diff(solid(4, 4, 1, 2, 3), solid(4, 4, 1, 2, 3)))
  assert.equal(v.same, true)
  assert.match(v.reason, /16개/)
})

test('judgeSame — 임계값 안이면 통과하지만 어디가 달라졌는지 말한다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = put(solid(10, 10, 0, 0, 0), 5, 5, 255, 255, 255)
  const v = judgeSame(diff(a, b), 0.02) // 1/100 = 1%
  assert.equal(v.same, true)
  assert.match(v.reason, /임계값/)
  assert.match(v.reason, /달라진 영역/)
})

test('judgeSame — 비교 불가는 같다고 하지 않는다', () => {
  const v = judgeSame(diff(solid(4, 4, 0, 0, 0), solid(5, 4, 0, 0, 0)))
  assert.equal(v.same, false)
  assert.match(v.reason, /크기가 다르다/)
})

test('judgeChanged — 전후가 같으면 입력이 통하지 않은 것이다', () => {
  // 이것이 러너에서 "단축키가 무시됐다" 를 잡는 방법이다.
  const v = judgeChanged(diff(solid(8, 8, 5, 5, 5), solid(8, 8, 5, 5, 5)))
  assert.equal(v.changed, false)
  assert.match(v.reason, /바꾸지 못했다/)
})

test('judgeChanged — 달라지면 영역을 알려준다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = put(solid(10, 10, 0, 0, 0), 9, 0, 255, 255, 255)
  const v = judgeChanged(diff(a, b))
  assert.equal(v.changed, true)
  assert.match(v.reason, /\(9,0\) 1x1/)
})

test('judgeChanged — 하한 아래면 잡음으로 본다', () => {
  const a = solid(10, 10, 0, 0, 0)
  const b = put(solid(10, 10, 0, 0, 0), 5, 5, 255, 255, 255)
  const v = judgeChanged(diff(a, b), 0.05) // 1% < 5%
  assert.equal(v.changed, false)
  assert.match(v.reason, /잡음/)
})

test('judgeChanged — 비교 불가는 "바뀌었다" 로 읽지 않는다', () => {
  // 창이 리사이즈된 것을 "명령이 통했다" 로 읽으면 안 된다.
  const v = judgeChanged(diff(solid(4, 4, 0, 0, 0), solid(4, 8, 0, 0, 0)))
  assert.equal(v.changed, false)
  assert.match(v.reason, /비교할 수 없다/)
})

test('diff — 실제 캡처 크기에서 너무 느리지 않다', () => {
  // 1920x1040 은 200만 픽셀이다. 러너가 단계마다 부르므로 초 단위면 못 쓴다.
  const a = solid(1920, 1040, 30, 30, 30)
  const b = put(solid(1920, 1040, 30, 30, 30), 1900, 1000, 255, 0, 0)
  const t0 = Date.now()
  const r = diff(a, b)
  const ms = Date.now() - t0
  assert.equal(r.comparable, true)
  if (!r.comparable) return
  assert.equal(r.changed, 1)
  assert.ok(ms < 2000, `200만 픽셀 비교가 ${ms}ms 걸렸다`)
})
