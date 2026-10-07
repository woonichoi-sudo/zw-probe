// Z-Weave 2D 뷰의 월드(cm) ↔ 위젯 픽셀 변환. 순수 — I/O 없음 (CLAUDE.md 절대 규칙 5).
//
// **왜 계산으로 하는가.** 카메라 상태(`zw2DCameraControlls::mCameraPosition`·`mFilmHeight`)
// 는 exe 안의 private 멤버라 밖에서 못 읽는다(z-weave.exe 는 심볼을 내보내지 않는다).
// 대신 Shift+F(ResetCamera)가 카메라를 **결정적인 값**으로 되돌린다 — 선택이 비었으면
// 고정값, 있으면 상자에서 정해진다. 그 직후에는 위젯 크기만 알면 변환이 정해진다.
//
// 공식의 출처 (Z-Weave 소스, 읽기만):
//   · GetTransform  view_2d/zw2DCameraControlls.cpp:58-67 — p·s + t, s = 위젯 높이 / 필름 높이
//   · CadToView     view_2d/zw2DCameraControlls.cpp:98-107 — 월드 y 를 뒤집어 넣는다
//   · Reset         view_2d/zw2DCameraControlls.cpp:10-31, .h:81-82
//   · ZoomToFit     state/zwGenericInputView.h:335-363 — 선택이 비면 Reset(w,h), 아니면 Reset(w,h,box)
//
// **위젯 픽셀 = 물리 픽셀이다.** 앱이 고DPI 배율을 끈다(zwAppZWeave.cpp:182·204) —
// 그래서 devicePixelRatio 는 1 이고 마우스 위치 `event->x() * dpr` 가 위젯 좌표 그대로다.

export type Point = { x: number; y: number }
export type Box = { minX: number; minY: number; maxX: number; maxY: number }
/** 2D 뷰 카메라. 중심과 필름 높이는 cm, 위젯 크기는 px */
export type Camera2D = { cx: number; cy: number; filmHeight: number; width: number; height: number }
/**
 * 오른쪽 버튼은 없다 — 2D 뷰에서 오른쪽 뗌이 문맥 메뉴를 띄울 수 있고, 메뉴의 `exec()` 가
 * 플러그인의 응답을 막는다. 필요해지면 trigger 처럼 큐에 넣는 길을 따로 연다.
 */
export type MouseButton = 'left' | 'middle' | 'right'
export type Modifiers = { shift?: boolean; ctrl?: boolean; alt?: boolean }
export type MouseEventSpec = {
  type: 'press' | 'move' | 'release'
  /** 위젯 기준 px */
  x: number
  y: number
  button: MouseButton
  modifiers?: Modifiers
}

/** zw2DCameraControlls.h:81-82 의 초기값 */
const INITIAL_CENTER = { x: 0, y: 90 }
const INITIAL_FILM_HEIGHT = 220

/** 선택이 빈 Shift+F. 위젯 크기만 남긴다 */
export function resetCamera(width: number, height: number): Camera2D {
  return { cx: INITIAL_CENTER.x, cy: INITIAL_CENTER.y, filmHeight: INITIAL_FILM_HEIGHT, width, height }
}

/** 선택이 있는 Shift+F. `box` 는 앱이 쓰는 상자(GetAABBToZoom 의 합)여야 같은 카메라가 된다 */
export function fitCamera(width: number, height: number, box: Box): Camera2D {
  // SetViewSize 가 1 아래를 1 로 올린다 — 비율 계산이 0 으로 나누지 않게
  const w = Math.max(width, 1)
  const h = Math.max(height, 1)
  const bw = box.maxX - box.minX
  const bh = box.maxY - box.minY
  const margin = bw * 0.2
  const filmHeight = Math.max(h / w, bh / bw) * (bw + margin)
  return { cx: (box.minX + box.maxX) / 2, cy: (box.minY + box.maxY) / 2, filmHeight, width, height }
}

function scale(cam: Camera2D): number {
  return Math.max(cam.height, 1) / cam.filmHeight
}

/** 월드 cm → 위젯 px. 화면 y 는 아래로, 월드 y 는 위로 자란다 */
export function worldToView(cam: Camera2D, p: Point): Point {
  const s = scale(cam)
  return { x: (p.x - cam.cx) * s + cam.width / 2, y: (cam.cy - p.y) * s + cam.height / 2 }
}

/** 위젯 px → 월드 cm */
export function viewToWorld(cam: Camera2D, p: Point): Point {
  const s = scale(cam)
  return { x: (p.x - cam.width / 2) / s + cam.cx, y: cam.cy - (p.y - cam.height / 2) / s }
}

/**
 * 끌기 한 번: 누름 → move `steps` 개(등간격, 마지막이 끝점) → 끝점에서 뗌.
 *
 * **move 가 하나 이상이어야 끌기다.** 데스크톱 Idle 상태는 누른 채 move 가 와야 드래그로
 * 넘어가고, move 없이 떼면 클릭이다 — 0 은 다른 조작이 되므로 거부한다.
 */
export function dragEvents(
  from: Point,
  to: Point,
  opt: { steps: number; button?: MouseButton; modifiers?: Modifiers },
): MouseEventSpec[] {
  if (!Number.isInteger(opt.steps) || opt.steps < 1) {
    throw new Error(`steps 는 1 이상의 정수여야 한다: ${opt.steps}`)
  }
  const button = opt.button ?? 'left'
  const at = (type: MouseEventSpec['type'], x: number, y: number): MouseEventSpec =>
    opt.modifiers === undefined ? { type, x, y, button } : { type, x, y, button, modifiers: { ...opt.modifiers } }
  const out = [at('press', from.x, from.y)]
  for (let i = 1; i <= opt.steps; i++) {
    const t = i / opt.steps
    out.push(at('move', from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t))
  }
  out.push(at('release', to.x, to.y))
  return out
}
