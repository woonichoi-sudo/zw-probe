// `zwagent.dll` 이 남긴 hello 파일의 순수 판정 (CLAUDE.md 절대 규칙 5).
//
// 플러그인은 로드되면 JSON 파일 하나를 쓴다. "로드됐나" 를 밖에서 확인하는 방법이
// 그것뿐이다 — stdout 은 대상 앱이 이미 쓰고 있고, 콘솔 없는 빌드에서는 사라진다.
//
// 여기서 판정하는 것은 **로드 사실과 ABI 일치**다. 위젯 트리 해석은 M5 에서 쓴다.

export type AgentWidget = {
  class: string
  objectName: string
  visible: boolean
  enabled: boolean
  /**
   * **부모 기준 좌표다.** 최상위만 화면 좌표이고 자식은 부모 안에서의 위치다 —
   * 툴바 버튼이 `3,3` 으로 나온다. 클릭에 쓰면 안 된다. `screenX`·`screenY` 를 쓴다.
   */
  x: number
  y: number
  width: number
  height: number
  /** 화면 절대 좌표 (`mapToGlobal`). 창 기준으로 바꾸는 것은 `toWindowPoint` */
  screenX: number
  screenY: number
  /** 사람이 보는 글자. 버튼·라벨·입력칸에서 온다. 없으면 undefined */
  text?: string
  toolTip?: string
  accessibleName?: string
  windowTitle?: string
  /** `QAction` 텍스트. 툴바 버튼이 라벨을 액션에만 가질 수 있다 */
  actions?: string[]
  children?: AgentWidget[]
}

export type AgentHello = {
  loaded: boolean
  styleKey: string
  /** 보고까지 몇 번 폴링했는가. 대상 앱은 시작이 느려 여러 번 돈다 */
  attempts: number
  /**
   * 보고 시점에 보이는 최상위 위젯이 있었는가.
   *
   * **false 면 위젯 트리를 믿을 수 없다.** 상한까지 기다려도 UI 가 안 뜬 것이므로
   * 트리가 비어 있는 것은 "위젯이 없다" 가 아니라 "아직 안 만들어졌다" 다.
   */
  sawUi: boolean
  /**
   * 위젯 개수가 멈춘 뒤에 쓴 스냅샷인가.
   *
   * **false 면 과도 상태일 수 있다.** 플러그인은 개수가 3초간 안 변하면 정착으로 보고
   * 쓰는데, 마감(180초)까지 정착이 안 오면 그때의 상태를 그대로 쓴다. 대상 앱은
   * 스플래시가 65초 넘게 떠 있고 그 동안 위젯이 계속 늘어난다 — 정착 전 트리는
   * 레이아웃도 안 된 `640x480` 위젯 덩어리다 (2026-09-09 실측).
   */
  settled: boolean
  /**
   * 프로세스 안의 위젯 총 개수. 상한과 무관하게 실제 규모다.
   *
   * `widgetBudgetLeft` 가 0이어서 트리가 잘렸을 때 **"몇 개를 못 봤나" 를 말해준다.**
   * 이 값이 없으면 "없다" 를 단정할 수 없다는 경고만 남고 규모를 모른다.
   */
  widgetTotal: number
  /** 몇 번째 보고인가. 2 이상이면 앞의 (스플래시 시절) 스냅샷을 스스로 덮어썼다 */
  writeCount: number
  /** 스타일이 만들어진 뒤 보고까지의 경과 시간(ms). 대상 앱은 90초쯤 걸린다 */
  elapsedMs: number
  pid: number
  /** 플러그인을 컴파일할 때의 Qt 버전 (QT_VERSION_STR) */
  qtCompiled: string
  /** 프로세스 안에서 실제로 돌고 있는 Qt 버전 (qVersion()) */
  qtRuntime: string
  writtenAt: string
  /** 어느 실행 파일 안에 들어갔는지. 대상을 확인하는 근거 */
  appFilePath: string
  topLevelCount: number
  topLevelWidgets: AgentWidget[]
  /** 위젯 수 상한에서 남은 여유. 0 이면 트리가 잘렸다 */
  widgetBudgetLeft: number
  /**
   * 명령 채널의 파이프 이름. 이름에 pid 가 들어가므로 **밖에서 찾으려면 이게 필요하다.**
   * 빈 문자열이면 옛 hello 이거나 서버를 아예 만들지 못한 것이다.
   */
  pipeName: string
  /** 파이프가 열렸는가. false 면 조회·조작이 안 되고 hello 스냅샷만 남는다 */
  pipeListening: boolean
  /** 못 열었을 때의 이유. **이게 없으면 "로드 실패" 와 구분되지 않는다** */
  pipeError: string
}

