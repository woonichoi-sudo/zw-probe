// 시험용 — 실제 커서·키보드를 쓰는 구간을 프로세스 사이에서 하나씩만 돌게 한다.
//
// `node --test` 는 시험 **파일을 동시에** 돌린다. 기존 click 시험이 실제 커서를 옮기는 동안 가상 커서 시험의
// 관찰자가 그 움직임을 잡아 "가상 입력이 커서를 움직였다" 로 거짓 실패했다(2026-11-15 전체 스위트).
// 실제 입력을 쓰는 쪽과 "실제 입력이 없었다" 를 관찰하는 쪽이 이 잠금을 같이 잡는다.

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOCK = join(tmpdir(), 'zwprobe-real-input.lock')
const STALE_MS = 180_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function withRealInput<T>(fn: () => T | Promise<T>, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      mkdirSync(LOCK) // 원자적 — 있으면 EEXIST
      break
    } catch {
      try {
        // 죽은 시험이 남긴 잠금은 치운다
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true, force: true })
      } catch {
        /* 그사이 풀렸다 */
      }
      if (Date.now() > deadline) throw new Error(`실제 입력 잠금을 ${timeoutMs}ms 안에 못 잡았다: ${LOCK}`)
      await sleep(100)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(LOCK, { recursive: true, force: true })
  }
}
