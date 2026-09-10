// 명령 채널의 **I/O** 부분 — named pipe 를 열고 한 줄 주고받는다 (절대 규칙 5).
//
// 판정은 하나도 없다. 프로토콜은 [protocol.ts](./protocol.ts), 해석은 부르는 쪽이다.
//
// Windows named pipe 는 Node 의 `net.connect({ path })` 로 그대로 열린다 —
// `zwwin.exe` 를 거치지 않는다. C# 층이 필요했던 것은 UIA(COM) 때문이었고 파이프는
// 아니다.

import { connect } from 'node:net'

import { decodeResponse, encodeRequest, pipePathFor, takeLines } from './protocol.ts'
import type { Request, Response } from './protocol.ts'

export type CallOptions = {
  /** 응답을 기다리는 상한(ms). 대상 앱이 모달 다이얼로그로 멈춰 있으면 안 온다 */
  timeoutMs?: number
}

/**
 * 요청 하나를 보내고 응답 하나를 받는다. 연결은 매번 새로 열고 닫는다.
 *
 * **연결을 유지하지 않는 이유**는 CLI 가 한 번 쓰고 끝나기 때문이다. 유지하면
 * 프로세스가 안 죽거나 대상 앱에 소켓이 쌓이는 실수가 생긴다.
 *
 * **상한을 반드시 둔다.** 대상 앱이 모달 다이얼로그에 걸리면 이벤트 루프가 멈추고
 * 응답이 영영 안 온다 — 그건 우리가 고칠 수 없는 것이고, 무한히 기다리면 자동 루프가
 * 통째로 멈춘다.
 */
export function call(
  pid: number,
  req: Request,
  opts: CallOptions = {},
): Promise<Response<Record<string, unknown>>> {
  const timeoutMs = opts.timeoutMs ?? 15000
  const path = pipePathFor(pid)

  return new Promise((resolve) => {
    let settled = false
    const done = (r: Response<Record<string, unknown>>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }

    const timer = setTimeout(() => {
      done({
        ok: false,
        error:
          `${timeoutMs}ms 안에 응답이 없다 (${path}). ` +
          '앱이 모달 다이얼로그에 걸려 이벤트 루프가 멈췄을 수 있다.',
      })
    }, timeoutMs)

    const sock = connect({ path })
    let buf = ''

    sock.on('connect', () => sock.write(encodeRequest(req)))
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const { lines, rest } = takeLines(buf)
      buf = rest
      if (lines.length > 0) done(decodeResponse(lines[0]!))
    })
    sock.on('error', (err) => {
      done({
        ok: false,
        error:
          `${path} 를 열지 못했다: ${err.message}. ` +
          'zwagent.dll 이 로드됐는지, pid 가 맞는지 확인한다 (hello 파일이 둘 다 말해준다).',
      })
    })
    // 응답 없이 닫히는 경우. 에러 이벤트 없이 끝날 수 있다.
    sock.on('close', () => done({ ok: false, error: '응답 없이 연결이 닫혔다.' }))
  })
}
