// 창 목록에서 앱의 구조와 "지금 조작할 수 있는가" 를 읽어내는 순수 판정.
//
// CLAUDE.md 절대 규칙 5 — 여기에는 I/O 가 없다. `listWindows()` 가 뱉은 사실만 받아서
// 판단한다. 그래서 테스트가 실앱 없이 밀리초로 돈다.
//
// **왜 소유자(owner)로 판정하는가.** 대상 앱은 커스텀 프레임리스 창이라
// 메인 창조차 WS_CAPTION·WS_THICKFRAME 을 달고 있다(2026-09-09 실측: style=0x97CF0000).
// 그래서 프레임 비트로는 다이얼로그를 구분할 수 없다. 창 클래스 이름도 못 쓴다 —
// Qt 가 플래그에 따라 이름을 조합하는데 이 PC 에는 Qt 소스가 없어(바이너리 배포만)
// 규칙을 확인할 수 없다. 크기도 DPI 배율에 따라 변한다.
//
// 남는 것이 소유자다. 다이얼로그는 자신을 띄운 창을 소유자로 갖고, 메인 창은 갖지 않는다.
// 이건 추측이 아니라 Win32 의 구조다.

import type { WindowInfo } from './zwwin.ts'

/** WS_* 창 스타일 비트. 이름은 Win32 그대로 둔다 — 다른 이름을 붙이면 대조할 수 없다. */
export const WS = {
  POPUP: 0x8000_0000,
  CHILD: 0x4000_0000,
  MINIMIZE: 0x2000_0000,
  VISIBLE: 0x1000_0000,
  DISABLED: 0x0800_0000,
  CLIPSIBLINGS: 0x0400_0000,
  CLIPCHILDREN: 0x0200_0000,
  MAXIMIZE: 0x0100_0000,
  BORDER: 0x0080_0000,
  DLGFRAME: 0x0040_0000,
  SYSMENU: 0x0008_0000,
  THICKFRAME: 0x0004_0000,
  MINIMIZEBOX: 0x0002_0000,
  MAXIMIZEBOX: 0x0001_0000,
} as const

/** WS_EX_* 확장 스타일 비트. */
export const WS_EX = {
  DLGMODALFRAME: 0x0000_0001,
  TOPMOST: 0x0000_0008,
  TRANSPARENT: 0x0000_0020,
  TOOLWINDOW: 0x0000_0080,
  WINDOWEDGE: 0x0000_0100,
  CLIENTEDGE: 0x0000_0200,
  CONTEXTHELP: 0x0000_0400,
  LAYERED: 0x0008_0000,
  NOACTIVATE: 0x0800_0000,
} as const

/**
 * 비트가 켜져 있는가.
 *
 * `0x80000000` 은 32비트 부호 범위를 넘지만 JS 비트 연산이 ToInt32 를 거치므로
 * `&` 결과가 음수로 나올 뿐 0 여부 판정은 옳다. 그래서 `!== 0` 으로 본다.
 */
export function hasBit(value: number, bit: number): boolean {
  return (value & bit) !== 0
}

/** 스타일 비트를 사람이 읽을 이름 목록으로. 판정이 아니라 표시용이다. */
export function styleNames(style: number, exStyle: number): string[] {
  const names: string[] = []
  for (const [name, bit] of Object.entries(WS)) {
    if (hasBit(style, bit)) names.push(name)
  }
  for (const [name, bit] of Object.entries(WS_EX)) {
    if (hasBit(exStyle, bit)) names.push('EX_' + name)
  }
  return names
}

/** 메인 창과의 관계. 이름·크기가 아니라 소유 관계에서만 나온다. */
export type Relation =
  /** 메인 창이 소유한 창 — 다이얼로그다 */
  | 'owned-by-main'
  /** 목록 안의 다른 창이 소유한다 — 다이얼로그가 띄운 다이얼로그 */
  | 'owned-by-other'
  /** 소유자가 목록 안에 없다 — 별개의 최상위 창 */
  | 'root'

export type ExtraWindow = {
  window: WindowInfo
  relation: Relation
  /** WS_DISABLED 가 아니고 IsWindowEnabled 가 참인가 */
  interactive: boolean
}

export type Classified = {
  /** 소유자가 없는 창 중 가장 큰 것. 후보가 없으면 null */
  main: WindowInfo | null
  /** 메인 창을 뺀 나머지 전부 */
  extras: ExtraWindow[]
}

/** 입력을 받을 수 있는 창인가. `enabled` 와 WS_DISABLED 를 함께 본다. */
export function isInteractive(w: WindowInfo): boolean {
  return w.enabled && !hasBit(w.style, WS.DISABLED)
}

