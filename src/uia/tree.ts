// UIA 트리에서 원하는 요소를 골라내는 순수 판정 (CLAUDE.md 절대 규칙 5).
//
// **왜 이 층이 필요한가.** UIA 는 좌표를 주지만 "어느 것이 내가 말한 그것인가" 는
// 말해주지 않는다. 이름이 겹치는 노드가 흔하다 — 예를 들어 대상 앱에는 `"Properties"`
// 라는 이름이 탭 라벨과 패널 안 그룹 제목에 둘 다 있다(2026-09-09 실측). 둘 중 아무거나
// 누르면 조용히 다른 일이 일어난다.
//
// 그래서 여러 개가 맞으면 **추측하지 않고 거부한다.** 틀린 단축키가 다른 명령을
// 실행하는 것과 같은 종류의 위험이고, 같은 방식으로 다룬다.

/** `zwwin.exe uia` 가 뱉는 노드 하나. 계층은 `depth` 로만 실린다. */
export type UiaNode = {
  depth: number
  /** UIA ControlType — 'Button', 'Text', 'MenuItem', 'Custom' 등 */
  controlType: string
  name: string
  automationId: string
  class: string
  enabled: boolean
  offscreen: boolean
  /** 사각형을 읽었는가. false 면 좌표는 의미가 없다 */
  hasRect: boolean
  screenX: number
  screenY: number
  width: number
  height: number
  /** 창 왼쪽 위 기준 — `click` 이 받는 좌표계와 같다 */
  wx: number
  wy: number
}

export type UiaDump = {
  elapsedMs: number
  maxDepth: number
  maxNodes: number
  /** 노드 상한에 닿아 트리가 잘렸는가. true 면 "없다" 를 믿을 수 없다 */
  truncated: boolean
  nodes: UiaNode[]
}

/** 무엇으로 찾을지. 여러 개를 주면 **모두** 만족해야 한다. */
export type NodeQuery = {
  /** 이름. 정확히 같은 것을 먼저 보고, 없으면 부분 일치를 본다 */
  name?: string
  /** AutomationId. 같은 규칙으로 본다 */
  automationId?: string
  /** 클래스 이름 — 정확히 일치 */
  class?: string
  /** ControlType — 정확히 일치 */
  controlType?: string
  /** 누를 수 있는 것만 남긴다: 사각형이 있고, 화면 밖이 아니고, 크기가 0 이 아니다 */
  clickableOnly?: boolean
}

/** 누를 수 있는 요소인가. 크기 0 이나 화면 밖 요소는 좌표가 있어도 못 누른다. */
export function isClickable(n: UiaNode): boolean {
  return n.hasRect && !n.offscreen && n.width > 0 && n.height > 0
}

/** 누를 자리 — 요소 사각형의 한가운데. 창 기준 좌표다. */
export function clickPoint(n: UiaNode): { x: number; y: number } {
  return {
    x: n.wx + Math.floor(n.width / 2),
    y: n.wy + Math.floor(n.height / 2),
  }
}

/**
 * 질의에 맞는 노드를 전부 돌려준다. 이름·id 는 **정확 일치를 먼저 본다** —
 * 정확히 맞는 것이 하나라도 있으면 부분 일치는 버린다. 그렇게 하지 않으면
 * `"Properties"` 를 찾을 때 `"Properties panel"` 같은 것이 섞여 늘 모호해진다.
 */
export function findNodes(nodes: readonly UiaNode[], q: NodeQuery): UiaNode[] {
  let pool = [...nodes]

  if (q.class !== undefined) pool = pool.filter((n) => n.class === q.class)
  if (q.controlType !== undefined) pool = pool.filter((n) => n.controlType === q.controlType)
  if (q.clickableOnly === true) pool = pool.filter(isClickable)

  if (q.name !== undefined) pool = narrow(pool, q.name, (n) => n.name)
  if (q.automationId !== undefined) pool = narrow(pool, q.automationId, (n) => n.automationId)

  return pool
}

/** 말줌임표. `ads::CElidingLabel` 이 자를 때 붙인다 — 세 점 형태도 함께 본다. */
const ELLIPSIS = /(?:…|\.\.\.)$/

/**
 * 텍스트가 잘려 있으면 잘린 앞부분이 needle 의 접두사인가.
 *
 * **왜 필요한가.** 대상 앱의 dock 탭 라벨은 `ads::CElidingLabel` 이라 폭이 좁으면
 * 텍스트를 자르고 UIA 는 **자른 문자열을 그대로 보고한다.** 실측(2026-09-09):
 * 다른 탭이 선택되자 `"Properties"` 가 `"Properti…"` 로 바뀌어 정확 일치가 실패했다.
 * 폭은 어느 탭이 선택됐는지에 따라 변하므로, 이걸 처리하지 않으면 시나리오가
 * 앞 단계의 결과에 따라 조용히 요소를 못 찾는다.
 */
