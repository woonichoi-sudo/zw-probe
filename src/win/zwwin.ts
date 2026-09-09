// zwwin.exe 를 부르고 JSON 을 돌려주는 I/O 가장자리. 판단은 하지 않는다.
//
// CLAUDE.md 절대 규칙 5 — 이 파일이 하는 일은 프로세스를 띄우고, stdout 을 JSON 으로
// 파싱하고, 실패를 예외로 바꾸는 것뿐이다.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import type { KeyStroke } from '../input/shortcut.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ZWWIN_EXE = resolve(HERE, '../../bin/zwwin.exe')

/**
 * 대상 앱의 프로세스 이름. 필터를 주지 않은 명령이 **실행 중인 앱 버전** 을 알아낼 때
 * 쓰는 기본값이다. 필터 없이 첫 창을 집으면 엉뚱한 프로세스의 버전을 읽어 다른 버전의
 * shortcut.ini 로 조용히 다른 명령을 보낸다 (2026-09-09 실측: 5.1.0 을 골랐고 앱은 5.0.34).
 */
export const TARGET_PROCESS = 'z-weave'

export type WindowInfo = {
  hwnd: number
  pid: number
  title: string
  class: string
  minimized: boolean
  /** 이 창을 소유한 창의 hwnd. 0 이면 소유자가 없다. 다이얼로그 판별의 근거 */
  owner: number
  /** 입력을 받을 수 있는가 (IsWindowEnabled) */
  enabled: boolean
  /** WS_* 비트 그대로. 해석은 windowState.ts 가 한다 */
  style: number
  /** WS_EX_* 비트 그대로 */
  exStyle: number
  /** 프로세스 실행 파일 버전. 못 읽으면 빈 문자열. 설정 디렉토리를 고를 때 쓴다 */
  fileVersion: string
  exePath: string
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

export type KeyResult = {
  method: string
  vk: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** 창을 포그라운드로 올리는 데 성공했는가. method='post' 면 항상 false */
  activated: boolean
  foregroundAfter: number
  window: WindowInfo
}

export type SendKeyOptions = WindowFilter & {
  stroke: KeyStroke
  /**
   * 'send' — keybd_event + 창 활성화. **이것만 쓴다.**
   * 'post' — PostMessage. 창을 지정할 수 있고 포커스가 필요 없지만 **수식키가 실리지 않는다.**
   *   2026-09-09 실측: `Shift+P` 가 평범한 `P` 로 전달돼 다른 명령(핀 도구)이 실행됐다.
   *   비교·진단용으로만 남긴다.
   */
  method?: 'send' | 'post'
  holdMs?: number
}

export function sendKey(opts: SendKeyOptions): KeyResult {
  const { stroke } = opts
  const args = ['key', '--vk', String(stroke.vk), ...filterArgs(opts)]
  if (stroke.ctrl) args.push('--ctrl')
  if (stroke.alt) args.push('--alt')
  if (stroke.shift) args.push('--shift')
  if (opts.method !== undefined) args.push('--method', opts.method)
  if (opts.holdMs !== undefined) args.push('--hold', String(opts.holdMs))
  return run(args) as KeyResult
}
