// zwwin.exe 를 부르고 JSON 을 돌려주는 I/O 가장자리. 판단은 하지 않는다.
//
// CLAUDE.md 절대 규칙 5 — 이 파일이 하는 일은 프로세스를 띄우고, stdout 을 JSON 으로
// 파싱하고, 실패를 예외로 바꾸는 것뿐이다.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ZWWIN_EXE = resolve(HERE, '../../bin/zwwin.exe')

export type WindowInfo = {
  hwnd: number
  pid: number
  title: string
  class: string
  minimized: boolean
  x: number
  y: number
  width: number
  height: number
}

export type ShotInfo = {
  mode: string
  png: string
  raw: string | null
  format: string
  window: WindowInfo
  /** 조건에 맞은 창의 총 개수. 1 이 아니면 엉뚱한 창을 찍었을 수 있다 */
  candidates: number
}

/** 어떤 창을 고를지. 아무것도 주지 않으면 보이는 창 전부가 후보다. */
export type WindowFilter = {
  process?: string
  pid?: number
  title?: string
}

export type ShotOptions = WindowFilter & {
  png: string
  /** 판정용 원시 BGRA8 을 함께 저장할 경로 */
  raw?: string
  /** printwindow(기본) 또는 screen */
  mode?: 'printwindow' | 'screen'
}

class ZwwinError extends Error {}

function filterArgs(f: WindowFilter): string[] {
  const args: string[] = []
  if (f.process !== undefined) args.push('--process', f.process)
  if (f.pid !== undefined) args.push('--pid', String(f.pid))
  if (f.title !== undefined) args.push('--title', f.title)
  return args
}

function run(args: string[]): unknown {
  const r = spawnSync(ZWWIN_EXE, args, { encoding: 'utf8', windowsHide: true })

  if (r.error) {
    throw new ZwwinError(
      `zwwin.exe 를 실행하지 못했다 (${ZWWIN_EXE}): ${r.error.message}\n` +
        `빌드하지 않았다면 'bash tools/zwwin/build.sh' 를 먼저 실행한다.`,
    )
  }

  const out = (r.stdout ?? '').trim()
  if (!out) {
    throw new ZwwinError(
      `zwwin.exe 가 아무것도 출력하지 않았다 (종료 코드 ${r.status}). stderr: ${r.stderr ?? ''}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new ZwwinError(`zwwin.exe 의 출력이 JSON 이 아니다: ${out.slice(0, 300)}`)
  }

  const obj = parsed as { ok?: boolean; error?: string }
  if (obj.ok !== true) {
    throw new ZwwinError(obj.error ?? 'zwwin.exe 가 원인 없이 실패했다')
  }
  return parsed
}

export function listWindows(filter: WindowFilter = {}): WindowInfo[] {
  const j = run(['windows', ...filterArgs(filter)]) as { windows: WindowInfo[] }
  return j.windows
}

export function shot(opts: ShotOptions): ShotInfo {
  const args = ['shot', '--png', opts.png, ...filterArgs(opts)]
  if (opts.raw !== undefined) args.push('--raw', opts.raw)
  if (opts.mode !== undefined) args.push('--mode', opts.mode)
  return run(args) as ShotInfo
}
