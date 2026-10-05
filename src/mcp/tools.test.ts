// 1단 순수 단위 테스트 — 프로세스 없이 인자 변환만.
//
//   node --test src/mcp/tools.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_HELLO, TOOLS, buildArgv, findTool, inputSchema } from './tools.ts'

function build(name: string, args: Record<string, unknown>) {
  const t = findTool(name)
  assert.ok(t !== undefined, `${name} 이 없다`)
  return buildArgv(t, args)
}

test('도구 이름이 유일하고 접두사를 갖는다', () => {
  const names = TOOLS.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, '이름이 겹치면 어느 쪽이 불릴지 알 수 없다')
  // 다른 프로젝트의 도구 목록에 섞여 들어간다. 접두사가 없으면 무엇을 조작하는
  // 도구인지 부르는 쪽이 알 수 없다.
  for (const n of names) assert.ok(n.startsWith('zw_'), n)
})

test('모든 도구가 종료 코드의 뜻을 갖는다', () => {
  // 숫자만 돌려주면 부르는 쪽이 해석을 지어낸다. 특히 3(busy)과 2(판정)는 실패가 아니다.
  for (const t of TOOLS) {
    assert.ok(Object.keys(t.exits).length > 0, `${t.name} 에 종료 코드 설명이 없다`)
    assert.ok(t.exits[0] !== undefined, `${t.name} 에 성공(0)의 뜻이 없다`)
  }
})

test('앱을 바꾸는 도구만 mutates 다', () => {
  const mutating = TOOLS.filter((t) => t.mutates).map((t) => t.name).sort()
  assert.deepEqual(mutating, ['zw_agent_trigger', 'zw_click', 'zw_key', 'zw_mouse', 'zw_run'])
})

test('inputSchema — 필수 인자가 required 에 들어간다', () => {
  const s = inputSchema(findTool('zw_diff')!)
  assert.deepEqual(s.required, ['a', 'b'])
  assert.equal(s.additionalProperties, false)
})

test('inputSchema — 고를 수 있는 값은 enum 으로 나간다', () => {
  const s = inputSchema(findTool('zw_shot')!) as { properties: Record<string, { enum?: string[] }> }
  assert.deepEqual(s.properties.mode!.enum, ['printwindow', 'screen'])
})

test('buildArgv — 동사가 맨 앞이다', () => {
  const r = build('zw_state', {})
  assert.ok(r.ok)
  assert.deepEqual(r.argv, ['state'])
})

test('buildArgv — 플래그 인자', () => {
  const r = build('zw_shot', { mode: 'screen', out: 'captures/a.png' })
  assert.ok(r.ok)
  assert.deepEqual(r.argv, ['shot', '--mode', 'screen', '--out', 'captures/a.png'])
})

test('buildArgv — 스위치는 true 일 때만 붙는다', () => {
  const on = build('zw_click', { x: 10, y: 20, slow: true })
  assert.ok(on.ok)
  assert.ok(on.argv.includes('--slow'))

  const off = build('zw_click', { x: 10, y: 20, slow: false })
  assert.ok(off.ok)
  assert.ok(!off.argv.includes('--slow'), 'false 를 --slow 로 옮기면 반대로 동작한다')
})

test('buildArgv — 위치 인자가 순서대로 동사 뒤에 온다', () => {
  const r = build('zw_click', { y: 20, x: 10, button: 'right' })
  assert.ok(r.ok)
  assert.deepEqual(r.argv, ['click', '10', '20', '--button', 'right'])
})

test('buildArgv — 좌표는 짝으로만 받는다', () => {
  // `click --y 20` 이 CLI 에 `click 20` 으로 가면 20 이 x 가 된다. 조용히 다른 곳을 누른다.
  const onlyY = build('zw_click', { y: 20 })
  assert.ok(!onlyY.ok)
  assert.match(onlyY.reason, /x/)

  const onlyX = build('zw_click', { x: 10 })
  assert.ok(!onlyX.ok)
  assert.match(onlyX.reason, /y/)

  // 좌표를 하나도 안 주는 것은 정상이다 — 이름으로 누르는 길이 있다.
  const byName = build('zw_click', { name: 'Avatar' })
  assert.ok(byName.ok)
  assert.deepEqual(byName.argv, ['click', '--name', 'Avatar'])
})

