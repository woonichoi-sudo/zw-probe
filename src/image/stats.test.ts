import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyze, bgraByteLength, isWellFormed, judgeBlank } from './stats.ts'
import type { Bgra } from './stats.ts'

/** 모든 픽셀이 같은 색인 이미지 */
function solid(width: number, height: number, r: number, g: number, b: number): Bgra {
  const data = new Uint8Array(bgraByteLength(width, height))
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    data[o] = b
    data[o + 1] = g
    data[o + 2] = r
    data[o + 3] = 255
  }
  return { width, height, data }
}

/** i 번째 픽셀의 색을 함수로 주는 이미지 */
function generated(width: number, height: number, f: (i: number) => [number, number, number]): Bgra {
  const data = new Uint8Array(bgraByteLength(width, height))
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = f(i)
    const o = i * 4
    data[o] = b
    data[o + 1] = g
    data[o + 2] = r
    data[o + 3] = 255
  }
  return { width, height, data }
}

test('isWellFormed — 버퍼 길이가 크기와 맞아야 한다', () => {
  assert.equal(isWellFormed(solid(4, 4, 0, 0, 0)), true)
  assert.equal(isWellFormed({ width: 4, height: 4, data: new Uint8Array(10) }), false)
  assert.equal(isWellFormed({ width: 0, height: 4, data: new Uint8Array(0) }), false)
  assert.equal(isWellFormed({ width: -1, height: 4, data: new Uint8Array(0) }), false)
})

test('analyze — 크기가 안 맞으면 던진다', () => {
  assert.throws(
    () => analyze({ width: 4, height: 4, data: new Uint8Array(10) }),
    /맞지 않는다/,
  )
})

test('analyze — 완전한 검정', () => {
  const s = analyze(solid(10, 10, 0, 0, 0))
  assert.equal(s.pixels, 100)
  assert.equal(s.blackRatio, 1)
  assert.equal(s.meanLuminance, 0)
  assert.equal(s.uniformColor, 0x000000)
  assert.equal(s.distinctColors, 1)
})

test('analyze — 완전한 흰색', () => {
  const s = analyze(solid(10, 10, 255, 255, 255))
  assert.equal(s.blackRatio, 0)
  assert.equal(Math.round(s.meanLuminance), 255)
  assert.equal(s.uniformColor, 0xffffff)
})

test('analyze — 휘도는 BT.709 가중치를 쓴다', () => {
  // 순수 초록이 가장 밝게, 순수 파랑이 가장 어둡게 나와야 한다
  const green = analyze(solid(4, 4, 0, 255, 0)).meanLuminance
  const red = analyze(solid(4, 4, 255, 0, 0)).meanLuminance
  const blue = analyze(solid(4, 4, 0, 0, 255)).meanLuminance
  assert.ok(green > red && red > blue, `green=${green} red=${red} blue=${blue}`)
  assert.equal(Math.round(green), 182) // 0.7152 * 255
})

test('analyze — 채널 순서가 BGRA 다', () => {
  // B=10 G=20 R=30 으로 채우면 R 이 30 으로 읽혀야 한다
  const data = new Uint8Array([10, 20, 30, 255])
  const s = analyze({ width: 1, height: 1, data })
  assert.equal(s.uniformColor, (30 << 16) | (20 << 8) | 10)
})

test('analyze — 절반만 검정이면 비율이 0.5 다', () => {
  const s = analyze(generated(10, 10, (i) => (i < 50 ? [0, 0, 0] : [255, 255, 255])))
  assert.equal(s.blackRatio, 0.5)
  assert.equal(s.uniformColor, null)
})

test('judgeBlank — 단색은 캡처 실패로 본다', () => {
  assert.equal(judgeBlank(analyze(solid(64, 64, 0, 0, 0))).blank, true)
  assert.equal(judgeBlank(analyze(solid(64, 64, 255, 255, 255))).blank, true)
  // 검정이 아닌 단색도 실패다 — 회색으로 덮인 경우가 있다
  const gray = judgeBlank(analyze(solid(64, 64, 32, 32, 32)))
  assert.equal(gray.blank, true)
  assert.match(gray.reason, /단색/)
})

test('judgeBlank — 어둡지만 다양한 화면은 정상으로 본다', () => {
  // 다크 테마 UI 를 흉내낸다: 평균 휘도는 낮지만 색이 다양하다
  const dark = generated(200, 200, (i) => [i % 40, (i * 7) % 50, (i * 13) % 60])
  const stats = analyze(dark)
  assert.ok(stats.meanLuminance < 40, `평균 휘도 ${stats.meanLuminance}`)
  assert.equal(judgeBlank(stats).blank, false)
})

test('judgeBlank — 거의 전부 검정이면 실패로 본다', () => {
  // 1% 만 내용이 있는 경우. 3D 뷰포트가 통째로 검게 나온 상황을 흉내낸다
  const mostlyBlack = generated(100, 100, (i) => (i < 100 ? [i % 255, 99, 200] : [0, 0, 0]))
  const stats = analyze(mostlyBlack)
  assert.equal(stats.uniformColor, null)
  const v = judgeBlank(stats)
  assert.equal(v.blank, true)
  assert.match(v.reason, /검정/)
})

test('judgeBlank — 색이 두 개뿐이면 실패로 본다', () => {
  const twoTone = generated(100, 100, (i) => (i % 2 === 0 ? [10, 10, 10] : [250, 250, 250]))
  const v = judgeBlank(analyze(twoTone))
  assert.equal(v.blank, true)
  assert.match(v.reason, /고유 색상/)
})
