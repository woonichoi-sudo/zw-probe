// MCP(JSON-RPC 2.0) 요청 하나를 응답 하나로 바꾼다. I/O 는 없다 — 실행은 주입받는다.
//
// SDK 를 쓰지 않는 이유: 이 리포는 의존성이 0개고 node_modules 가 없다. 우리가 쓰는
// 표면은 initialize·tools/list·tools/call 셋뿐이라 직접 쓰는 편이 싸다.

import { TOOLS, buildArgv, findTool, inputSchema } from './tools.ts'
import type { Tool } from './tools.ts'

export const SERVER_NAME = 'zwprobe'
export const SERVER_VERSION = '0.1.0'

/** 우리가 말할 줄 아는 프로토콜 판. 클라이언트가 이 중 하나를 달라면 그대로 답한다. */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL = '2025-06-18'

/** 결과가 길면 상대 세션의 컨텍스트를 통째로 먹는다. uia 트리와 위젯 목록이 그렇다. */
export const MAX_OUTPUT_CHARS = 40000

export type Message = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown }
export type Response = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string } }

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (argv: string[]) => Promise<RunResult>

function ok(id: number | string | null, result: unknown): Response {
  return { jsonrpc: '2.0', id, result }
}

function fail(id: number | string | null, code: number, message: string): Response {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function toolDescriptor(t: Tool): Record<string, unknown> {
  return {
    name: t.name,
    title: t.title,
    description: t.desc,
    inputSchema: inputSchema(t),
    annotations: {
      title: t.title,
      readOnlyHint: !t.mutates,
      // 대상 앱의 상태를 바꾸는 것은 되돌리기 어려울 수 있다 — 클라이언트가 확인을
      // 받게 하려면 이 힌트가 필요하다.
      destructiveHint: t.mutates,
      openWorldHint: true,
    },
  }
}

/**
 * 도구 실행 결과를 텍스트 한 덩어리로 만든다.
 *
 * **종료 코드의 뜻을 같이 싣는다.** 이 도구를 부르는 쪽은 다른 프로젝트의 세션이라
 * "3" 이 busy 라는 것을 모른다. 숫자만 주면 해석을 지어낸다.
 */
export function formatRun(tool: Tool, argv: string[], r: RunResult): string {
  const parts = [`$ zwprobe ${argv.join(' ')}`, '']
  const body = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter((s) => s !== '').join('\n')
  parts.push(body === '' ? '(출력 없음)' : body)

  const meaning = tool.exits[r.code]
  parts.push('', meaning === undefined ? `[종료 코드 ${r.code}]` : `[종료 코드 ${r.code} — ${meaning}]`)

  const text = parts.join('\n')
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n... 출력이 ${text.length}자라 ${MAX_OUTPUT_CHARS}자에서 잘랐다. ` +
    '질의(name·type·filter)나 max 로 좁혀서 다시 부른다 — **잘린 뒤로는 "없다" 를 단정할 수 없다.**'
  )
}

/**
 * 메시지 하나를 처리한다. 알림(id 없음)이면 null — 답하지 않는다.
 */
export async function handle(msg: Message, run: Runner): Promise<Response | null> {
  const id = msg.id ?? null
  const method = msg.method ?? ''
  const isNotification = msg.id === undefined || msg.id === null

  switch (method) {
    case 'initialize': {
      const asked = (msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
      const version = typeof asked === 'string' && SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return ok(id, {})

    case 'tools/list':
      return ok(id, { tools: TOOLS.map(toolDescriptor) })

    case 'tools/call': {
      const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
      const name = typeof p.name === 'string' ? p.name : ''
      const tool = findTool(name)
      if (tool === undefined) {
        return fail(id, -32602, `모르는 도구 "${name}". 쓸 수 있는 것: ${TOOLS.map((t) => t.name).join(', ')}`)
      }

      const args = (p.arguments ?? {}) as Record<string, unknown>
      const built = buildArgv(tool, args)
      if (!built.ok) {
        // 인자 문제는 프로토콜 오류가 아니라 **도구 실행 결과**로 돌려준다 — 그래야
        // 부른 쪽이 이유를 읽고 고쳐서 다시 부를 수 있다 (MCP 규약).
        return ok(id, { content: [{ type: 'text', text: `인자를 쓸 수 없다: ${built.reason}` }], isError: true })
      }

      let r: RunResult
      try {
        r = await run(built.argv)
      } catch (err) {
        return ok(id, {
          content: [{ type: 'text', text: `zwprobe 를 실행하지 못했다: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        })
      }

      return ok(id, {
        content: [{ type: 'text', text: formatRun(tool, built.argv, r) }],
        // 판정을 실은 종료 코드(2=다르다, 3=busy)는 오류가 아니다. **오류로 표시하면
        // 부른 쪽이 정상 판정을 실패로 읽는다.** 1 만 "명령이 실패했다" 를 뜻한다.
        ...(r.code === 1 ? { isError: true } : {}),
      })
    }

    default:
      if (isNotification) return null
      return fail(id, -32601, `지원하지 않는 메서드: ${method}`)
  }
}
