// zwwin.exe 를 부르고 JSON 을 돌려주는 I/O 가장자리. 판단은 하지 않는다.
//
// CLAUDE.md 절대 규칙 5 — 이 파일이 하는 일은 프로세스를 띄우고, stdout 을 JSON 으로
// 파싱하고, 실패를 예외로 바꾸는 것뿐이다.

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import type { KeyStroke } from '../input/shortcut.ts'
import type { UiaDump } from '../uia/tree.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ZWWIN_EXE = resolve(HERE, '../../bin/zwwin.exe')

/**
 * **macOS 에서는 zwwin.exe 대신 `src/mac/zwmac.ts` 를 부른다** (2026-10-12). 같은 동사·플래그·JSON 을
 * 내므로 이 파일의 나머지와 판정 코드는 그대로다. 안에서는 zwagent 명령 채널로 앱 프로세스에
 * 묻는다 — 밖에서 창을 다루려면 화면 기록·손쉬운 사용 권한이 필요하기 때문이다(zwmac.ts 머리말).
 */
export const ZWMAC_TS = resolve(HERE, '../mac/zwmac.ts')
const IS_MAC = process.platform === 'darwin'

/** 플랫폼에 맞는 가장자리 실행 파일과 인자. */
function edge(args: string[]): { cmd: string; argv: string[]; label: string } {
  return IS_MAC
    ? { cmd: process.execPath, argv: [ZWMAC_TS, ...args], label: 'zwmac' }
    : { cmd: ZWWIN_EXE, argv: args, label: 'zwwin.exe' }
}

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
  const e = edge(args)
  const r = spawnSync(e.cmd, e.argv, { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 })

  if (r.error) {
    throw new ZwwinError(
      `${e.label} 를 실행하지 못했다 (${IS_MAC ? ZWMAC_TS : ZWWIN_EXE}): ${r.error.message}\n` +
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

export type ClickResult = {
  button: string
  double: boolean
  /** 창 왼쪽 위 기준으로 요청한 좌표 */
  x: number
  y: number
  /** 실제로 누른 화면 절대 좌표 */
  screenX: number
  screenY: number
  activated: boolean
  moved: boolean
  foregroundAfter: number
  /** 누르기 직전 그 자리에 있던 창. 자식 위젯일 수 있다 */
  hwndAtPoint: number
  /** 그 창의 최상위 조상. 대상 창과 같아야 옳게 눌린 것이다 */
  rootAtPoint: number
  cursorRestored: boolean
  window: WindowInfo
}

export type ClickOptions = WindowFilter & {
  /**
   * 창 왼쪽 위 기준 픽셀. **`shot` 이 찍는 PNG 의 좌표와 같다** —
   * 화면에서 본 자리를 그대로 넘기면 된다. 화면 절대 좌표가 아니다.
   */
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  /** 누른 채로 유지할 시간. 0 이면 바로 뗀다 */
  holdMs?: number
  /**
   * 사람이 눈으로 따라갈 수 있게 한다 — 커서를 0.6초에 걸쳐 옮기고 누르기 전후로
   * 0.5초씩 멈춘다. 누르는 자리와 방식은 같다. 시나리오에는 쓸 이유가 없다.
   */
  slow?: boolean
  /**
   * 커서를 누른 자리에 둔다(돌려놓지 않는다). **하위 메뉴(›)를 열 때 필요하다** —
   * 커서가 떠나면 하위 메뉴가 닫힌다. 결과의 `cursorRestored` 는 false 로 온다.
   */
  stay?: boolean
}

/**
 * 창의 한 점을 누른다. 키 입력과 같이 **포그라운드를 요구한다** — 커서를 실제로 옮기고
 * 시스템 전역 입력을 보낸다. 끝나면 커서를 원래 자리로 돌려놓는다.
 *
 * 창 밖 좌표는 zwwin.exe 가 거부한다. 다른 앱을 누르는 것은 되돌릴 수 없다.
 */
export function click(opts: ClickOptions): ClickResult {
  const args = ['click', '--x', String(opts.x), '--y', String(opts.y), ...filterArgs(opts)]
  if (opts.button !== undefined) args.push('--button', opts.button)
  if (opts.double === true) args.push('--double')
  if (opts.holdMs !== undefined) args.push('--hold', String(opts.holdMs))
  if (opts.slow === true) args.push('--slow')
  if (opts.stay === true) args.push('--stay')
  return run(args) as ClickResult
}

export type UiaOptions = WindowFilter & {
  /** 몇 단계까지 내려갈지. 기본 24 */
  depth?: number
  /** 노드 상한. 닿으면 truncated 가 true 로 온다. 기본 2000 */
  max?: number
}

export type UiaDumpResult = UiaDump & { window: WindowInfo }

/**
 * 창의 UIA 트리를 평평한 목록으로 읽는다.
 *
 * **Raw view 로 순회한다** — 기본 Control view 는 Qt 위젯 대부분을 걸러낸다
 * (2026-09-09 실측: Control view 25노드 vs Raw view 152노드, 탭이 Raw 에서만 나왔다).
 * 이건 zwwin.exe 안에 박혀 있고 선택 옵션이 아니다.
 */
export function uiaTree(opts: UiaOptions = {}): UiaDumpResult {
  const args = ['uia', ...filterArgs(opts)]
  if (opts.depth !== undefined) args.push('--depth', String(opts.depth))
  if (opts.max !== undefined) args.push('--max', String(opts.max))
  return run(args) as UiaDumpResult
}

export type StartRecordOptions = WindowFilter & {
  out: string
  /** zwwin.exe 가 끝날 때 결과 JSON 을 쓸 곳. 백그라운드라 stdout 을 받을 수 없다 */
  result: string
  /** 이 파일이 생기면 녹화를 마무리한다 */
  stop: string
  fps: number
  maxSeconds: number
  mode: 'screen' | 'printwindow'
  cursor: boolean
}

/**
 * zwwin.exe record 를 **분리된 프로세스로** 띄우고 pid 를 돌려준다. 기다리지 않는다.
 * 부른 쪽(CLI·MCP 서버)이 끝나도 녹화는 계속된다 — 그래야 녹화하는 동안 다른 명령을 부를 수 있다.
 * 결과는 opts.result 에 나온다.
 */
export function startRecord(opts: StartRecordOptions): number {
  const args = [
    'record', '--out', opts.out, '--result', opts.result, '--stop', opts.stop,
    '--fps', String(opts.fps), '--max-seconds', String(opts.maxSeconds), '--mode', opts.mode,
    ...filterArgs(opts),
  ]
  if (!opts.cursor) args.push('--no-cursor')
  const e = edge(args)
  const child = spawn(e.cmd, e.argv, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  if (child.pid === undefined) {
    throw new ZwwinError(`zwwin.exe record 를 띄우지 못했다 (${ZWWIN_EXE})`)
  }
  return child.pid
}