export type ParsedHello = { ok: true; hello: AgentHello } | { ok: false; reason: string }

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function parseWidget(raw: unknown): AgentWidget | null {
  if (raw === null || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const node: AgentWidget = {
    class: str(w.class),
    objectName: str(w.objectName),
    visible: bool(w.visible),
    enabled: bool(w.enabled),
    x: num(w.x),
    y: num(w.y),
    width: num(w.width),
    height: num(w.height),
    screenX: num(w.screenX),
    screenY: num(w.screenY),
  }
  // 빈 라벨은 플러그인이 아예 싣지 않는다. 여기서도 빈 문자열을 만들지 않는다 —
  // `text: ''` 와 "text 가 없다" 를 구분해야 검색이 빈 needle 에 다 걸리지 않는다.
  if (typeof w.text === 'string' && w.text !== '') node.text = w.text
  if (typeof w.toolTip === 'string' && w.toolTip !== '') node.toolTip = w.toolTip
  if (typeof w.accessibleName === 'string' && w.accessibleName !== '') {
    node.accessibleName = w.accessibleName
  }
  if (typeof w.windowTitle === 'string' && w.windowTitle !== '') node.windowTitle = w.windowTitle
  if (Array.isArray(w.actions)) {
    const acts = w.actions.filter((a): a is string => typeof a === 'string' && a !== '')
    if (acts.length > 0) node.actions = acts
  }
  if (Array.isArray(w.children)) {
    const kids = w.children.map(parseWidget).filter((k): k is AgentWidget => k !== null)
    if (kids.length > 0) node.children = kids
  }
  return node
}

/**
 * hello 파일을 검증한다. **던지지 않고 이유를 돌려준다** — 플러그인이 로드되지 않은
 * 것과 파일이 깨진 것을 갈라 말해야 원인을 짚을 수 있다.
 */
export function parseAgentHello(raw: unknown): ParsedHello {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'hello 가 객체가 아니다.' }
  }
  const h = raw as Record<string, unknown>

  if (h.loaded !== true) {
    return { ok: false, reason: `loaded 가 true 가 아니다: ${JSON.stringify(h.loaded)}` }
  }
  if (str(h.qtRuntime) === '') {
    return { ok: false, reason: 'qtRuntime 이 없다 — 플러그인이 Qt 를 못 불렀다.' }
  }

  const tops = Array.isArray(h.topLevelWidgets)
    ? h.topLevelWidgets.map(parseWidget).filter((w): w is AgentWidget => w !== null)
    : []

  return {
    ok: true,
    hello: {
      loaded: true,
      styleKey: str(h.styleKey),
      attempts: num(h.attempts, -1),
      sawUi: bool(h.sawUi),
      // 옛 hello 에는 이 셋이 없다. 없으면 -1/false 로 둬서 **"정착했다" 를 공짜로
      // 얻지 못하게** 한다 — 모르는 것을 좋은 쪽으로 채우면 조용히 틀린다.
      settled: bool(h.settled),
      widgetTotal: num(h.widgetTotal, -1),
      writeCount: num(h.writeCount, -1),
      elapsedMs: num(h.elapsedMs, -1),
      pid: num(h.pid),
      qtCompiled: str(h.qtCompiled),
      qtRuntime: str(h.qtRuntime),
      writtenAt: str(h.writtenAt),
      appFilePath: str(h.appFilePath),
      topLevelCount: num(h.topLevelCount, tops.length),
      topLevelWidgets: tops,
      widgetBudgetLeft: num(h.widgetBudgetLeft, -1),
      pipeName: str(h.pipeName),
      pipeListening: bool(h.pipeListening),
      pipeError: str(h.pipeError),
    },
  }
}

