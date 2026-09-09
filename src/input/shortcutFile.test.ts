import { test } from 'node:test'
import assert from 'node:assert/strict'

import { appDataRoot, pickNewestVersion, pickVersionDir } from './shortcutFile.ts'

// 실측에서 나온 케이스. 디렉토리에 5.0.34 와 5.1.0 이 함께 있었고 실행 중인 앱은
// 5.0.34 였다. 최신을 고르면 다른 버전의 단축키를 읽어 다른 명령을 실행한다.
test('pickVersionDir — 실행 중인 앱 버전을 최신보다 우선한다', () => {
  const dirs = ['5.0.34', '5.1.0']
  assert.deepEqual(pickVersionDir(dirs, '5.0.34'), { version: '5.0.34', how: 'exact' })
  assert.deepEqual(pickVersionDir(dirs, '5.1.0'), { version: '5.1.0', how: 'exact' })
})

test('pickVersionDir — 뒤쪽 0 만 다른 것도 맞춘다', () => {
  // FileVersionInfo 는 "5.0.34.0" 을 주는 경우가 있고 디렉토리는 "5.0.34" 다
  assert.deepEqual(pickVersionDir(['5.0.34', '5.1.0'], '5.0.34.0'), {
    version: '5.0.34',
    how: 'normalized',
  })
})

test('pickVersionDir — 못 맞추면 최신을 고르되 그 사실을 알린다', () => {
  const pick = pickVersionDir(['5.0.34', '5.1.0'], '4.9.0')
  assert.deepEqual(pick, { version: '5.1.0', how: 'newest' })
})

test('pickVersionDir — 버전을 모르면 최신', () => {
  assert.deepEqual(pickVersionDir(['5.0.34', '5.1.0']), { version: '5.1.0', how: 'newest' })
  assert.deepEqual(pickVersionDir(['5.0.34', '5.1.0'], ''), { version: '5.1.0', how: 'newest' })
})

test('pickVersionDir — 후보가 없으면 null', () => {
  assert.equal(pickVersionDir([], '5.0.34'), null)
  assert.equal(pickVersionDir(['backup'], '5.0.34'), null)
})

test('pickNewestVersion — 마디를 숫자로 비교한다', () => {
  // 문자열 비교로는 "5.0.34" > "5.1.0" 이 참이라 틀린다. 실제로 두 버전이 함께 있었다.
  assert.equal(pickNewestVersion(['5.0.34', '5.1.0']), '5.1.0')
  assert.equal(pickNewestVersion(['5.1.0', '5.0.34']), '5.1.0')
  assert.equal(pickNewestVersion(['5.0.9', '5.0.10']), '5.0.10')
})

test('pickNewestVersion — 마디 개수가 달라도 된다', () => {
  assert.equal(pickNewestVersion(['5', '5.0.1']), '5.0.1')
  assert.equal(pickNewestVersion(['5.2', '5.1.9']), '5.2')
})

test('pickNewestVersion — 버전 형태가 아닌 이름은 무시한다', () => {
  assert.equal(pickNewestVersion(['backup', '5.0.34', 'tmp']), '5.0.34')
  assert.equal(pickNewestVersion(['backup', 'tmp']), null)
  assert.equal(pickNewestVersion([]), null)
})

test('appDataRoot — APPDATA 아래 vendor/app 경로를 만든다', () => {
  const root = appDataRoot({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })
  assert.match(root!, /z-emotion[\\/]z-weave$/)
})

test('appDataRoot — APPDATA 가 없으면 null', () => {
  assert.equal(appDataRoot({}), null)
  assert.equal(appDataRoot({ APPDATA: '' }), null)
})