function matchesElided(text: string, needle: string): boolean {
  if (!ELLIPSIS.test(text)) return false
  const stem = text.replace(ELLIPSIS, '')
  // 잘린 앞부분이 비었으면(텍스트가 "…" 뿐) 아무것과도 맞다고 볼 수 없다.
  return stem !== '' && needle.toLowerCase().startsWith(stem.toLowerCase())
}

/**
 * 정확 일치가 있으면 그것만, 없으면 느슨한 일치(부분 일치 또는 잘린 접두사).
 * 빈 문자열은 아무것도 맞히지 않는다.
 */
function narrow(pool: UiaNode[], needle: string, pick: (n: UiaNode) => string): UiaNode[] {
  if (needle === '') return []
  const exact = pool.filter((n) => pick(n) === needle)
  if (exact.length > 0) return exact
  const lower = needle.toLowerCase()
  return pool.filter((n) => {
    const text = pick(n)
    return text.toLowerCase().includes(lower) || matchesElided(text, needle)
  })
}

export type FindOne =
  | { found: true; node: UiaNode; reason: string }
  | { found: false; candidates: UiaNode[]; reason: string }

/**
 * 딱 하나를 고른다. 없거나 여럿이면 **거부한다.** 여럿일 때 첫 번째를 집으면
 * 조용히 다른 것을 누르게 된다.
 *
 * `truncated` 를 함께 받는 이유: 트리가 잘렸으면 "없다" 는 결론을 낼 수 없다.
 * 못 찾은 것과 안 본 것을 갈라 말해야 한다.
 */
export function findOne(dump: UiaDump, q: NodeQuery): FindOne {
  const hits = findNodes(dump.nodes, q)
  const asked = describeQuery(q)

  if (hits.length === 1) {
    return { found: true, node: hits[0]!, reason: `${asked} 에 맞는 요소가 하나다.` }
  }
  if (hits.length === 0) {
    const cut = dump.truncated
      ? ` 트리가 ${dump.maxNodes}개에서 잘렸으니 없다고 단정할 수 없다 — --max 를 올려 다시 본다.`
      : ''
    return { found: false, candidates: [], reason: `${asked} 에 맞는 요소가 없다.${cut}` }
  }
  const listed = hits
    .slice(0, 6)
    .map((n) => `[${n.controlType}] "${n.name}" id="${n.automationId}" cls=${n.class} (${n.wx},${n.wy})`)
    .join('\n      ')
  return {
    found: false,
    candidates: hits,
    reason:
      `${asked} 에 맞는 요소가 ${hits.length}개다. 무엇을 누를지 정할 수 없다 — ` +
      `--id 나 --class 로 좁힌다.\n      ${listed}${hits.length > 6 ? '\n      ...' : ''}`,
  }
}

function describeQuery(q: NodeQuery): string {
  const parts: string[] = []
  if (q.name !== undefined) parts.push(`name="${q.name}"`)
  if (q.automationId !== undefined) parts.push(`id="${q.automationId}"`)
  if (q.class !== undefined) parts.push(`class=${q.class}`)
  if (q.controlType !== undefined) parts.push(`type=${q.controlType}`)
  if (q.clickableOnly === true) parts.push('누를 수 있는 것')
  return parts.length > 0 ? parts.join(' ') : '(조건 없음)'
}

export type DocumentState = {
  /** 창 헤더에 실린 파일명. 못 읽으면 null */
  fileName: string | null
  /** 저장하지 않은 변경이 있는가. 파일명을 못 읽으면 null */
  dirty: boolean | null
  reason: string
}

/**
 * 열린 파일명과 dirty 플래그를 읽는다.
 *
 * **OS 창 제목에는 이 정보가 없다** — Windows 빌드는 커스텀 프레임리스 헤더 위젯에만
 * 넣고 `QMainWindow::setWindowTitle("")` 로 제목을 비운다(`zwQtFramelessWindow.cpp:46`).
 * UIA 가 그 위젯의 텍스트를 노출하므로 여기가 유일한 외부 경로다.
 *
 * 형식은 `파일명` 또는 `파일명 *` 이다 — dirty 면 `" *"` 가 붙는다(같은 파일 47행).
 */
export function readDocumentState(dump: UiaDump): DocumentState {
  const header = dump.nodes.find((n) => n.automationId.endsWith('FramelessWindowHeader'))
  if (header === undefined) {
    return {
      fileName: null,
      dirty: null,
      reason:
        'FramelessWindowHeader 요소를 찾지 못했다. UIA 가 헤더를 노출하지 않거나 트리가 잘렸다.',
    }
  }
  const text = header.name.trim()
  const dirty = text.endsWith('*')
  const fileName = dirty ? text.slice(0, -1).trim() : text

  // 파일명이 비는 두 경우를 갈라야 한다. 헤더가 아예 빈 것과 dirty 표시(`" *"`)만
  // 있는 것 — 앞은 dirty 를 모르고 뒤는 dirty 가 참이다. 같은 파일 55행에서
  // filename 이 비면 헤더 텍스트가 dirtyString 뿐이 된다.
  if (fileName === '') {
    return {
      fileName: null,
      dirty: dirty ? true : null,
      reason: dirty ? '헤더에 dirty 표시만 있고 파일명이 없다.' : '헤더 텍스트가 비어 있다.',
    }
  }

  return {
    fileName,
    dirty,
    reason: `헤더 텍스트 "${header.name}" 에서 읽었다.`,
  }
}

