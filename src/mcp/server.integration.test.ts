// 2단 통합 테스트 — 서버를 실제로 띄워 stdio 로 JSON-RPC 를 주고받는다.
//
// **Z-Weave 도 빌드 산출물도 필요 없다.** 프레이밍과 왕복만 본다 — 순수 단위가 못
// 잡는 것이 거기 있다(줄 단위 프레이밍, stdout 오염, 알림에 답해버리는 것).
//
//   node --test src/mcp/server.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const SERVER = join(resolve(import.meta.dirname, '..', '..'), 'src', 'mcp', 'server.ts')

type Res = { jsonrpc: string; id: number | null; result?: Record<string, unknown>; error?: { code: number } }

/** 서버를 띄우고 요청을 순서대로 보낸 뒤 받은 응답을 전부 돌려준다. */
function converse(requests: unknown[], expected: number): Promise<{ responses: Res[]; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SERVER], { shell: false })
    const responses: Res[] = []
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill()
      rejectPromise(new Error(`응답 ${expected}개를 기다리다 시간이 초과됐다. 받은 것 ${responses.length}개. stderr: ${stderr}`))
    }, 30000)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => (stderr += c))

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.trim() === '') return
      responses.push(JSON.parse(line) as Res)
      if (responses.length >= expected) {
        clearTimeout(timer)
        child.stdin.end()
        child.kill()
        resolvePromise({ responses, stderr })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })

    // 문자열은 그대로 보낸다 — 망가진 줄을 일부러 흘려보내는 길이다.
    for (const r of requests) child.stdin.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n')
  })
}

test('초기화 → 도구 목록 → 도구 호출이 한 연결에서 돈다', async () => {
  const { responses } = await converse(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
      // 알림이다. **여기에 답하면 아래 응답 짝이 하나씩 밀린다.**
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      // 있을 리 없는 프로세스를 찾는다 — 아무것도 조작하지 않는다.
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'zw_windows', arguments: { process: 'zzz-no-such-process' } } },
    ],
    3,
  )

  assert.equal(responses.length, 3, '알림에 답했다면 4개가 온다')
  assert.deepEqual(
    responses.map((r) => r.id),
    [1, 2, 3],
    '응답이 요청 순서대로 와야 짝을 지을 수 있다',
  )

  const init = responses[0]!.result as { protocolVersion: string; serverInfo: { name: string } }
  assert.equal(init.protocolVersion, '2025-06-18')
  assert.equal(init.serverInfo.name, 'zwprobe')

  const tools = (responses[1]!.result as { tools: { name: string }[] }).tools
  assert.ok(tools.some((t) => t.name === 'zw_state'))

  // 하위 프로세스가 실제로 돌아 CLI 출력이 실려 온다. 창을 못 찾는 것이 정상이다.
  const call = responses[2]!.result as { content: { type: string; text: string }[] }
  assert.equal(call.content[0]!.type, 'text')
  assert.match(call.content[0]!.text, /\$ zwprobe windows --process zzz-no-such-process/)
  assert.match(call.content[0]!.text, /종료 코드/)
})

test('망가진 JSON 에도 연결을 끊지 않는다', async () => {
  const { responses } = await converse(
    // 첫 줄은 JSON 이 아니다 — 문자열은 converse 가 그대로 흘려보낸다.
    ['{ 이건 JSON 이 아니다', { jsonrpc: '2.0', id: 1, method: 'ping' }],
    2,
  )

  assert.equal(responses[0]!.error?.code, -32700)
  assert.equal(responses[1]!.id, 1, '한 줄이 깨졌다고 연결이 죽으면 세션 전체가 끝난다')
})
