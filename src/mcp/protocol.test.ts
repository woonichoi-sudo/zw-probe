// 1단 순수 단위 테스트 — stdio 도 하위 프로세스도 없이 JSON-RPC 처리만.
// 실행은 가짜 러너를 주입한다.
//
//   node --test src/mcp/protocol.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PROTOCOL, MAX_OUTPUT_CHARS, formatRun, handle } from './protocol.ts'
import type { Response, RunResult, Runner } from './protocol.ts'
import { findTool } from './tools.ts'

/** 무엇으로 불렸는지 기록하는 러너. */
function fakeRunner(result: Partial<RunResult> = {}): Runner & { calls: string[][] } {
  const calls: string[][] = []
  const run = async (argv: string[]) => {
    calls.push(argv)
    return { code: 0, stdout: '', stderr: '', ...result }
  }
  return Object.assign(run, { calls })
}

function content(res: Response | null): string {
  assert.ok(res !== null)
  const r = res.result as { content: { text: string }[] }
  return r.content[0]!.text
}

test('initialize — 클라이언트가 아는 판으로 답한다', async () => {
  const res = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, fakeRunner())
  const r = res!.result as { protocolVersion: string; capabilities: unknown }
  assert.equal(r.protocolVersion, '2024-11-05')
  assert.deepEqual(r.capabilities, { tools: {} })
})

test('initialize — 모르는 판이면 우리 기본판으로 답한다', async () => {
  const res = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, fakeRunner())
  assert.equal((res!.result as { protocolVersion: string }).protocolVersion, DEFAULT_PROTOCOL)
})

test('알림에는 답하지 않는다', async () => {
  // id 가 없는 메시지에 응답을 보내면 클라이언트가 짝 없는 응답을 받는다.
  assert.equal(await handle({ method: 'notifications/initialized' }, fakeRunner()), null)
})

test('tools/list — 도구와 스키마를 준다', async () => {
  const res = await handle({ id: 2, method: 'tools/list' }, fakeRunner())
  const tools = (res!.result as { tools: { name: string; inputSchema: unknown; annotations: Record<string, unknown> }[] }).tools
  assert.ok(tools.length > 0)
  const state = tools.find((t) => t.name === 'zw_state')!
  assert.equal(state.annotations.readOnlyHint, true)
  assert.equal(state.annotations.destructiveHint, false)
  const click = tools.find((t) => t.name === 'zw_click')!
  assert.equal(click.annotations.readOnlyHint, false, '앱을 바꾸는 도구를 읽기 전용으로 내보내면 확인 없이 실행된다')
})

test('tools/call — 인자를 argv 로 옮겨 실행한다', async () => {
  const run = fakeRunner({ stdout: '판정  idle' })
  await handle({ id: 3, method: 'tools/call', params: { name: 'zw_state', arguments: { pid: 4321 } } }, run)
  assert.deepEqual(run.calls, [['state', '--pid', '4321']])
})

test('tools/call — 인자가 잘못되면 실행하지 않고 이유를 돌려준다', async () => {
  const run = fakeRunner()
  const res = await handle({ id: 4, method: 'tools/call', params: { name: 'zw_click', arguments: { x: 1 } } }, run)
  assert.deepEqual(run.calls, [], '거부한 명령을 실행하면 앱이 바뀐다')
  assert.equal((res!.result as { isError: boolean }).isError, true)
  assert.match(content(res), /y/)
})

test('tools/call — 모르는 도구', async () => {
  const res = await handle({ id: 5, method: 'tools/call', params: { name: 'zw_nope' } }, fakeRunner())
  assert.equal(res!.error?.code, -32602)
})

test('tools/call — 판정을 실은 종료 코드는 오류가 아니다', async () => {
  // 3=busy, 2=다르다 는 정상 판정이다. 오류로 표시하면 부른 쪽이 실패로 읽는다.
  const busy = await handle({ id: 6, method: 'tools/call', params: { name: 'zw_state' } }, fakeRunner({ code: 3 }))
  assert.equal((busy!.result as { isError?: boolean }).isError, undefined)
  assert.match(content(busy), /busy/)

  const differs = await handle(
    { id: 7, method: 'tools/call', params: { name: 'zw_diff', arguments: { a: 'x', b: 'y' } } },
    fakeRunner({ code: 2 }),
  )
  assert.equal((differs!.result as { isError?: boolean }).isError, undefined)
})

test('tools/call — 종료 코드 1 은 오류로 표시한다', async () => {
  const res = await handle({ id: 8, method: 'tools/call', params: { name: 'zw_state' } }, fakeRunner({ code: 1 }))
  assert.equal((res!.result as { isError: boolean }).isError, true)
})

test('tools/call — 실행이 던지면 이유를 돌려준다', async () => {
  const boom: Runner = async () => {
    throw new Error('node 를 못 찾았다')
  }
  const res = await handle({ id: 9, method: 'tools/call', params: { name: 'zw_state' } }, boom)
  assert.equal((res!.result as { isError: boolean }).isError, true)
  assert.match(content(res), /node 를 못 찾았다/)
})

test('모르는 메서드에는 -32601', async () => {
  const res = await handle({ id: 10, method: 'resources/list' }, fakeRunner())
  assert.equal(res!.error?.code, -32601)
})

test('formatRun — 종료 코드의 뜻을 같이 싣는다', () => {
  const t = findTool('zw_doc')!
  const text = formatRun(t, ['doc'], { code: 3, stdout: '문서  bar.zls', stderr: '' })
  assert.match(text, /\$ zwprobe doc/)
  assert.match(text, /문서  bar\.zls/)
  assert.match(text, /종료 코드 3 — .*dirty/)
})

test('formatRun — 긴 출력을 자르고 그렇다고 말한다', () => {
  const t = findTool('zw_uia')!
  const text = formatRun(t, ['uia'], { code: 0, stdout: 'x'.repeat(MAX_OUTPUT_CHARS * 2), stderr: '' })
  assert.ok(text.length < MAX_OUTPUT_CHARS * 1.1)
  // 잘린 것을 모르면 "없다" 를 단정하게 된다 — 트리에서 가장 나쁜 실패다.
  assert.match(text, /잘랐다/)
})