export type AbiVerdict = {
  /** 컴파일 시점과 런타임 Qt 가 맞는가 */
  match: boolean
  reason: string
}

/**
 * ABI 가 맞는가.
 *
 * **버전이 다르면 지금 동작해도 나중에 조용히 깨진다.** Qt 는 패치 버전 사이에
 * 바이너리 호환을 지키지만, 플러그인이 다른 마이너 버전으로 컴파일됐다면
 * 애초에 로드되지 않아야 한다 — 로드된 채 버전이 다르면 전제가 어긋난 것이므로
 * 알려야 한다.
 */
export function judgeAbi(hello: AgentHello): AbiVerdict {
  if (hello.qtCompiled === '') {
    return { match: false, reason: '컴파일 시점 Qt 버전을 알 수 없다.' }
  }
  if (hello.qtCompiled !== hello.qtRuntime) {
    return {
      match: false,
      reason: `컴파일은 Qt ${hello.qtCompiled}, 런타임은 ${hello.qtRuntime} 다. 같은 Qt 로 빌드해야 한다.`,
    }
  }
  return { match: true, reason: `컴파일·런타임 모두 Qt ${hello.qtRuntime}.` }
}

export type TreeVerdict = {
  /** 이 트리를 근거로 판단해도 되는가 */
  trustworthy: boolean
  reason: string
  /** 트리가 상한에 잘렸는가. trustworthy 와 별개다 — 잘려도 있는 것은 진짜다 */
  truncated: boolean
}

/**
 * 위젯 트리를 믿을 수 있는가.
 *
 * **"UI 를 봤다" 로는 부족하다.** 대상 앱은 메인 창보다 65초 먼저 스플래시를 띄우고,
 * 그 동안 "보이는 최상위 위젯" 이 이미 존재한다. 그때 찍은 트리는 위젯이 대부분
 * `640x480`(레이아웃 전 Qt 기본 크기)에 숨김 상태인 쓰레기다 — 2026-09-09 에 실제로
 * 그걸 잡았다. 그래서 **개수가 멈췄다는 것(`settled`)까지 요구한다.**
 *
 * 잘림(`truncated`)은 신뢰와 별개다. 상한에 닿으면 **"없다" 를 단정할 수 없을** 뿐,
 * 트리에 실려 있는 것은 여전히 진짜다. 그래서 따로 돌려준다.
 */
export function judgeTree(hello: AgentHello): TreeVerdict {
  const truncated = hello.widgetBudgetLeft === 0
  if (!hello.sawUi) {
    return {
      trustworthy: false,
      reason: '상한까지 기다려도 보이는 창이 없었다. 트리가 빈 것은 "위젯이 없다" 가 아니다.',
      truncated,
    }
  }
  if (!hello.settled) {
    return {
      trustworthy: false,
      reason: '위젯 개수가 멈추기 전에 찍혔다. 시작 중(스플래시) 트리일 수 있다.',
      truncated,
    }
  }
  return { trustworthy: true, reason: '개수가 멈춘 뒤에 찍혔다.', truncated }
}

/** 위젯 트리를 평평하게 펼친다. 이름으로 찾을 때 쓴다. */
export function flattenWidgets(widgets: readonly AgentWidget[]): AgentWidget[] {
  const out: AgentWidget[] = []
  const walk = (w: AgentWidget) => {
    out.push(w)
    for (const c of w.children ?? []) walk(c)
  }
  for (const w of widgets) walk(w)
  return out
}

/**
 * objectName 으로 위젯을 찾는다.
 *
 * **UIA 와 달리 여기는 경로가 아니라 원래 이름이다.** UIA 는 부모 이름을 붙여
 * `zwqtfixtureMainWindow.centralArea.fixtureTarget` 로 주지만, 프로세스 안에서는
 * `objectName` 이 그대로 `fixtureTarget` 이다. 둘을 섞으면 못 찾는다.
 */
