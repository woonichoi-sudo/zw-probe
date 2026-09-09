// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/uia/tree.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activePanel, clickPoint, findNodes, findOne, isClickable, readDocumentState } from './tree.ts'
import type { UiaDump, UiaNode } from './tree.ts'

function node(p: Partial<UiaNode> = {}): UiaNode {
  return {
    depth: p.depth ?? 1,
    controlType: p.controlType ?? 'Text',
    name: p.name ?? '',
    automationId: p.automationId ?? '',
    class: p.class ?? 'QLabel',
    enabled: p.enabled ?? true,
    offscreen: p.offscreen ?? false,
    hasRect: p.hasRect ?? true,
    screenX: p.screenX ?? 100,
    screenY: p.screenY ?? 100,
    width: p.width ?? 60,
    height: p.height ?? 20,
    wx: p.wx ?? 10,
    wy: p.wy ?? 20,
  }
}

function dump(nodes: UiaNode[], p: Partial<UiaDump> = {}): UiaDump {
  return {
    elapsedMs: p.elapsedMs ?? 100,
    maxDepth: p.maxDepth ?? 24,
    maxNodes: p.maxNodes ?? 2000,
    truncated: p.truncated ?? false,
    nodes,
  }
}

test('clickPoint — 사각형 한가운데. 창 기준 좌표를 쓴다', () => {
  const p = clickPoint(node({ wx: 1380, wy: 32, width: 65, height: 18 }))
  assert.deepEqual(p, { x: 1412, y: 41 })
})

test('clickPoint — 홀수 크기에서도 창 안에 남는다', () => {
  const p = clickPoint(node({ wx: 0, wy: 0, width: 1, height: 1 }))
  assert.deepEqual(p, { x: 0, y: 0 })
})

test('isClickable — 사각형 없음·화면 밖·크기 0 을 걸러낸다', () => {
  assert.equal(isClickable(node()), true)
  assert.equal(isClickable(node({ hasRect: false })), false)
  assert.equal(isClickable(node({ offscreen: true })), false)
  assert.equal(isClickable(node({ width: 0 })), false)
  assert.equal(isClickable(node({ height: 0 })), false)
  // 비활성 요소는 좌표가 유효하므로 누를 수는 있다. 눌러도 반응이 없다는 것은
  // 다른 문제이고, 여기서 걸러버리면 "왜 못 찾았나" 를 설명할 수 없다.
  assert.equal(isClickable(node({ enabled: false })), true)
})

test('findNodes — 정확 일치가 있으면 부분 일치를 버린다', () => {
  // 이 규칙이 없으면 "Properties" 를 찾을 때 "Properties panel" 이 늘 섞여 모호해진다.
  const exact = node({ name: 'Properties' })
  const partial = node({ name: 'Properties panel' })
  const hits = findNodes([partial, exact], { name: 'Properties' })
  assert.deepEqual(hits, [exact])
})

test('findNodes — 정확 일치가 없으면 부분 일치, 대소문자 무시', () => {
  const n = node({ name: 'Draping board' })
  assert.deepEqual(findNodes([n], { name: 'draping' }), [n])
})

test('findNodes — 빈 문자열은 아무것도 맞히지 않는다', () => {
  // 빈 needle 을 부분 일치로 흘리면 전부 맞아버린다.
  assert.deepEqual(findNodes([node({ name: 'x' })], { name: '' }), [])
})

test('findNodes — 조건 여러 개는 모두 만족해야 한다', () => {
  const tab = node({ name: 'Properties', automationId: 'dockWidgetTabLabel', class: 'ads::CElidingLabel' })
  const title = node({ name: 'Properties', automationId: 'HeaderWidget.TitleLabel', class: 'QLabel' })
  const hits = findNodes([tab, title], { name: 'Properties', class: 'QLabel' })
  assert.deepEqual(hits, [title])
})

test('findNodes — clickableOnly 는 이름 조건과 함께 걸린다', () => {
  const shown = node({ name: 'Go' })
  const hidden = node({ name: 'Go', offscreen: true })
  assert.deepEqual(findNodes([shown, hidden], { name: 'Go', clickableOnly: true }), [shown])
})

test('findNodes — controlType 은 정확 일치', () => {
  const btn = node({ name: 'Go', controlType: 'Button' })
  const txt = node({ name: 'Go', controlType: 'Text' })
  assert.deepEqual(findNodes([btn, txt], { name: 'Go', controlType: 'Button' }), [btn])
})

test('findOne — 하나면 고른다', () => {
  const n = node({ name: 'Simulation' })
  const r = findOne(dump([n]), { name: 'Simulation' })
  assert.equal(r.found, true)
  assert.equal(r.found === true && r.node, n)
})

