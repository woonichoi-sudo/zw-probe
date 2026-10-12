// 위젯 트리 → UIA 노드 목록. **macOS 에는 UIA 가 없다** — 대신 zwagent 가 프로세스 안에서 읽은
// 위젯 트리를 Windows UIA(Raw view)가 Qt 위젯에 대해 내놓는 모양으로 옮긴다. 그래야 `uia`·
// `click --name`·`doc`·시나리오의 `clickName`·`expectElement`·`expectPanel` 이 판정 코드를 안 바꾸고
// 그대로 돈다. **순수 함수다** (절대 규칙 5).
//
// 옮기는 규칙은 Qt 의 Windows UIA 제공자를 따른다:
// - **보이지 않는 위젯은 뺀다(자손까지).** UIA 는 숨은 위젯을 트리에 안 낸다 — 비활성 dock 이
//   안 나오는 것이 활성 탭 판정의 근거다(tree.ts `activePanel`).
// - **AutomationId 는 objectName 경로다.** 자기부터 위로 올라가며 이름을 `.` 으로 잇고, 이름 없는
//   조상을 만나면 멈춘다(Qt `automationIdForAccessible`). 자기 이름이 없으면 빈 값이다.
// - **이름**은 accessibleName → text → windowTitle 순. 최상위 창 노드는 창 제목이다.
// - **ControlType** 은 클래스 이름에서 어림한다. 판정은 이름·id 로 하고 이것은 거르기 보조다.

import type { AgentWidget } from '../agent/hello.ts'
import type { UiaNode } from '../uia/tree.ts'

/** 클래스 이름 → UIA ControlType 어림. 맞는 것이 없으면 'Pane'. */
export function controlTypeOf(cls: string): string {
  const c = cls.replace(/^.*::/, '')
  const rules: Array<[RegExp, string]> = [
    [/MenuBar$/, 'MenuBar'],
    [/Menu$/, 'Menu'],
    [/CheckBox$/, 'CheckBox'],
    [/RadioButton$/, 'RadioButton'],
    [/ComboBox$/, 'ComboBox'],
    [/(SpinBox|Spinbox)$/, 'Spinner'],
    [/(LineEdit|TextEdit|PlainTextEdit)$/, 'Edit'],
    [/Slider$/, 'Slider'],
    [/ScrollBar$/, 'ScrollBar'],
    [/TabBar$/, 'Tab'],
    [/(Button|ToolButton)$/, 'Button'],
    [/Label$/, 'Text'],
    [/(MainWindow|Dialog)$/, 'Window'],
    [/(TreeView|TreeWidget)$/, 'Tree'],
    [/(ListView|ListWidget)$/, 'List'],
    [/(TableView|TableWidget)$/, 'Table'],
  ]
  for (const [re, t] of rules) if (re.test(c)) return t
  return 'Pane'
}

/**
 * 단축 표시 `&` 를 걷어낸다 — Qt 의 접근성 이름이 그렇게 한다(`&No` → `No`, `&&` → `&`). Windows UIA 실측이
 * `Yes`·`No`·`Cancel` 이었다(2026-09-14). 안 걷으면 `click --name No` 가 정확 일치를 놓친다.
 */
export function stripMnemonic(s: string): string {
  return s.replace(/&(&?)/g, (_m, amp: string) => amp)
}

export type UiaFromTreeOptions = {
  /** 창 기준 좌표의 원점(창 클라이언트 영역의 화면 좌표) */
  originX: number
  originY: number
  /** 몇 단계까지. 기본 24 (zwwin uia 와 같다) */
  maxDepth?: number
  /** 노드 상한. 기본 2000 (zwwin uia 와 같다) */
  maxNodes?: number
}

/** 한 최상위 창의 위젯 트리를 UIA 노드 목록으로. 깊이 우선, 부모가 자식보다 먼저 온다. */
export function uiaFromTree(
  root: AgentWidget,
  opts: UiaFromTreeOptions,
): { nodes: UiaNode[]; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 24
  const maxNodes = opts.maxNodes ?? 2000
  const nodes: UiaNode[] = []
  let truncated = false

  const visit = (w: AgentWidget, depth: number, parentId: string): void => {
    if (!w.visible) return
    if (nodes.length >= maxNodes) {
      truncated = true
      return
    }
    const id = w.objectName === '' ? '' : parentId === '' ? w.objectName : `${parentId}.${w.objectName}`
    const name = stripMnemonic(w.accessibleName || w.text || (depth === 0 ? (w.windowTitle ?? '') : '') || '')
    nodes.push({
      depth,
      controlType: controlTypeOf(w.class),
      name,
      automationId: id,
      class: w.class,
      enabled: w.enabled,
      offscreen: false,
      hasRect: true,
      screenX: w.screenX,
      screenY: w.screenY,
      width: w.width,
      height: w.height,
      wx: w.screenX - opts.originX,
      wy: w.screenY - opts.originY,
    })
    if (depth >= maxDepth) {
      if ((w.children?.length ?? 0) > 0) truncated = true
      return
    }
    for (const c of w.children ?? []) visit(c, depth + 1, id)
  }
  visit(root, 0, '')
  return { nodes, truncated }
}

/** 트리의 최상위 위젯 중 창 하나를 고른다 — 클래스·objectName·화면 사각형이 다 맞아야 한다. */
export function findTopLevel(
  tops: readonly AgentWidget[],
  win: { class: string; objectName: string; x: number; y: number; width: number; height: number },
): AgentWidget | null {
  const hits = tops.filter(
    (t) =>
      t.visible &&
      t.class === win.class &&
      t.objectName === win.objectName &&
      t.screenX === win.x &&
      t.screenY === win.y &&
      t.width === win.width &&
      t.height === win.height,
  )
  return hits.length === 1 ? hits[0]! : null
}

/**
 * 소유 창(다이얼로그)의 노드를 소유 창 아래로 붙인다. **Windows UIA 가 그렇게 보여준다** — 소유 다이얼로그는
 * 데스크톱이 아니라 소유 창의 자식으로 달린다(CLAUDE.md "텍스처 슬롯" 실측). 그래서 메인 창 기준 `uia`·
 * `click --name` 이 다이얼로그 버튼까지 닿는다. 깊이는 하나 내리고 좌표는 그대로(같은 원점으로 만든 것).
 */
export function nestOwned(base: readonly UiaNode[], owned: readonly UiaNode[][]): UiaNode[] {
  // 위젯 부모가 소유 창인 다이얼로그는 이미 트리 안에 있다(QDialog 는 자식 위젯이다) — 두 번 넣지 않는다
  const key = (n: UiaNode) => `${n.class}@${n.screenX},${n.screenY},${n.width}x${n.height}`
  const have = new Set(base.filter((n) => n.depth > 0).map(key))
  const fresh = owned.filter((nodes) => nodes.length > 0 && !have.has(key(nodes[0]!)))
  return [...base, ...fresh.flatMap((nodes) => nodes.map((n) => ({ ...n, depth: n.depth + 1 })))]
}

/** `root` 가 (직접·간접으로) 소유한 창 id 들. 소유 고리가 있어도 끝난다. */
export function ownedBy(root: number, windows: ReadonlyArray<{ id: number; owner: number }>): number[] {
  const out: number[] = []
  const seen = new Set<number>([root])
  let frontier = [root]
  while (frontier.length > 0) {
    const next: number[] = []
    for (const w of windows) {
      if (frontier.includes(w.owner) && !seen.has(w.id)) {
        seen.add(w.id)
        out.push(w.id)
        next.push(w.id)
      }
    }
    frontier = next
  }
  return out
}