/**
 * 창 목록을 메인 창 + 나머지로 가른다. 호출자가 프로세스로 걸러서 넘긴다.
 *
 * **메인 창은 `owner === 0` 이 아니다.** 처음에 그렇게 썼다가 픽스처에서 바로 깨졌다
 * (2026-09-09): WinForms 는 `ShowInTaskbar = false` 인 창에 **보이지 않는 parking 창** 을
 * 소유자로 붙인다. 그 창은 비가시라 열거에서 걸러지므로, 메인 창이 "소유자가 있는" 창으로
 * 보여 후보에서 탈락했다. Z-Weave 는 `owner === 0` 이라 실앱만 봤으면 못 잡았을 함정이다.
 *
 * 그래서 기준은 **소유자가 이 목록 안에 있는가** 다. 목록 밖(0 이거나 숨은 창)을 소유자로
 * 갖는 창이 뿌리다. 두 경우가 다 이 규칙 하나로 맞는다.
 *
 * 뿌리가 여럿이면 면적이 가장 큰 것을 고른다. 최소화된 창은 뒤로 미룬다 — 최소화되면
 * 사각형이 화면 밖 값이 되어 면적을 믿을 수 없다. 같은 면적이면 hwnd 가 작은 쪽을 골라
 * 실행마다 답이 흔들리지 않게 한다.
 */
export function classifyWindows(windows: readonly WindowInfo[]): Classified {
  const present = new Set(windows.map((w) => w.hwnd))
  const isRoot = (w: WindowInfo) => w.owner === 0 || !present.has(w.owner)

  const ranked = windows.filter(isRoot).sort((a, b) => {
    if (a.minimized !== b.minimized) return a.minimized ? 1 : -1
    const areaA = a.width * a.height
    const areaB = b.width * b.height
    if (areaA !== areaB) return areaB - areaA
    return a.hwnd - b.hwnd
  })
  const main = ranked[0] ?? null

  const extras: ExtraWindow[] = []
  for (const w of windows) {
    if (main !== null && w.hwnd === main.hwnd) continue
    const relation: Relation =
      main !== null && w.owner === main.hwnd
        ? 'owned-by-main'
        : isRoot(w)
          ? 'root'
          : 'owned-by-other'
    extras.push({ window: w, relation, interactive: isInteractive(w) })
  }
  return { main, extras }
}

export type ActivityState =
  /** 메인 창만 있고 입력을 받는다. 단축키를 보내도 되는 상태 */
  | 'idle'
  /** 다른 창이 떠 있거나 메인 창이 입력을 안 받는다. 기다리거나 그 창을 처리해야 한다 */
  | 'busy'
  /** 창을 못 찾았다. 앱이 안 떠 있거나 필터가 틀렸다 */
  | 'unknown'

export type Activity = {
  state: ActivityState
  /** 왜 그렇게 판정했는지. 사람이 읽고 반박할 수 있어야 한다 */
  reason: string
  classified: Classified
}

/**
 * 지금 메인 창에 입력을 보내도 되는가.
 *
 * **이것이 M3 러너에서 sleep 추측을 대체한다.** "작업이 끝났나" 를 시간이 아니라
 * 창 구조로 묻는다.
 *
 * 판정하지 않는 것: 떠 있는 창이 진행 다이얼로그인지(기다리면 사라진다) 입력을
 * 요구하는 다이얼로그인지(기다려도 안 사라진다). 제목은 메시지 페이로드에서 오는
 * 임의 문자열이고 현지화되므로 매칭할 수 없다(zwQtMainWindow.cpp:2174-2183).
 * 구분은 그 창을 실제로 관찰한 뒤에 붙인다 — 지금은 사실만 싣는다.
 */
export function judgeActivity(windows: readonly WindowInfo[]): Activity {
  const classified = classifyWindows(windows)
  const { main, extras } = classified

  if (main === null) {
    return { state: 'unknown', reason: '보이는 창이 하나도 없다. 앱이 떠 있는지 확인한다.', classified }
  }
  if (main.minimized) {
    return { state: 'busy', reason: '메인 창이 최소화돼 있다. 복원해야 입력과 캡처가 성립한다.', classified }
  }
  if (!isInteractive(main)) {
    return {
      state: 'busy',
      reason: '메인 창이 입력을 받지 않는다 (모달 창이 떠 있을 때 그렇게 된다).',
      classified,
    }
  }
  if (extras.length > 0) {
    const listed = extras
      .map((e) => `"${e.window.title}" ${e.window.width}x${e.window.height} (${e.relation})`)
      .join(', ')
    return { state: 'busy', reason: `다른 창이 ${extras.length}개 떠 있다: ${listed}`, classified }
  }
  return { state: 'idle', reason: '메인 창만 있고 입력을 받는다.', classified }
}