test('findOne — 여럿이면 거부하고 후보를 보여준다', () => {
  // 2026-09-09 실측: 대상 앱의 "Properties" 는 탭 라벨과 패널 제목 둘에 있다.
  // 첫 번째를 집으면 조용히 다른 것을 누른다.
  const tab = node({ name: 'Properties', automationId: 'dockWidgetTabLabel', wx: 1759, wy: 32 })
  const title = node({ name: 'Properties', automationId: 'HeaderWidget.TitleLabel', wx: 1398, wy: 64 })
  const r = findOne(dump([tab, title]), { name: 'Properties' })

  assert.equal(r.found, false)
  assert.equal(r.found === false && r.candidates.length, 2)
  assert.match(r.reason, /2개/)
  assert.match(r.reason, /dockWidgetTabLabel/)
  assert.match(r.reason, /HeaderWidget\.TitleLabel/)
})

test('findOne — 후보가 많으면 앞의 여섯 개만 나열한다', () => {
  const many = Array.from({ length: 9 }, (_, i) => node({ name: 'Go', automationId: `id${i}` }))
  const r = findOne(dump(many), { name: 'Go' })
  assert.equal(r.found, false)
  assert.match(r.reason, /9개/)
  assert.match(r.reason, /id5/)
  assert.doesNotMatch(r.reason, /id6/)
  assert.match(r.reason, /\.\.\./)
})

test('findOne — 없으면 없다고 한다', () => {
  const r = findOne(dump([node({ name: 'Simulation' })]), { name: 'Fabric' })
  assert.equal(r.found, false)
  assert.match(r.reason, /없다/)
  assert.doesNotMatch(r.reason, /잘렸/)
})

test('findOne — 트리가 잘렸으면 "없다" 를 단정하지 않는다', () => {
  // 못 찾은 것과 안 본 것은 다르다. 섞으면 "그 요소는 없다" 라는 틀린 결론이 나온다.
  const r = findOne(dump([], { truncated: true, maxNodes: 50 }), { name: 'Fabric' })
  assert.equal(r.found, false)
  assert.match(r.reason, /잘렸/)
  assert.match(r.reason, /50개/)
})

test('readDocumentState — 헤더에서 파일명을 읽는다', () => {
  // 2026-09-09 실측: id="zwQtMainWindow.FramelessWindowHeader", name="Untitled.zls"
  const header = node({
    automationId: 'zwQtMainWindow.FramelessWindowHeader',
    name: 'Untitled.zls',
    class: 'zwQtWindowHeader',
  })
  const s = readDocumentState(dump([node({ name: 'z-weave', depth: 0 }), header]))
  assert.equal(s.fileName, 'Untitled.zls')
  assert.equal(s.dirty, false)
})

test('readDocumentState — dirty 는 " *" 로 붙는다', () => {
  // zwQtFramelessWindow.cpp:47 — dirtyString = (dirty ? " *" : "")
  const header = node({
    automationId: 'zwQtMainWindow.FramelessWindowHeader',
    name: 'Shirt.zls *',
  })
  const s = readDocumentState(dump([header]))
  assert.equal(s.fileName, 'Shirt.zls')
  assert.equal(s.dirty, true)
})

test('readDocumentState — 파일명 없이 dirty 표시만 있는 경우', () => {
  // 같은 파일 55행: filename 이 비면 헤더 텍스트가 dirtyString 뿐이다.
  const s = readDocumentState(dump([node({ automationId: 'FramelessWindowHeader', name: ' *' })]))
  assert.equal(s.fileName, null)
  assert.equal(s.dirty, true)
})

test('readDocumentState — 헤더가 없으면 모른다고 한다', () => {
  const s = readDocumentState(dump([node({ name: 'z-weave', depth: 0 })]))
  assert.equal(s.fileName, null)
  assert.equal(s.dirty, null)
  assert.match(s.reason, /FramelessWindowHeader/)
})

test('readDocumentState — 헤더 텍스트가 비면 dirty 를 모른다고 한다', () => {
  const s = readDocumentState(dump([node({ automationId: 'FramelessWindowHeader', name: '' })]))
  assert.equal(s.fileName, null)
  assert.equal(s.dirty, null)
})

test('findNodes — 잘린 라벨을 접두사로 인정한다', () => {
  // 실측(2026-09-09): 다른 탭이 선택되자 dock 탭 라벨이 "Properties" → "Properti…"
  // 로 바뀌어 정확 일치가 실패했다. 폭이 선택 상태에 따라 변하므로 시나리오가
  // 앞 단계 결과에 따라 조용히 요소를 못 찾는다.
  const elided = node({ name: 'Properti…', class: 'ads::CElidingLabel' })
  assert.deepEqual(findNodes([elided], { name: 'Properties' }), [elided])
})

test('findNodes — 세 점 형태도 인정한다', () => {
  const elided = node({ name: 'Draping bo...' })
  assert.deepEqual(findNodes([elided], { name: 'Draping board' }), [elided])
})

test('findNodes — 잘린 앞부분이 needle 의 접두사가 아니면 안 맞는다', () => {
  const elided = node({ name: 'Renderi…' })
  assert.deepEqual(findNodes([elided], { name: 'Properties' }), [])
})

