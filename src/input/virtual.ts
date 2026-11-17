// 가상 커서 입력 — 인자 조립과 판정. 순수 함수만 (CLAUDE.md 절대 규칙 5).
//
// **왜 가상 커서인가** (2026-11-15). 기존 `click`·`key` 는 실제 커서를 옮기고 시스템 전역 입력을 보낸다 —
// 도는 동안 사람이 마우스·키보드를 못 쓴다. 가상 커서는 대상 창의 해당 자식 창에 **창 메시지**로
// 넣는다. 실제 커서·포그라운드는 그대로다. 사람에게는 `zwwin.exe frame` 이 대상 창 위에 그리는
// 두 번째 커서로 보인다(캡처·녹화에는 안 찍힌다).
//
// 좌표는 `shot` 의 캡처 픽셀 그대로다. zwwin.exe 의 v* 동사는 모니터별 DPI 인식(PMv2)으로 돌아
// 배율을 나눌 필요가 없다 — 기존 click 이 보조 모니터에서 1.24·1.39 로 나눠야 했던 이유가
// 시스템 DPI 인식(SetProcessDPIAware)이었다.

import { isOwnedBy } from './click.ts'
import type { WindowInfo } from '../win/zwwin.ts'

export type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean }
export type Button = 'left' | 'right' | 'middle'

export type VirtualRequest =
  | { op: 'click'; x: number; y: number; button?: Button; double?: boolean; holdMs?: number; mods?: Mods }
  | { op: 'drag'; x: number; y: number; toX: number; toY: number; steps?: number; button?: Button; mods?: Mods }
  | { op: 'wheel'; x: number; y: number; delta: number; mods?: Mods }
  /** 버튼 없이 옮긴다 — 마우스를 올려야 열리는 메뉴, 메뉴를 닫으려고 커서를 치우는 일 */
  | { op: 'move'; x: number; y: number; fromX?: number; fromY?: number; steps?: number }
  | { op: 'key'; vk: number; mods?: Mods }
  | { op: 'type'; text: string }

export type VirtualResult = {
  op: string
  /** 사람이 알약의 「중지」 를 눌러 입력하지 않았거나 중간에 끊었다 (2026-11-17) */
  halted?: boolean
  /** 창 크기가 좌표의 기준(expectSize)과 달라 입력하지 않았거나 중간에 끊었다 (2026-11-17) */
  resized?: boolean
  /** 끊기 전까지 한 단계 수 (끌기·이동 단계, 글자 수). 입력 전에 멈췄으면 0 */
  stepsDone?: number
  /** 창 기준(캡처) 좌표. key·type 에는 없다 */
  x?: number
  y?: number
  /** 입력을 실제로 받은 창. root 는 그 최상위 조상 — 대상 창이거나 대상이 소유한 다이얼로그여야 한다 */
  target: {
    hwnd: number
    root: number
    pid: number
    /** 받은 창 기준 클라이언트 좌표 (물리 픽셀) */
    clientX: number
    clientY: number
    /**
     * 창이 아는 DPI 와 그 점의 모니터 DPI — 사실로만 싣는다. 다르면 DPI 를 모르는 앱이고, Windows 가 메시지 좌표를
     * 그 창의 좌표계로 바꿔 준다(zwwin 이 환산하지 않는다 — 하면 두 번 줄어든다, 2026-11-15 실측).
     */
    windowDpi?: number
    monitorDpi?: number
  }
  /** 동작 전후의 실제 커서 위치와 포그라운드 창 — 사실로만 싣는다 (사람이 그사이 움직였을 수 있다) */
  cursorBefore: { x: number; y: number }
  cursorAfter: { x: number; y: number }
  foregroundBefore: number
  foregroundAfter: number
  /** 가상 커서 프레임에 위치를 알렸는가 (프레임이 떠 있을 때만 true) */
  frame: boolean
  window: WindowInfo
}

const BUTTONS: readonly Button[] = ['left', 'right', 'middle']

function coord(name: string, v: number): string {
  if (!Number.isInteger(v) || v < 0) throw new Error(`좌표 ${name} 는 0 이상 정수여야 한다: ${v}`)
  return String(v)
}

function buttonArgs(b: Button | undefined): string[] {
  if (b === undefined) return []
  if (!BUTTONS.includes(b)) throw new Error(`button 은 left·right·middle 이다: ${String(b)}`)
  return ['--button', b]
}

function modArgs(m: Mods | undefined): string[] {
  const out: string[] = []
  if (m?.ctrl) out.push('--ctrl')
  if (m?.shift) out.push('--shift')
  if (m?.alt) out.push('--alt')
  return out
}

/** UTF-16 코드 단위를 4자리 16진수로 잇는다. 인자 인코딩·따옴표·"--" 로 시작하는 글자를 피한다. */
export function textToHex(text: string): string {
  let s = ''
  for (let i = 0; i < text.length; i++) s += text.charCodeAt(i).toString(16).padStart(4, '0')
  return s
}

