// 대상 앱(Z-Weave) 리포의 위치를 어디서 정하는가.
//
// 규칙: `ZWEAVE_ROOT` 가 있으면 그것, 없으면 이 리포 옆의 `../Z-Weave`.
// 정답은 구현이 아니라 이 파일의 위치와 cygpath 로 따로 만든다.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { zweaveRoot } from './zweaveRoot.ts'
import { IS_MAC, QT_DIR } from './qtFixture.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SIBLING = resolve(REPO, '..', 'Z-Weave')
const MISSING = resolve(REPO, 'runs', 'no-such-zweave-root')

/** Windows 경로를 bash 가 쓰는 /d/... 형태로. 구현과 별개로 cygpath 가 정답을 준다. macOS 는 그대로다. */
function posix(p: string): string {
  if (IS_MAC) return p
  const r = spawnSync('cygpath', ['-u', p], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function bash(script: string, env: Record<string, string | undefined>) {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) merged[k] = v
  }
  return spawnSync('bash', [resolve(REPO, script)], { encoding: 'utf8', env: merged })
}

test('zweaveRoot: ZWEAVE_ROOT 가 있으면 그것을 쓴다', () => {
  assert.equal(zweaveRoot({ ZWEAVE_ROOT: 'E:/somewhere/Z-Weave' }), resolve('E:/somewhere/Z-Weave'))
})

test('zweaveRoot: 없으면 이 리포 옆의 Z-Weave', () => {
  assert.equal(zweaveRoot({}), SIBLING)
})

test('zweaveRoot: 빈 문자열은 없는 것으로 본다', () => {
  assert.equal(zweaveRoot({ ZWEAVE_ROOT: '' }), SIBLING)
})

test('QT_DIR 은 대상 앱 리포의 동봉 Qt 다', () => {
  const qt = IS_MAC ? 'Qt-6.5.3-LTS-LGPL-AppleClang_ARM64' : 'Qt-5.15.6-lts-lgpl-msvc2019_64'
  assert.equal(resolve(QT_DIR), resolve(zweaveRoot(), 'external', qt))
})

test('zweave-root.sh: macOS 는 ZWEAVE_ROOT 를 그대로 쓴다', { skip: !IS_MAC && 'macOS 전용' }, () => {
  const r = bash('tools/zweave-root.sh', { ZWEAVE_ROOT: '/x/Z-Weave' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '/x/Z-Weave')
})

test('zweave-root.sh: 없으면 이 리포 옆의 Z-Weave 를 /d/... 형태로', () => {
  const r = bash('tools/zweave-root.sh', { ZWEAVE_ROOT: undefined })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), posix(SIBLING))
})

test('zweave-root.sh: ZWEAVE_ROOT 를 /d/... 형태로 바꿔 쓴다', { skip: IS_MAC && 'Windows 경로 변환 — macOS 는 그대로 쓴다' }, () => {
  const r = bash('tools/zweave-root.sh', { ZWEAVE_ROOT: 'D:\\x\\Z-Weave' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '/d/x/Z-Weave')
})

// 스크립트가 실제로 그 위치를 쓰는지. 없는 곳을 주면 그 경로를 말하며 거부해야 한다.
for (const script of [
  'tools/launch-zweave.sh',
  'tools/zwagent/build.sh',
  'fixtures/qtapp/build.sh',
  'fixtures/qtapp/run.sh',
]) {
  test(`${script}: ZWEAVE_ROOT 의 앱·Qt 를 찾는다`, () => {
    const r = bash(script, { ZWEAVE_ROOT: MISSING })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(r.stderr.includes(posix(MISSING)), `stderr 에 ${posix(MISSING)} 가 없다:\n${r.stderr}`)
  })
}
