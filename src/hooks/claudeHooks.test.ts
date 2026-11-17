// 1단 순수 단위 + CLI — Claude Code 훅 설치·제거 (2026-11-17 사용자: zw-probe 는 어디에도 종속되면 안 된다).
//
// zw-probe 가 스스로 그 PC 의 사용자 설정(~/.claude/settings.json)에 훅 3 개를 넣고 뺀다.
// 계약: UserPromptSubmit → busy, Stop·SessionEnd → idle. 명령은 "<node 전체 경로>" "<frame-busy.mjs 전체 경로>" busy|idle
// (Mac 에서 nvm 등의 node 가 훅 셸 PATH 에 없을 수 있어 전체 경로, 공백 대비 따옴표). 우리 것인지는 명령에
// frame-busy.mjs 가 있는지로 가른다. 다른 설정·다른 훅은 그대로 둔다.
//
//   node --test src/hooks/claudeHooks.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOOK_SCRIPT, installHooks, platformNote, uninstallHooks } from './claudeHooks.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '../cli.ts')
const OPTS = { node: 'C:/Program Files/nodejs/node.exe', script: 'D:/x y/zw-probe/tools/claude-hooks/frame-busy.mjs' }

const existing = {
  theme: 'dark',
  permissions: { deny: ['Bash(git reset:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
    PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }],
  },
}

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string }> }
const commands = (s: Record<string, unknown>, ev: string) =>
  (((s.hooks as Record<string, HookEntry[]> | undefined)?.[ev]) ?? []).flatMap((e) => e.hooks.map((h) => h.command))

test('install — 다른 설정·다른 훅은 그대로, 훅 3 개만 더한다 (전체 경로·따옴표)', () => {
  const out = installHooks(structuredClone(existing), OPTS)
  assert.equal(out.theme, 'dark')
  assert.deepEqual(out.permissions, existing.permissions)
  assert.deepEqual(commands(out, 'PostToolUse'), ['prettier'])
  assert.deepEqual(commands(out, 'UserPromptSubmit'), [`"${OPTS.node}" "${OPTS.script}" busy`])
  assert.deepEqual(commands(out, 'Stop'), ['echo bye', `"${OPTS.node}" "${OPTS.script}" idle`])
  assert.deepEqual(commands(out, 'SessionEnd'), [`"${OPTS.node}" "${OPTS.script}" idle`])
})

test('install — 두 번 해도 하나씩, 경로가 바뀌었으면 새 경로로 바꾼다', () => {
  const once = installHooks(structuredClone(existing), OPTS)
  const twice = installHooks(structuredClone(once), OPTS)
  assert.deepEqual(twice, once)
  const moved = installHooks(structuredClone(once), { ...OPTS, script: 'E:/new/tools/claude-hooks/frame-busy.mjs' })
  assert.deepEqual(commands(moved, 'UserPromptSubmit'), [`"${OPTS.node}" "E:/new/tools/claude-hooks/frame-busy.mjs" busy`])
  assert.equal(commands(moved, 'Stop').length, 2)
})

test('uninstall — 넣은 훅만 빼서 원래대로 돌아간다 (비게 된 이벤트·hooks 는 지운다)', () => {
  assert.deepEqual(uninstallHooks(installHooks(structuredClone(existing), OPTS)), existing)
  const bare = { theme: 'dark' }
  assert.deepEqual(uninstallHooks(installHooks(structuredClone(bare), OPTS)), bare)
})

test('설치 스크립트 경로가 실제 파일이다', () => {
  assert.ok(existsSync(HOOK_SCRIPT), HOOK_SCRIPT)
})

test('platformNote — Mac 은 아직 프레임이 없어 효과가 없다고 알린다, Windows 는 알림 없음', () => {
  assert.match(platformNote('darwin') ?? '', /Mac/)
  assert.equal(platformNote('win32'), undefined)
})

test('CLI — install-hooks·uninstall-hooks 가 ZWPROBE_CLAUDE_SETTINGS 파일을 고친다, 깨진 JSON 은 안 건드린다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-hooks-'))
  const file = join(dir, 'settings.json')
  const run = (verb: string) =>
    spawnSync(process.execPath, [CLI, verb], { encoding: 'utf8', env: { ...process.env, ZWPROBE_CLAUDE_SETTINGS: file } })
  try {
    // 없으면 만든다
    let r = run('install-hooks')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const s = JSON.parse(readFileSync(file, 'utf8'))
    const cmd = commands(s, 'UserPromptSubmit')[0]!
    assert.ok(cmd.includes(process.execPath.split('\\').join('/')) && cmd.includes(HOOK_SCRIPT) && cmd.endsWith(' busy'), cmd)
    r = run('uninstall-hooks')
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
    // 깨진 JSON — 실패하고 파일은 그대로
    writeFileSync(file, '{ broken')
    r = run('install-hooks')
    assert.equal(r.status, 1)
    assert.equal(readFileSync(file, 'utf8'), '{ broken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
