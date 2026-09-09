import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  atLeast,
  parseLogEntries,
  parseLogFileName,
  severityRank,
  summarize,
  toSeverity,
} from './parse.ts'

// 실제 로그에서 그대로 가져온 줄들
const REAL = `Wed Sep  9 14:32:35 2026 [INFO] main: [static]: Application started
Wed Sep  9 14:32:35 2026 [INFO] zwAppZWeave.cpp: zwAppZWeave::LoadFonts: 478: Loading fonts...
Wed Sep  9 14:54:50 2026 [ERROR] zsRenderTarget: WidgetsFBO: clearDepth=true, but no depth buffer bound to fbo!
Wed Sep  9 14:54:50 2026 [WARNING] zwQtMainWindow: Init: something to watch
`

test('parseLogEntries — 실제 줄을 뜯는다', () => {
  const e = parseLogEntries(REAL)
  assert.equal(e.length, 4)

  assert.equal(e[0]!.severity, 'INFO')
  assert.equal(e[0]!.classContext, 'main')
  assert.equal(e[0]!.detailedContext, '[static]')
  assert.equal(e[0]!.message, 'Application started')
  assert.equal(e[0]!.line, 1)

  assert.equal(e[2]!.severity, 'ERROR')
  assert.equal(e[2]!.classContext, 'zsRenderTarget')
  assert.equal(e[2]!.detailedContext, 'WidgetsFBO')
  assert.equal(e[2]!.message, 'clearDepth=true, but no depth buffer bound to fbo!')

  assert.equal(e[3]!.severity, 'WARNING')
})

test('parseLogEntries — 시각을 로컬로 읽는다', () => {
  const e = parseLogEntries(REAL)
  const t = e[0]!.time!
  assert.equal(t.getFullYear(), 2026)
  assert.equal(t.getMonth(), 8) // Sep
  assert.equal(t.getDate(), 9)
  assert.equal(t.getHours(), 14)
  assert.equal(t.getMinutes(), 32)
  assert.equal(t.getSeconds(), 35)
})

test('parseLogEntries — 날짜가 두 자리여도 읽는다', () => {
  const e = parseLogEntries('Tue Aug 25 09:30:30 2026 [INFO] a: b: c\n')
  assert.equal(e.length, 1)
  assert.equal(e[0]!.time!.getDate(), 25)
})

// 실측에서 나온 케이스. OpenGL 디버그 메시지가 줄바꿈을 품어 한 항목이 여러 줄이다.
// 302줄 파일의 항목이 268개였다.
test('parseLogEntries — 여러 줄 항목을 하나로 묶는다', () => {
  const text = `Tue Aug 25 09:30:30 2026 [ERROR] glutils: [static]: OPENGL [API] [Performance] [Severity: Medium]:
Program/shader state performance warning: Vertex shader in program 34 is being recompiled.

Tue Aug 25 09:30:30 2026 [INFO] zsRenderTarget: DepthPeelingLayer1FBO: Resizing
`
  const e = parseLogEntries(text)
  assert.equal(e.length, 2, '항목은 2개여야 한다 (물리적 줄은 4개)')
  assert.match(e[0]!.message, /Severity: Medium\]:\nProgram\/shader/)
  assert.doesNotMatch(e[0]!.message, /\n$/, '뒤쪽 빈 줄은 정리돼야 한다')
  assert.equal(e[1]!.severity, 'INFO')
})

// 메시지 안의 [ERROR]·[API] 때문에 앵커 없이 세면 과다 계상된다.
test('parseLogEntries — 메시지 안의 대괄호 토큰을 severity 로 오인하지 않는다', () => {
  const text = `Tue Aug 25 09:30:30 2026 [INFO] glutils: [static]: OPENGL [API] [ERROR] something
`
  const e = parseLogEntries(text)
  assert.equal(e.length, 1)
  assert.equal(e[0]!.severity, 'INFO', '줄 머리의 INFO 가 severity 다')
  assert.match(e[0]!.message, /\[API\] \[ERROR\]/)
})

test('parseLogEntries — 앵커 없이 시작하는 파일은 그 줄을 버린다', () => {
  const e = parseLogEntries('잘려서 시작한 줄\nTue Aug 25 09:30:30 2026 [INFO] a: b: c\n')
  assert.equal(e.length, 1)
  assert.equal(e[0]!.message, 'c')
})

test('parseLogEntries — 빈 입력', () => {
  assert.deepEqual(parseLogEntries(''), [])
  assert.deepEqual(parseLogEntries('\n\n'), [])
})

test('toSeverity / severityRank — 소스의 집합을 따른다', () => {
  assert.equal(toSeverity('FATAL'), 'FATAL')
  assert.equal(toSeverity('WARNING'), 'WARNING')
  assert.equal(toSeverity('무엇'), 'UNKNOWN')
  assert.ok(severityRank('FATAL') > severityRank('ERROR'))
  assert.ok(severityRank('ERROR') > severityRank('WARNING'))
  assert.ok(severityRank('WARNING') > severityRank('INFO'))
  assert.ok(severityRank('INFO') > severityRank('SPAM'))
})

test('atLeast — 임계값 비교', () => {
  assert.equal(atLeast('ERROR', 'WARNING'), true)
  assert.equal(atLeast('INFO', 'WARNING'), false)
  assert.equal(atLeast('WARNING', 'WARNING'), true)
})

test('summarize — 개수와 최악 severity, 문제 항목', () => {
  const s = summarize(parseLogEntries(REAL))
  assert.equal(s.total, 4)
  assert.equal(s.counts.INFO, 2)
  assert.equal(s.counts.ERROR, 1)
  assert.equal(s.counts.WARNING, 1)
  assert.equal(s.worst, 'ERROR')
  assert.equal(s.problems.length, 2, 'WARNING 이상이 2개')
})

test('summarize — 임계값을 올리면 문제 항목이 줄어든다', () => {
  const s = summarize(parseLogEntries(REAL), 'ERROR')
  assert.equal(s.problems.length, 1)
  assert.equal(s.problems[0]!.severity, 'ERROR')
})

test('summarize — 빈 로그', () => {
  const s = summarize([])
  assert.equal(s.total, 0)
  assert.equal(s.worst, null)
  assert.deepEqual(s.problems, [])
})

test('parseLogFileName — 실제 이름을 뜯는다', () => {
  const f = parseLogFileName('z-weave_5.0.34_2026.09.09_05.32.35.934.log')
  assert.ok(f)
  assert.equal(f.app, 'z-weave')
  assert.equal(f.appVersion, '5.0.34')
  // 파일명 시각은 UTC 다
  assert.equal(f.startedUtc.toISOString(), '2026-09-09T05:32:35.934Z')
})

test('parseLogFileName — 형식이 아니면 null', () => {
  assert.equal(parseLogFileName('something.log'), null)
  assert.equal(parseLogFileName('z-weave_5.0.34.log'), null)
  assert.equal(parseLogFileName('z-weave_5.0.34_2026.09.09_05.32.35.934.txt'), null)
})
