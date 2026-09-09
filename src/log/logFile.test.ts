import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { logDir, pickLogFile, tailFrom } from './logFile.ts'

const A = 'z-weave_5.0.34_2026.09.09_05.32.35.934.log'
const B = 'z-weave_5.0.34_2026.09.09_05.31.07.995.log'
const C = 'z-weave_5.1.0_2026.09.09_04.07.41.630.log'

test('logDir — LOCALAPPDATA 아래 log 디렉토리', () => {
  const d = logDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })
  assert.match(d!, /z-emotion[\\/]z-weave[\\/]log$/)
})

test('logDir — LOCALAPPDATA 가 없으면 null', () => {
  assert.equal(logDir({}), null)
  assert.equal(logDir({ LOCALAPPDATA: '' }), null)
})

test('pickLogFile — 파일명 시각이 가장 늦은 것', () => {
  assert.deepEqual(pickLogFile([B, A]), { name: A, how: 'newest' })
  assert.deepEqual(pickLogFile([A, B]), { name: A, how: 'newest' })
})

// 디스크에 여러 버전의 로그가 섞여 있었다(실측). 실행 중인 앱 버전을 우선해야 한다.
test('pickLogFile — 앱 버전이 맞는 것을 우선한다', () => {
  // C(5.1.0)가 시각상 가장 이르지만, 5.1.0 을 찾으면 C 여야 한다
  assert.deepEqual(pickLogFile([A, B, C], '5.1.0'), { name: C, how: 'exact' })
  assert.deepEqual(pickLogFile([A, B, C], '5.0.34'), { name: A, how: 'exact' })
})

test('pickLogFile — 맞는 버전이 없으면 최신을 고르되 알린다', () => {
  assert.deepEqual(pickLogFile([A, B, C], '4.0.0'), { name: A, how: 'newest' })
})

test('pickLogFile — 형식이 아닌 이름은 무시한다', () => {
  assert.deepEqual(pickLogFile(['readme.txt', B], '5.0.34'), { name: B, how: 'exact' })
  assert.equal(pickLogFile(['readme.txt']), null)
  assert.equal(pickLogFile([]), null)
})

test('tailFrom — offset 부터 이어 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwlog-'))
  const path = join(dir, 'x.log')
  try {
    writeFileSync(path, 'one\ntwo\n')
    const first = tailFrom(path, 0)
    assert.equal(first.text, 'one\ntwo\n')
    assert.equal(first.offset, 8)

    // 더 쓴 것만 읽힌다
    appendFileSync(path, 'three\n')
    const second = tailFrom(path, first.offset)
    assert.equal(second.text, 'three\n')
    assert.equal(second.offset, 14)

    // 더 쓴 것이 없으면 빈 문자열
    assert.deepEqual(tailFrom(path, second.offset), { text: '', offset: 14 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 앱이 항목을 쓰는 중일 수 있다. 잘린 줄을 파싱하면 앵커가 깨져 항목이 유실된다.
test('tailFrom — 마지막 개행 뒤의 조각은 남긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwlog-'))
  const path = join(dir, 'x.log')
  try {
    writeFileSync(path, 'complete\npartial-')
    const r = tailFrom(path, 0)
    assert.equal(r.text, 'complete\n', '완전한 줄만 준다')
    assert.equal(r.offset, 9, '조각 앞에서 멈춰야 다음에 이어 읽힌다')

    // 조각이 완성되면 그때 읽힌다
    appendFileSync(path, 'done\n')
    const r2 = tailFrom(path, r.offset)
    assert.equal(r2.text, 'partial-done\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tailFrom — 완전한 줄이 하나도 없으면 아무것도 주지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwlog-'))
  const path = join(dir, 'x.log')
  try {
    writeFileSync(path, 'no newline yet')
    assert.deepEqual(tailFrom(path, 0), { text: '', offset: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tailFrom — 파일이 작아지면 처음부터 다시 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwlog-'))
  const path = join(dir, 'x.log')
  try {
    writeFileSync(path, 'aaaa\nbbbb\n')
    writeFileSync(path, 'new\n') // 잘렸다
    const r = tailFrom(path, 10)
    assert.equal(r.text, 'new\n')
    assert.equal(r.offset, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tailFrom — 멀티바이트 문자에서 offset 이 어긋나지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwlog-'))
  const path = join(dir, 'x.log')
  try {
    writeFileSync(path, '한글 줄\n다음\n')
    const first = tailFrom(path, 0)
    assert.equal(first.text, '한글 줄\n다음\n')

    appendFileSync(path, '셋째\n')
    const second = tailFrom(path, first.offset)
    assert.equal(second.text, '셋째\n', 'offset 이 바이트 단위로 맞아야 한다')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
