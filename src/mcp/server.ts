// zwprobe MCP 서버 — 다른 프로젝트의 세션이 Z-Weave 를 조작·관찰할 수 있게 한다.
//
//   claude mcp add --scope user zwprobe -- node <이 파일의 절대경로>
//
// **여기는 가장자리다.** 판단은 전부 CLI 안에 있고 이 파일은 stdio 로 JSON-RPC 를
// 주고받으며 하위 프로세스를 띄울 뿐이다 (CLAUDE.md §절대규칙 5).
//
// CLI 를 모듈로 import 하지 않고 하위 프로세스로 부르는 이유: CLI 가 출력 형식과
// 종료 코드로 이미 판정을 말한다. 안에서 다시 조립하면 규칙이 두 벌이 되고, 둘이
// 어긋나면 **어느 쪽이 맞는지 알 수 없다.**

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

import { handle } from './protocol.ts'
import type { Message, RunResult } from './protocol.ts'

/** 리포 루트. captures/·runs/·baselines/ 가 여기 기준이라 cwd 를 여기로 맞춘다. */
const ROOT = resolve(import.meta.dirname, '..', '..')
const CLI = join(ROOT, 'src', 'cli.ts')

/** 시나리오는 앱 준비까지 포함해 분 단위로 돈다. 상한은 넉넉히 두고 넘으면 죽인다. */
const TIMEOUT_MS = 10 * 60 * 1000

function runCli(argv: string[]): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // shell 을 쓰지 않는다 — 인자가 셸을 거치지 않으므로 따옴표·공백을 신경 쓸 필요가
    // 없고 주입도 성립하지 않는다.
    const child = spawn(process.execPath, [CLI, ...argv], { cwd: ROOT, shell: false })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c: string) => (stdout += c))
    child.stderr.on('data', (c: string) => (stderr += c))

    child.on('error', (err) => {
      clearTimeout(timer)
      rejectPromise(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        stderr += `\n[${TIMEOUT_MS / 1000}초를 넘겨 중단했다. 앱이 응답하지 않거나 시나리오가 긴 것이다.]`
      }
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
  })
}

function send(res: unknown): void {
  process.stdout.write(JSON.stringify(res) + '\n')
}

// 줄 하나가 메시지 하나다 (MCP stdio 전송). **stdout 에는 응답만 쓴다** — 다른 것을
// 섞으면 클라이언트가 프레임을 잃는다. 진단은 전부 stderr 로 간다.
const rl = createInterface({ input: process.stdin })

// 요청은 순서대로 처리한다. 하나가 앱을 조작하는 동안 다른 하나가 끼어들면 **관찰과
// 조작이 뒤섞여** 무엇을 본 것인지 알 수 없어진다.
let queue: Promise<void> = Promise.resolve()

rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return

  let msg: Message
  try {
    msg = JSON.parse(text) as Message
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 을 읽지 못했다' } })
    return
  }

  if (Array.isArray(msg)) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '배치 요청은 받지 않는다' } })
    return
  }

  queue = queue.then(async () => {
    try {
      const res = await handle(msg, runCli)
      if (res !== null) send(res)
    } catch (err) {
      process.stderr.write(`처리 중 예외: ${err instanceof Error ? err.stack : String(err)}\n`)
      if (msg.id !== undefined && msg.id !== null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
      }
    }
  })
})

rl.on('close', () => process.exit(0))