test('findNodes — 말줄임표뿐인 텍스트는 아무것과도 맞지 않는다', () => {
  // 잘린 앞부분이 비면 접두사 판정이 늘 참이 되어 모든 needle 을 맞혀버린다.
  assert.deepEqual(findNodes([node({ name: '…' })], { name: 'Properties' }), [])
})

test('findNodes — 정확 일치가 있으면 잘린 것을 버린다', () => {
  const full = node({ name: 'Properties', automationId: 'full' })
  const elided = node({ name: 'Properti…', automationId: 'elided' })
  assert.deepEqual(findNodes([elided, full], { name: 'Properties' }), [full])
})

test('findNodes — 잘리지 않은 텍스트에는 접두사 규칙을 적용하지 않는다', () => {
  // "Prop" 은 "Properties" 의 접두사지만, needle 이 더 길 때 잘림 없이 맞히면
  // 엉뚱한 요소가 걸린다. 말줄임표가 있을 때만 느슨하게 본다.
  assert.deepEqual(findNodes([node({ name: 'Prop' })], { name: 'Properties' }), [])
})

/** 실측(2026-09-09)에서 나온 구조를 최소로 재현한다. */
function panelTree(p: {
  dockIds?: string[]
  /** 활성 탭의 인덱스. -1 이면 닫기 버튼을 두지 않는다 */
  activeIndex?: number
  labels?: string[]
} = {}) {
  const dockIds = p.dockIds ?? ['dock_avatar']
  const labels = p.labels ?? ['Simulation', 'Fabric', 'Avatar', 'Draping board']
  const activeIndex = p.activeIndex ?? 2

  const nodes: UiaNode[] = []
  // 탭 컨테이너와 라벨. 실측 좌표를 닮게 둔다.
  let x = 1372
  labels.forEach((name, i) => {
    const w = 54 + name.length * 3
    nodes.push(node({ class: 'ads::CDockWidgetTab', name: '', wx: x, wy: 24, width: w, height: 35 }))
    nodes.push(
      node({ automationId: 'dockWidgetTabLabel', class: 'ads::CElidingLabel', name, wx: x + 8, wy: 32, width: w - 16, height: 18 }),
    )
    if (i === activeIndex) {
      // 닫기 버튼은 활성 탭 안에만 있다.
      nodes.push(node({ automationId: 'tabCloseButton', class: 'QPushButton', wx: x + w - 26, wy: 32, width: 20, height: 18 }))
    }
    x += w
  })
  for (const id of dockIds) {
    nodes.push(node({ class: 'ads::CDockWidget', automationId: id, wx: 1372, wy: 59, width: 550, height: 947 }))
  }
  // 중앙 위젯도 CDockWidget 이지만 dock_ 접두사가 아니다 — 걸러져야 한다.
  nodes.push(node({ class: 'ads::CDockWidget', automationId: 'CentralWidget', wx: -2, wy: 24, width: 1370, height: 982 }))
  return dump(nodes)
}

test('activePanel — 열려 있는 dock id 로 활성 탭을 안다', () => {
  // 비활성 dock 은 UIA 트리에 아예 나오지 않는다 (실측 2026-09-09).
  const p = activePanel(panelTree())
  assert.equal(p.dockId, 'avatar')
  assert.equal(p.tabName, 'Avatar')
})

test('activePanel — CentralWidget 은 패널 dock 으로 세지 않는다', () => {
  // 같은 클래스지만 dock_ 접두사가 아니다. 세면 늘 2개가 되어 판정이 죽는다.
  assert.equal(activePanel(panelTree({ dockIds: ['dock_properties'] })).dockId, 'properties')
})

test('activePanel — 닫기 버튼이 없으면 탭 이름을 모른다고 한다', () => {
  const p = activePanel(panelTree({ activeIndex: -1 }))
  assert.equal(p.dockId, 'avatar')
  assert.equal(p.tabName, null)
  assert.match(p.reason, /활성 탭 라벨/)
})

test('activePanel — dock 이 하나도 없으면 모른다고 한다', () => {
  const p = activePanel(panelTree({ dockIds: [] }))
  assert.equal(p.dockId, null)
  assert.match(p.reason, /트리가 잘렸거나 패널이 닫혀 있다/)
})

test('activePanel — dock 이 여럿이면 고르지 않고 개수를 말한다', () => {
  // 추측하면 조용히 틀린 탭을 활성으로 보고한다.
  const p = activePanel(panelTree({ dockIds: ['dock_avatar', 'dock_properties'] }))
  assert.equal(p.dockId, null)
  assert.match(p.reason, /2개/)
  assert.match(p.reason, /dock_avatar/)
})

test('activePanel — 잘린 탭 이름도 그대로 돌려준다', () => {
  // 판정은 dockId 로 하고 tabName 은 사람에게 보여주는 용도다.
  const p = activePanel(panelTree({ labels: ['Simulation', 'Properti…'], activeIndex: 1 }))
  assert.equal(p.tabName, 'Properti…')
})

test('activePanel — 빈 트리', () => {
  const p = activePanel(dump([]))
  assert.equal(p.dockId, null)
  assert.equal(p.tabName, null)
})
