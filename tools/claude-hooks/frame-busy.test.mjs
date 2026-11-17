// 1단 — Claude Code 훅 스크립트: 요청을 보내면 작업 표시를 쓰고, 답을 마치면 지운다 (2026-11-17).
// 정답은 훅 입력 규약(stdin JSON 의 session_id)과 사용자와 정한 파일 규칙: <busy 폴더>/<session_id> 에 시작 시각(unix ms).
//
//   node --test tools/claude-hooks/frame-busy.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'frame-busy.mjs')

function hook(dir, action, input) {
  return spawnSync(process.execPath, [SCRIPT, action], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ZWPROBE_BUSY_DIR: dir },
  })
}

test('busy — 세션 파일에 지금 시각(unix ms)을 쓴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-busy-'))
  try {
    const before = Date.now()
    const r = hook(dir, 'busy', { session_id: 'abc-123', hook_event_name: 'UserPromptSubmit' })
    assert.equal(r.status, 0, r.stderr)
    const t = Number(readFileSync(join(dir, 'abc-123'), 'utf8'))
    assert.ok(t >= before && t <= Date.now(), `시각이 아니다: ${t}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idle — 그 세션 파일만 지운다 (다른 세션은 그대로)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-busy-'))
  try {
    hook(dir, 'busy', { session_id: 's1' })
    hook(dir, 'busy', { session_id: 's2' })
    const r = hook(dir, 'idle', { session_id: 's1', hook_event_name: 'Stop' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!existsSync(join(dir, 's1')), 's1 이 남았다')
    assert.ok(existsSync(join(dir, 's2')), 's2 까지 지웠다')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('훅이 Claude Code 를 막지 않는다 — 입력이 이상해도 종료 코드 0, 파일 이름에 쓸 수 없는 id 는 거른다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-busy-'))
  try {
    assert.equal(hook(dir, 'busy', 'not json').status, 0)
    assert.equal(hook(dir, 'busy', {}).status, 0)
    assert.equal(hook(dir, 'busy', { session_id: '../../evil' }).status, 0)
    assert.ok(!existsSync(join(dir, '..', '..', 'evil')), '폴더 밖에 썼다')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
