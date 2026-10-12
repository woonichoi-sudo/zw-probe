import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { AgentWidget } from '../agent/hello.ts'
import { activePanel, findNodes } from '../uia/tree.ts'
import { controlTypeOf, findTopLevel, uiaFromTree } from './uiaFromTree.ts'

function w(p: Partial<AgentWidget> & { class: string }): AgentWidget {
  return { objectName: '', visible: true, enabled: true, x: 0, y: 0, width: 10, height: 10, screenX: 0, screenY: 0, ...p }
}

test('controlTypeOf — 클래스 이름 끝으로 어림하고 네임스페이스는 뗀다', () => {
  assert.equal(controlTypeOf('ads::CElidingLabel'), 'Text')
  assert.equal(controlTypeOf('zwQtButton'), 'Button')
  assert.equal(controlTypeOf('QComboBox'), 'ComboBox')
  assert.equal(controlTypeOf('zwQtMainWindow'), 'Window')
  assert.equal(controlTypeOf('QMenuBar'), 'MenuBar')
  assert.equal(controlTypeOf('ads::CDockWidget'), 'Pane')
})

test('uiaFromTree — AutomationId 는 이름 없는 조상에서 끊기는 objectName 경로다 (Qt 규칙)', () => {
  const root = w({
    class: 'zwQtMainWindow', objectName: 'zwQtMainWindow', windowTitle: 'a.zls *',
    children: [
      w({ class: 'QWidget', objectName: 'ViewWidget', children: [w({ class: 'ads::CDockManager', objectName: 'dock_manager' })] }),
      w({ class: 'QWidget', objectName: '', children: [w({ class: 'ads::CElidingLabel', objectName: 'dockWidgetTabLabel', text: 'Avat…' })] }),
    ],
  })
  const { nodes } = uiaFromTree(root, { originX: 0, originY: 0 })
  assert.deepEqual(nodes.map((n) => n.automationId), [
    'zwQtMainWindow', 'zwQtMainWindow.ViewWidget', 'zwQtMainWindow.ViewWidget.dock_manager', '', 'dockWidgetTabLabel',
  ])
  assert.equal(nodes[0]!.name, 'a.zls *', '최상위 창 노드의 이름은 창 제목')
  assert.equal(nodes[4]!.name, 'Avat…')
})

test('uiaFromTree — 숨은 위젯은 자손까지 뺀다. 비활성 dock 이 안 나와야 활성 탭 판정이 선다', () => {
  const root = w({
    class: 'zwQtMainWindow', objectName: 'zwQtMainWindow',
    children: [
      w({ class: 'ads::CDockWidget', objectName: 'dock_simulation', visible: false, children: [w({ class: 'QLabel', text: '숨은 글자' })] }),
      w({ class: 'ads::CDockWidget', objectName: 'dock_avatar' }),
    ],
  })
  const { nodes } = uiaFromTree(root, { originX: 0, originY: 0 })
  assert.equal(nodes.length, 2)
  // 부모(zwQtMainWindow)에 이름이 있으므로 경로가 붙는다 — activePanel 은 접두사로 본다
  const dump = { elapsedMs: 0, maxDepth: 24, maxNodes: 2000, truncated: false, nodes: nodes.map((n) => ({ ...n, automationId: n.automationId.replace(/^zwQtMainWindow\./, '') })) }
  assert.equal(activePanel(dump).dockId, 'avatar')
})

test('uiaFromTree — 창 기준 좌표는 화면 좌표에서 원점을 뺀 것', () => {
  const root = w({ class: 'zwQtMainWindow', screenX: 0, screenY: 66, children: [w({ class: 'QPushButton', text: 'OK', screenX: 100, screenY: 166 })] })
  const { nodes } = uiaFromTree(root, { originX: 0, originY: 66 })
  const ok = findNodes(nodes, { name: 'OK' })
  assert.equal(ok.length, 1)
  assert.deepEqual([ok[0]!.wx, ok[0]!.wy], [100, 100])
})

test('uiaFromTree — 노드 상한에 닿으면 truncated', () => {
  const root = w({ class: 'QWidget', children: [w({ class: 'QWidget' }), w({ class: 'QWidget' }), w({ class: 'QWidget' })] })
  const r = uiaFromTree(root, { originX: 0, originY: 0, maxNodes: 2 })
  assert.equal(r.nodes.length, 2)
  assert.equal(r.truncated, true)
})

test('findTopLevel — 클래스·이름·사각형이 다 맞는 보이는 것 하나만', () => {
  const a = w({ class: 'zwQtMainWindow', objectName: 'zwQtMainWindow', width: 1512, height: 831, screenY: 66 })
  const hidden = { ...a, visible: false }
  const win = { class: 'zwQtMainWindow', objectName: 'zwQtMainWindow', x: 0, y: 66, width: 1512, height: 831 }
  assert.equal(findTopLevel([a, hidden], win), a)
  assert.equal(findTopLevel([a, { ...a }], win), null, '둘이면 고르지 않는다')
})