test('buildArgv — 모르는 인자를 거부한다', () => {
  // 오타를 무시하면 사용자가 의도한 것과 다른 명령이 나간다.
  const r = build('zw_state', { pidd: 1 })
  assert.ok(!r.ok)
  assert.match(r.reason, /pidd/)
})

test('buildArgv — 필수 인자가 빠지면 거부한다', () => {
  const r = build('zw_agent_trigger', {})
  assert.ok(!r.ok)
  assert.match(r.reason, /text/)
})

test('buildArgv — 타입이 다르면 거부한다', () => {
  const r = build('zw_click', { x: '10', y: 20 })
  assert.ok(!r.ok)
  assert.match(r.reason, /숫자/)
})

test('buildArgv — choices 밖의 값을 거부한다', () => {
  const r = build('zw_shot', { mode: 'gpu' })
  assert.ok(!r.ok)
  assert.match(r.reason, /printwindow/)
})

test('buildArgv — "--" 로 시작하는 값을 거부한다', () => {
  // CLI 파서가 값을 플래그로 읽어 **다른 명령이 조립된다.**
  const r = build('zw_uia', { name: '--max' })
  assert.ok(!r.ok)
  assert.match(r.reason, /--/)
})

test('buildArgv — agent 는 hello 기본값을 리포 것으로 둔다', () => {
  // CLI 기본값(%TEMP%)에는 픽스처가 남긴 낡은 파일이 있어 끝난 프로세스를 실앱으로 읽는다.
  const r = build('zw_agent', { live: true })
  assert.ok(r.ok)
  assert.deepEqual(r.argv, ['agent', '--live', '--hello', DEFAULT_HELLO])
})

test('buildArgv — hello 를 직접 주면 그것을 쓴다', () => {
  const r = build('zw_agent', { hello: 'runs/other.json' })
  assert.ok(r.ok)
  assert.deepEqual(r.argv, ['agent', '--hello', 'runs/other.json'])
  assert.equal(r.argv.filter((a) => a === '--hello').length, 1)
})

test('buildArgv — agent --actions 는 빈 조각으로도 부를 수 있다', () => {
  const r = build('zw_agent', { actions: '' })
  assert.ok(r.ok)
  assert.deepEqual(r.argv, ['agent', '--actions', '', '--hello', DEFAULT_HELLO])
})

test('buildArgv — trigger 는 --trigger 플래그로 나간다', () => {
  const r = build('zw_agent_trigger', { text: 'empty-scene.zls', path: 'File > Recent files' })
  assert.ok(r.ok)
  assert.deepEqual(r.argv, [
    'agent',
    '--trigger',
    'empty-scene.zls',
    '--path',
    'File > Recent files',
    '--hello',
    DEFAULT_HELLO,
  ])
})

test('buildArgv — zw_mouse 는 mouse 동사로, hello 기본값을 리포 것으로 둔다', () => {
  const r = build('zw_mouse', { object: '2dview', from: '0,90', to: '11,90', world: 'reset', shift: true, steps: 5 })
  assert.ok(r.ok, r.ok ? '' : r.reason)
  if (!r.ok) return
  assert.deepEqual(r.argv, [
    'mouse',
    '--object', '2dview',
    '--from', '0,90',
    '--to', '11,90',
    '--steps', '5',
    '--world', 'reset',
    '--shift',
    '--hello', DEFAULT_HELLO,
  ])
})

test('buildArgv — zw_mouse 는 object 가 필요하고 button·world 는 고를 수 있는 값만', () => {
  assert.equal(build('zw_mouse', { at: '1,1' }).ok, false)
  assert.equal(build('zw_mouse', { object: 'p', at: '1,1', button: 'right' }).ok, false)
  assert.equal(build('zw_mouse', { object: 'p', at: '1,1', world: 'fit' }).ok, false)
})