/** 요청을 zwwin.exe 인자로 바꾼다. 창 필터는 부르는 쪽(zwwin.ts)이 붙인다. 잘못된 요청은 던진다. */
export function virtualArgs(r: VirtualRequest): string[] {
  switch (r.op) {
    case 'click': {
      const a = ['vclick', '--x', coord('x', r.x), '--y', coord('y', r.y), ...buttonArgs(r.button)]
      if (r.double === true) a.push('--double')
      if (r.holdMs !== undefined) {
        if (!Number.isInteger(r.holdMs) || r.holdMs < 0) throw new Error(`hold 는 0 이상 정수(ms)여야 한다: ${r.holdMs}`)
        a.push('--hold', String(r.holdMs))
      }
      return [...a, ...modArgs(r.mods)]
    }
    case 'drag': {
      const a = ['vdrag', '--x', coord('x', r.x), '--y', coord('y', r.y), '--to-x', coord('toX', r.toX), '--to-y', coord('toY', r.toY)]
      if (r.steps !== undefined) {
        if (!Number.isInteger(r.steps) || r.steps < 1) throw new Error(`steps 는 1 이상 정수여야 한다: ${r.steps}`)
        a.push('--steps', String(r.steps))
      }
      return [...a, ...buttonArgs(r.button), ...modArgs(r.mods)]
    }
    case 'wheel': {
      if (!Number.isInteger(r.delta) || r.delta === 0) throw new Error(`delta 는 0 이 아닌 정수여야 한다 (120 = 한 칸 위): ${r.delta}`)
      return ['vwheel', '--x', coord('x', r.x), '--y', coord('y', r.y), '--delta', String(r.delta), ...modArgs(r.mods)]
    }
    case 'move': {
      const a = ['vmove', '--x', coord('x', r.x), '--y', coord('y', r.y)]
      if ((r.fromX === undefined) !== (r.fromY === undefined)) throw new Error('fromX·fromY 는 함께 줘야 한다')
      if (r.fromX !== undefined && r.fromY !== undefined) a.push('--from-x', coord('fromX', r.fromX), '--from-y', coord('fromY', r.fromY))
      if (r.steps !== undefined) {
        if (!Number.isInteger(r.steps) || r.steps < 1) throw new Error(`steps 는 1 이상 정수여야 한다: ${r.steps}`)
        a.push('--steps', String(r.steps))
      }
      return a
    }
    case 'key': {
      if (!Number.isInteger(r.vk) || r.vk < 1 || r.vk > 255) throw new Error(`vk 는 1~255 정수여야 한다: ${r.vk}`)
      return ['vkey', '--vk', String(r.vk), ...modArgs(r.mods)]
    }
    case 'type': {
      if (typeof r.text !== 'string' || r.text.length === 0) throw new Error('text 가 비어 있다')
      return ['vtype', '--text-hex', textToHex(r.text)]
    }
  }
}

export type VirtualVerdict = { onTarget: boolean; reason: string }

/**
 * 입력을 받은 창이 대상인가. `before` 는 누르기 전에 읽은 같은 프로세스의 창 목록 — 대상이 소유한
 * 다이얼로그가 받은 것은 맞다(실제 클릭과 같은 규칙, click.ts isOwnedBy).
 */
export function judgeVirtual(r: VirtualResult, before: readonly WindowInfo[] = []): VirtualVerdict {
  const t = r.target
  if (t.hwnd === 0) return { onTarget: false, reason: '입력을 받을 창을 찾지 못했다 (그 점에 대상 프로세스의 창이 없다).' }
  if (t.pid !== r.window.pid) {
    return { onTarget: false, reason: `받은 창(hwnd=${t.hwnd})이 다른 프로세스(pid=${t.pid})다. 대상 pid=${r.window.pid}.` }
  }
  if (t.root === r.window.hwnd || isOwnedBy(t.root, r.window.hwnd, before)) {
    // 받은 창이 입력 불가(모달에 막힘)면 실제 입력은 Windows 가 막는다 — 창 메시지는 들어가도 앱은 무시하기 쉽다
    // (11-16 Z-Weave assert 모달 중 3D 끌기: 판정 "정상" 인데 카메라 안 돎). 누르기 전 목록의 enabled 로 본다.
    const got = before.find((w) => w.hwnd === t.root) ?? (t.root === r.window.hwnd ? r.window : undefined)
    if (got && !got.enabled) {
      const blockers = before.filter((w) => w.pid === t.pid && w.hwnd !== t.root && w.enabled && !w.minimized)
      const desc = blockers.length > 0
        ? ` 같은 프로세스의 입력 받는 창: ${blockers.map((w) => `hwnd=${w.hwnd} ${w.width}x${w.height} "${w.title}"`).join(', ')}`
        : ''
      return {
        onTarget: false,
        reason: `받은 창 hwnd=${t.root} 이 입력을 받을 수 없는 상태(enabled=false — 모달 창에 막힘)다. 실제 입력이면 막혔다.${desc}`,
      }
    }
    return t.root === r.window.hwnd
      ? { onTarget: true, reason: `대상 창의 hwnd=${t.hwnd} (${t.clientX},${t.clientY}) 가 받았다.` }
      : { onTarget: true, reason: `대상이 소유한 창(hwnd=${t.root}, 다이얼로그)이 받았다.` }
  }
  // 같은 프로세스의 소유 관계 없는 최상위 창 — 구조로는 정상(11-15 CLO 시작 안내, 배경+내용 창)과 실패(11-16 CLO Notice 위에
  // 겹친 업데이트 소개 창이 가로챔)를 못 가른다. 그래서 "의심" 은 그대로 두고 받은 창을 밝혀 부르는 쪽이 가르게 한다.
  const got = before.find((w) => w.hwnd === t.root)
  const desc = got
    ? `${got.width}x${got.height} "${got.title}" (${got.owner ? `소유자 hwnd=${got.owner}` : '소유자 없음'})`
    : '누르기 전 창 목록에 없던 창'
  return {
    onTarget: false,
    reason: `같은 프로세스의 다른 최상위 창 hwnd=${t.root} ${desc} 이 받았다 — 대상 hwnd=${r.window.hwnd} 과 소유 관계 없음. ` +
      '그 창이 대상 자리를 덮고 있다(대상이 가려졌을 수 있다).',
  }
}