/** ADS(Advanced Docking System) 클래스 이름들. 대상 앱이 오른쪽 패널에 쓴다. */
const DOCK_WIDGET_CLASS = 'ads::CDockWidget'
const DOCK_TAB_CLASS = 'ads::CDockWidgetTab'
const TAB_LABEL_ID = 'dockWidgetTabLabel'
const TAB_CLOSE_ID = 'tabCloseButton'
/** 패널 dock 의 AutomationId 접두사. `dock_avatar`, `dock_properties` 처럼 온다. */
const DOCK_ID_PREFIX = 'dock_'

export type ActivePanel = {
  /**
   * 열려 있는 dock 의 이름. `dock_avatar` → `'avatar'`. 못 알아내면 null.
   *
   * **이것이 가장 튼튼한 신호다.** 비활성 dock 위젯은 UIA 트리에 아예 나오지
   * 않으므로(실측 2026-09-09: Properties 활성일 때 `dock_properties` 만, Avatar
   * 활성일 때 `dock_avatar` 만) 남아 있는 것이 활성 탭이다. 현지화되지 않고
   * 잘리지도 않는다.
   */
  dockId: string | null
  /**
   * 활성 탭의 라벨 텍스트. 못 알아내면 null.
   *
   * 닫기 버튼(`tabCloseButton`)이 활성 탭 안에만 있으므로, 그것을 품은 탭
   * 사각형 안의 라벨을 읽는다. **잘려 있을 수 있다**(`"Properti…"`) — 사람에게
   * 보여주는 용도이고 판정은 `dockId` 로 한다.
   */
  tabName: string | null
  reason: string
}

/** 점이 노드 사각형 안인가. */
function contains(n: UiaNode, x: number, y: number): boolean {
  return n.hasRect && x >= n.wx && y >= n.wy && x < n.wx + n.width && y < n.wy + n.height
}

/**
 * 오른쪽 패널에서 어느 탭이 활성인가.
 *
 * **왜 필요한가.** 탭 라벨의 *존재* 는 그 탭이 활성이라는 뜻이 아니다. 여섯 개 라벨이
 * 늘 다 있다. 2026-09-09 에 시나리오의 사전 조건을 `expectElement name="Simulation"`
 * 으로 쓴 것이 통과했는데 실제로는 Avatar 탭이 활성이었다 — **거짓 확신을 준 검사였다.**
 */
export function activePanel(dump: UiaDump): ActivePanel {
  // ① dock id — 비활성 dock 은 트리에 없다.
  const docks = dump.nodes.filter(
    (n) => n.class === DOCK_WIDGET_CLASS && n.automationId.startsWith(DOCK_ID_PREFIX),
  )
  const dockId =
    docks.length === 1 ? docks[0]!.automationId.slice(DOCK_ID_PREFIX.length) || null : null

  // ② 탭 이름 — 닫기 버튼을 품은 탭이 활성이다.
  const close = dump.nodes.find((n) => n.automationId === TAB_CLOSE_ID && n.hasRect)
  let tabName: string | null = null
  if (close !== undefined) {
    const cx = close.wx + Math.floor(close.width / 2)
    const cy = close.wy + Math.floor(close.height / 2)
    const tab = dump.nodes.find((n) => n.class === DOCK_TAB_CLASS && contains(n, cx, cy))
    if (tab !== undefined) {
      const label = dump.nodes.find(
        (n) =>
          n.automationId === TAB_LABEL_ID &&
          n.hasRect &&
          n.wx >= tab.wx &&
          n.wx < tab.wx + tab.width,
      )
      if (label !== undefined && label.name !== '') tabName = label.name
    }
  }

  const notes: string[] = []
  if (dockId === null) {
    notes.push(
      docks.length === 0
        ? `${DOCK_ID_PREFIX}* dock 위젯이 트리에 없다 (트리가 잘렸거나 패널이 닫혀 있다)`
        : `${DOCK_ID_PREFIX}* dock 이 ${docks.length}개다: ${docks.map((d) => d.automationId).join(', ')}`,
    )
  }
  if (tabName === null) notes.push('활성 탭 라벨을 찾지 못했다')

  return {
    dockId,
    tabName,
    reason:
      notes.length === 0
        ? `dock=${dockId}, 탭="${tabName}"`
        : `${dockId !== null ? `dock=${dockId}` : ''}${tabName !== null ? ` 탭="${tabName}"` : ''} (${notes.join('; ')})`.trim(),
  }
}
