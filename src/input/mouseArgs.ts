// `zwprobe mouse` 의 플래그 → 위젯 좌표 이벤트 목록. 순수 — I/O 없음 (CLAUDE.md 절대 규칙 5).
//
// 할 일은 셋 중 정확히 하나다: `--at x,y`(클릭) · `--from x,y --to x,y`(끌기) · `--events <JSON>`.
// `--world reset` 이면 좌표가 **월드 cm** 이고 리셋 카메라(선택 빈 Shift+F 직후)로 위젯 px 로
// 바꾼다 — 그 카메라가 맞는지는 부르는 쪽 책임이다(직전에 Esc·Shift+F, 또는 grab 으로 확인).

import { dragEvents, resetCamera, worldToView } from './view2d.ts'
import type { Camera2D, Modifiers, MouseButton, MouseEventSpec, Point } from './view2d.ts'

export type MousePlan =
  | { ok: true; objectName: string; events: MouseEventSpec[]; camera?: Camera2D }
  | { ok: false; error: string }

/** 위젯 크기를 먼저 받아 와야 하는가 (월드 좌표일 때) */
export function needsWidgetSize(flags: Map<string, string>): boolean {
  return flags.has('world')
}

function point(raw: string | undefined, name: string): Point | string {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw ?? '')
  if (m === null) return `--${name} 는 x,y 숫자 짝이어야 한다: "${raw ?? ''}"`
  return { x: Number(m[1]), y: Number(m[2]) }
}

export function planMouse(flags: Map<string, string>, size?: { width: number; height: number }): MousePlan {
  const objectName = flags.get('object') ?? ''
  if (objectName === '') return { ok: false, error: '--object <objectName> 이 필요하다 (2D 뷰는 2dview)' }

  const modes = ['at', 'from', 'events'].filter((k) => flags.has(k))
  if (modes.length === 0) return { ok: false, error: '--at x,y · --from x,y --to x,y · --events <JSON> 중 하나가 필요하다' }
  if (modes.length > 1) return { ok: false, error: `--at · --from · --events 는 하나만 준다: ${modes.join(', ')}` }

  const button = (flags.get('button') || 'left') as MouseButton
  if (button !== 'left' && button !== 'middle' && button !== 'right') {
    return { ok: false, error: `--button 은 left·middle·right 만 받는다: "${button}"` }
  }
  const mods: Modifiers = {}
  for (const k of ['shift', 'ctrl', 'alt'] as const) if (flags.has(k)) mods[k] = true
  const modifiers = Object.keys(mods).length > 0 ? mods : undefined

  let camera: Camera2D | undefined
  if (flags.has('world')) {
    const w = flags.get('world')
    if (w !== 'reset') return { ok: false, error: `--world 는 reset 만 받는다(선택 빈 Shift+F 직후의 카메라): "${w}"` }
    if (size === undefined) return { ok: false, error: '--world 는 위젯 크기가 있어야 변환된다 — 크기를 지어내지 않는다' }
    camera = resetCamera(size.width, size.height)
  }
  const toView = (p: Point): Point => (camera === undefined ? p : worldToView(camera, p))
  const done = (events: MouseEventSpec[]): MousePlan =>
    camera === undefined ? { ok: true, objectName, events } : { ok: true, objectName, events, camera }

  if (modes[0] === 'events') {
    let raw: unknown
    try {
      raw = JSON.parse(flags.get('events') ?? '')
    } catch {
      return { ok: false, error: '--events 가 JSON 이 아니다' }
    }
    if (!Array.isArray(raw)) return { ok: false, error: '--events 는 이벤트 배열이어야 한다' }
    // 각 이벤트의 검사는 플러그인이 한다 — 같은 검사를 두 벌 두지 않는다
    const events = (raw as MouseEventSpec[]).map((e) => ({ ...e, ...toView({ x: e.x, y: e.y }) }))
    return done(events)
  }

  if (modes[0] === 'at') {
    const p = point(flags.get('at'), 'at')
    if (typeof p === 'string') return { ok: false, error: p }
    const v = toView(p)
    const at = (type: 'press' | 'release'): MouseEventSpec =>
      modifiers === undefined ? { type, ...v, button } : { type, ...v, button, modifiers: { ...modifiers } }
    return done([at('press'), at('release')])
  }

  if (!flags.has('to')) return { ok: false, error: '--from 에는 --to 가 필요하다' }
  const from = point(flags.get('from'), 'from')
  if (typeof from === 'string') return { ok: false, error: from }
  const to = point(flags.get('to'), 'to')
  if (typeof to === 'string') return { ok: false, error: to }
  const steps = Number(flags.get('steps') || '10')
  if (!Number.isInteger(steps) || steps < 1) return { ok: false, error: `--steps 는 1 이상의 정수여야 한다: ${flags.get('steps')}` }
  return done(dragEvents(toView(from), toView(to), modifiers === undefined ? { steps, button } : { steps, button, modifiers }))
}
