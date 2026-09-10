// 명령 채널의 **순수** 부분 — 요청을 만들고 응답을 읽는다 (절대 규칙 5).
//
// 소켓을 여는 것은 [pipe.ts](./pipe.ts) 가 하고, 여기는 바이트와 객체 사이만 다룬다.
// 그래야 프로토콜을 소켓 없이 테스트할 수 있다.
//
// 형식은 **줄 단위 JSON** 이다. 요청 한 줄에 응답 한 줄. 길이 접두사를 쓰지 않은
// 이유는 사람이 읽고 손으로 흉내낼 수 있어야 하기 때문이다 — 파이프가 안 될 때
// 원인을 찾으려면 그게 필요하다.

import { parseAgentHello } from './hello.ts'
import type { AgentWidget } from './hello.ts'

/** 파이프 이름에 pid 가 들어간다. 고정 이름이면 병렬 테스트가 서로의 파이프를 잡는다. */
export function pipeNameFor(pid: number): string {
  return `zwagent-${pid}`
}

/** Windows 에서 named pipe 의 실제 경로. Node 의 `net.connect({path})` 가 이 형태를 받는다. */
export function pipePathFor(pid: number): string {
  return `\\\\.\\pipe\\${pipeNameFor(pid)}`
}

export type Request =
  | { id: number; op: 'ping' }
  | { id: number; op: 'tree'; budget?: number; maxDepth?: number }

/** 요청 한 줄. 끝의 줄바꿈까지 포함한다 — 서버가 줄로 끊어 읽는다. */
export function encodeRequest(req: Request): string {
  return `${JSON.stringify(req)}\n`
}

export type PingResult = {
  pid: number
  qtRuntime: string
  appFilePath: string
}

export type TreeResult = {
  widgetTotal: number
  sawUi: boolean
  topLevelCount: number
  topLevelWidgets: AgentWidget[]
  widgetBudgetLeft: number
}

export type Response<T> = { ok: true; id: number; op: string; body: T } | { ok: false; error: string }

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 응답 한 줄을 읽는다. **던지지 않고 이유를 돌려준다.**
 *
 * 서버가 보낸 실패(`ok:false`)와 우리가 못 읽은 것을 **같은 모양으로** 돌려주되
 * 문구로 갈라둔다 — 둘 다 "못 했다" 이지만 원인이 다르고, 어느 쪽인지 모르면
 * 파이프를 의심할지 요청을 의심할지 정할 수 없다.
 */
export function decodeResponse(line: string): Response<Record<string, unknown>> {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, error: `응답이 JSON 이 아니다: ${line.slice(0, 120)}` }
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: '응답이 객체가 아니다.' }
  }
  const o = raw as Record<string, unknown>
  if (o.ok !== true) {
    return { ok: false, error: str(o.error, '서버가 이유 없이 거부했다.') }
  }
  return { ok: true, id: num(o.id, -1), op: str(o.op), body: o }
}

/**
 * 버퍼에서 완전한 줄만 떼어낸다.
 *
 * **한 번의 데이터 도착에 여러 줄이 올 수도 있고 한 줄이 쪼개져 올 수도 있다** —
 * 실앱 트리가 6MB 라 후자는 반드시 일어난다. 남은 조각은 그대로 돌려줘 다음 조각과
 * 이어 붙인다.
 */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter((l) => l.trim() !== ''), rest }
}

/**
 * `tree` 응답을 위젯 트리로 읽는다.
 *
 * **hello 파일과 같은 파서를 쓴다.** 플러그인이 두 길에 같은 JSON 을 내보내므로
 * 읽는 쪽도 하나여야 한다 — 두 벌이면 필드가 갈라지고, 밖에서는 어느 길로 받았는지에
 * 따라 답이 달라진다.
 */
export function parseTreeResult(body: Record<string, unknown>): TreeResult {
  const parsed = parseAgentHello({
    // hello 파서는 로드 사실과 ABI 를 요구한다. `tree` 응답에는 그게 없고 있을 이유도
    // 없다 — 파이프가 답했다는 것 자체가 로드 확인이다. 위젯 부분만 재사용하려고
    // 최소값을 채운다.
    loaded: true,
    qtRuntime: 'pipe',
    topLevelCount: body.topLevelCount,
    topLevelWidgets: body.topLevelWidgets,
    widgetBudgetLeft: body.widgetBudgetLeft,
  })
  const tops = parsed.ok ? parsed.hello.topLevelWidgets : []
  return {
    widgetTotal: num(body.widgetTotal, -1),
    sawUi: body.sawUi === true,
    topLevelCount: num(body.topLevelCount, tops.length),
    topLevelWidgets: tops,
    widgetBudgetLeft: num(body.widgetBudgetLeft, -1),
  }
}
