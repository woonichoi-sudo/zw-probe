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
  x: number
  y: number
  width: number
  height: number
  children?: AgentWidget[]
}

export type AgentHello = {
  loaded: boolean
  styleKey: string
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
      pid: num(h.pid),
      qtCompiled: str(h.qtCompiled),
      qtRuntime: str(h.qtRuntime),
      writtenAt: str(h.writtenAt),
      appFilePath: str(h.appFilePath),
      topLevelCount: num(h.topLevelCount, tops.length),
      topLevelWidgets: tops,
      widgetBudgetLeft: num(h.widgetBudgetLeft, -1),
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