export function findWidgets(widgets: readonly AgentWidget[], objectName: string): AgentWidget[] {
  if (objectName === '') return []
  return flattenWidgets(widgets).filter((w) => w.objectName === objectName)
}

/**
 * 위젯의 화면 절대 좌표를 **창 기준 좌표**로 바꾼다.
 *
 * 규칙은 하나다 — **캡처 사각형의 원점을 뺀다.** `zwwin.exe` 의 `click` 이 정확히
 * 그 역연산을 하고(`screenX = Rect.Left + x`), `uia` 의 `wx`·`wy` 도 같은 규칙으로
 * 만들어진다. 그래서 여기서 나온 좌표가 **`shot` 의 PNG 좌표이자 `click` 이 받는 좌표**다.
 *
 * **원점을 UIA 사각형에서 가져오면 8px 어긋난다.** 창 UIA 사각형은 보이지 않는 리사이즈
 * 테두리를 포함해서 실측 `3432,-8` 인데 캡처 사각형은 `3440,0` 이다. `listWindows` 가
 * 주는 `x`·`y` 가 캡처 사각형 원점이므로 그것만 쓴다.
 *
 * @param origin 대상 창의 캡처 사각형 원점 (`listWindows` 의 `x`·`y`)
 */
export function toWindowPoint(
  w: Pick<AgentWidget, 'screenX' | 'screenY'>,
  origin: { x: number; y: number },
): { wx: number; wy: number } {
  return { wx: w.screenX - origin.x, wy: w.screenY - origin.y }
}

/** 위젯 한가운데의 창 기준 좌표. 누를 지점이다. */
export function widgetCenter(
  w: Pick<AgentWidget, 'screenX' | 'screenY' | 'width' | 'height'>,
  origin: { x: number; y: number },
): { x: number; y: number } {
  const p = toWindowPoint(w, origin)
  return { x: p.wx + Math.floor(w.width / 2), y: p.wy + Math.floor(w.height / 2) }
}

/**
 * 이 위젯을 가리킬 수 있는 이름 전부.
 *
 * **어느 출처에 라벨이 있는지는 위젯마다 다르다.** 툴바 버튼은 objectName 이 비어 있고
 * 툴팁이나 액션 텍스트에만 글자가 있다 (실앱에서 보이는 `zwQtButton` 56개 중 objectName
 * 이 있는 것은 0개다). 그래서 **고르지 않고 다 모아서 찾는다** — 어느 쪽에 걸리든 같은
 * 위젯이다.
 */
export function widgetLabels(w: AgentWidget): string[] {
  const out: string[] = []
  if (w.objectName !== '') out.push(w.objectName)
  if (w.text !== undefined) out.push(w.text)
  if (w.toolTip !== undefined) out.push(w.toolTip)
  if (w.accessibleName !== undefined) out.push(w.accessibleName)
  if (w.windowTitle !== undefined) out.push(w.windowTitle)
  for (const a of w.actions ?? []) out.push(a)
  return out
}

/**
 * 라벨로 위젯을 찾는다. 대소문자를 무시하고 부분 일치를 인정한다.
 *
 * 부분 일치인 이유는 라벨이 잘리거나 접미사가 붙기 때문이다 — 실앱에 `btn_enable snap (u)`
 * 처럼 단축키가 붙은 것이 있다. **여러 개가 맞으면 다 돌려준다.** 하나를 골라 누르는 것은
 * 호출자의 일이고, 겹칠 때 조용히 첫 번째를 누르면 틀린 곳을 누른다.
 */
export function findByLabel(widgets: readonly AgentWidget[], needle: string): AgentWidget[] {
  if (needle === '') return []
  const n = needle.toLowerCase()
  return flattenWidgets(widgets).filter((w) =>
    widgetLabels(w).some((l) => l.toLowerCase().includes(n)),
  )
}
