// 1단 순수 단위 테스트 — 의존성 0.
//
//   node --test src/agent/hello.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  findByLabel,
  findWidgets,
  flattenWidgets,
  judgeAbi,
  judgeTree,
  parseAgentHello,
  toWindowPoint,
  widgetCenter,
  widgetLabels,
} from './hello.ts'
import type { AgentHello } from './hello.ts'

/** 픽스처에서 실제로 나온 hello (2026-09-09). 값을 줄여 옮겼다. */
const REAL = {
  loaded: true,
  styleKey: 'zwagent',
  pid: 27132,
  qtCompiled: '5.15.6',
  qtRuntime: '5.15.6',
  attempts: 13,
  sawUi: true,
  settled: true,
  widgetTotal: 7,
  writeCount: 1,
  elapsedMs: 3250,
  writtenAt: '2026-09-09T08:00:00Z',
  appFilePath: 'D:/z-emotion/zw-probe/bin/zwqtfixture.exe',
  topLevelCount: 1,
  widgetBudgetLeft: 493,
  topLevelWidgets: [
    {
      class: 'QMainWindow',
      objectName: 'zwqtfixtureMainWindow',
      visible: true,
      enabled: true,
      x: 0,
      y: 0,
      width: 402,
      height: 332,
      children: [
        {
          class: 'QWidget',
          objectName: 'centralArea',
          visible: true,
          enabled: true,
          x: 1,
          y: 31,
          width: 400,
          height: 300,
          children: [
            {
              class: 'QLabel',
              objectName: 'cellTopLeft',
              visible: true,
              enabled: true,
              x: 0,
              y: 0,
              width: 200,
              height: 150,
            },
            {
              class: 'QPushButton',
              objectName: 'fixtureTarget',
              visible: true,
              enabled: true,
              x: 200,
              y: 150,
              width: 200,
              height: 150,
            },
          ],
        },
      ],
    },
  ],
}

function hello(p: Partial<AgentHello> = {}): AgentHello {
  const parsed = parseAgentHello(REAL)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) throw new Error('unreachable')
  return { ...parsed.hello, ...p }
}

test('parseAgentHello — 픽스처가 낸 hello 를 읽는다', () => {
  const r = parseAgentHello(REAL)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.hello.styleKey, 'zwagent')
  assert.equal(r.hello.qtRuntime, '5.15.6')
  assert.equal(r.hello.topLevelCount, 1)
  assert.equal(r.hello.topLevelWidgets.length, 1)
  assert.equal(r.hello.topLevelWidgets[0]!.class, 'QMainWindow')
})

test('parseAgentHello — loaded 가 true 가 아니면 거부한다', () => {
  // 로드되지 않은 것과 파일이 깨진 것을 갈라 말해야 원인을 짚을 수 있다.
  for (const bad of [false, undefined, 'true', 1]) {
    const r = parseAgentHello({ ...REAL, loaded: bad })
    assert.equal(r.ok, false, `loaded=${JSON.stringify(bad)} 는 거부해야 한다`)
  }
})

test('parseAgentHello — qtRuntime 이 없으면 거부한다', () => {
  const r = parseAgentHello({ ...REAL, qtRuntime: '' })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.reason, /Qt 를 못 불렀다/)
})

test('parseAgentHello — 던지지 않고 이유를 돌려준다', () => {
  for (const bad of [null, 42, 'x', []]) {
    assert.equal(parseAgentHello(bad).ok, false, `${JSON.stringify(bad)} 는 거부해야 한다`)
  }
})

test('parseAgentHello — 위젯 목록이 없어도 로드 사실은 읽는다', () => {
  // 위젯 트리를 못 읽은 것과 로드가 안 된 것은 다른 문제다.
  const noTree = { ...REAL, topLevelWidgets: undefined, topLevelCount: undefined }
  const r = parseAgentHello(noTree)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.hello.topLevelWidgets, [])
  assert.equal(r.hello.topLevelCount, 0)
})

test('parseAgentHello — 이상한 위젯 항목은 버리고 나머지를 살린다', () => {
  const r = parseAgentHello({ ...REAL, topLevelWidgets: [null, 'x', REAL.topLevelWidgets[0]] })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.hello.topLevelWidgets.length, 1)
})

test('judgeAbi — 컴파일과 런타임이 같으면 통과', () => {
  const v = judgeAbi(hello())
  assert.equal(v.match, true)
  assert.match(v.reason, /5\.15\.6/)
})

test('judgeAbi — 버전이 다르면 알린다', () => {
  // 로드된 채 버전이 다르면 지금 동작해도 나중에 조용히 깨진다.
  const v = judgeAbi(hello({ qtCompiled: '5.15.2', qtRuntime: '5.15.6' }))
  assert.equal(v.match, false)
  assert.match(v.reason, /5\.15\.2/)
  assert.match(v.reason, /5\.15\.6/)
})

test('judgeAbi — 컴파일 버전을 모르면 통과시키지 않는다', () => {
  assert.equal(judgeAbi(hello({ qtCompiled: '' })).match, false)
})

test('flattenWidgets — 트리를 전부 펼친다', () => {
  const flat = flattenWidgets(hello().topLevelWidgets)
  assert.deepEqual(
    flat.map((w) => w.objectName),
    ['zwqtfixtureMainWindow', 'centralArea', 'cellTopLeft', 'fixtureTarget'],
  )
})

test('flattenWidgets — 빈 목록', () => {
  assert.deepEqual(flattenWidgets([]), [])
})

test('findWidgets — objectName 은 경로가 아니라 원래 이름이다', () => {
  // UIA 는 부모 이름을 붙여 경로로 주지만 프로세스 안에서는 원래 이름이다.
  // 둘을 섞으면 못 찾는다.
  const h = hello()
  assert.equal(findWidgets(h.topLevelWidgets, 'fixtureTarget').length, 1)
  assert.equal(
    findWidgets(h.topLevelWidgets, 'zwqtfixtureMainWindow.centralArea.fixtureTarget').length,
    0,
  )
})

test('findWidgets — 빈 이름은 아무것도 맞히지 않는다', () => {
  // 빈 objectName 을 가진 위젯이 흔하므로, 빈 needle 을 흘리면 전부 맞는다.
  assert.deepEqual(findWidgets(hello().topLevelWidgets, ''), [])
})

test('findWidgets — 없으면 빈 목록', () => {
  assert.deepEqual(findWidgets(hello().topLevelWidgets, '없는이름'), [])
})

test('judgeTree — 개수가 멈춘 뒤에 찍혔으면 믿는다', () => {
  const v = judgeTree(hello())
  assert.equal(v.trustworthy, true)
  assert.equal(v.truncated, false)
})

test('judgeTree — UI 를 못 봤으면 빈 트리를 "위젯이 없다" 로 읽지 않는다', () => {
  const v = judgeTree(hello({ sawUi: false, settled: true }))
  assert.equal(v.trustworthy, false)
  assert.match(v.reason, /위젯이 없다/)
})

test('judgeTree — 정착 전 스냅샷은 믿지 않는다', () => {
  // 대상 앱은 메인 창보다 65초 먼저 스플래시를 띄운다. 그때 트리는 레이아웃도 안 된
  // 640x480 위젯 덩어리였다 (2026-09-09 실측). sawUi 만으로는 이것을 걸러내지 못한다.
  const v = judgeTree(hello({ sawUi: true, settled: false }))
  assert.equal(v.trustworthy, false)
  assert.match(v.reason, /스플래시/)
})

test('judgeTree — 잘림은 신뢰와 별개다', () => {
  // 상한에 닿으면 "없다" 를 단정할 수 없을 뿐, 실려 있는 것은 진짜다.
  const v = judgeTree(hello({ widgetBudgetLeft: 0 }))
  assert.equal(v.truncated, true)
  assert.equal(v.trustworthy, true)
})

test('judgeTree — settled 필드가 없는 옛 hello 는 믿지 않는다', () => {
  // 모르는 것을 좋은 쪽으로 채우면 조용히 틀린다. 필드가 없으면 정착을 확인할 수 없다.
  const { settled: _drop, ...legacy } = REAL
  const r = parseAgentHello(legacy)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.hello.settled, false)
  assert.equal(judgeTree(r.hello).trustworthy, false)
})

test('toWindowPoint — 캡처 사각형 원점을 뺀다. 그것이 click 이 받는 좌표다', () => {
  // 실측값을 그대로 쓴다: 캡처 사각형이 3440,0 이고 위젯이 화면 3448,16 에 있다.
  const p = toWindowPoint({ screenX: 3448, screenY: 16 }, { x: 3440, y: 0 })
  assert.deepEqual(p, { wx: 8, wy: 16 })
})

test('toWindowPoint — UIA 사각형 원점을 넘기면 8px 어긋난다', () => {
  // 이 테스트는 규칙을 고정하려고 있다. 창 UIA 사각형은 3432,-8 이고 캡처는 3440,0 이다
  // (보이지 않는 리사이즈 테두리). 원점을 잘못 넘기면 조용히 8px 틀린다.
  const right = toWindowPoint({ screenX: 3448, screenY: 16 }, { x: 3440, y: 0 })
  const wrong = toWindowPoint({ screenX: 3448, screenY: 16 }, { x: 3432, y: -8 })
  assert.notDeepEqual(right, wrong)
  assert.deepEqual(wrong, { wx: 16, wy: 24 })
})

test('widgetCenter — 한가운데를 창 기준으로 준다', () => {
  const c = widgetCenter(
    { screenX: 3440, screenY: 0, width: 24, height: 24 },
    { x: 3440, y: 0 },
  )
  assert.deepEqual(c, { x: 12, y: 12 })
})

test('widgetLabels — 출처를 가리지 않고 모은다', () => {
  // 툴바 버튼은 objectName 이 비어 있고 툴팁이나 액션 텍스트에만 글자가 있다.
  const w: AgentHello['topLevelWidgets'][number] = {
    class: 'zwQtButton',
    objectName: '',
    visible: true,
    enabled: true,
    x: 3,
    y: 3,
    width: 24,
    height: 24,
    screenX: 100,
    screenY: 100,
    toolTip: 'Show grid',
    actions: ['Toggle Grid'],
  }
  assert.deepEqual(widgetLabels(w), ['Show grid', 'Toggle Grid'])
})

test('findByLabel — objectName 이 없어도 툴팁으로 찾는다', () => {
  const h = hello({
    topLevelWidgets: [
      {
        class: 'zwQt3DViewShowOptionToolbar',
        objectName: '',
        visible: true,
        enabled: true,
        x: 0,
        y: 0,
        width: 316,
        height: 44,
        screenX: 1000,
        screenY: 100,
        children: [
          {
            class: 'zwQtButton',
            objectName: '',
            visible: true,
            enabled: true,
            x: 10,
            y: 10,
            width: 24,
            height: 24,
            screenX: 1010,
            screenY: 110,
            toolTip: 'Show grid',
          },
        ],
      },
    ],
  })
  const hits = findByLabel(h.topLevelWidgets, 'show grid')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.class, 'zwQtButton')
})

test('findByLabel — 부분 일치를 인정한다. 실앱에 단축키가 붙은 라벨이 있다', () => {
  const h = hello()
  // fixtureTarget 의 text 는 "fixture-target" 이다.
  assert.equal(findByLabel(h.topLevelWidgets, 'TARGET').length, 1)
})

test('findByLabel — 겹치면 다 돌려준다. 조용히 첫 번째를 고르지 않는다', () => {
  // 툴바 두 개가 같은 툴팁을 가질 수 있다 (2D 뷰와 3D 뷰의 같은 기능). 하나를 골라
  // 누르는 것은 호출자의 일이고, 여기서 첫 번째를 돌려주면 틀린 곳을 누르게 된다.
  const btn = (screenX: number, toolTip: string) => ({
    class: 'zwQtButton',
    objectName: '',
    visible: true,
    enabled: true,
    x: 0,
    y: 0,
    width: 24,
    height: 24,
    screenX,
    screenY: 0,
    toolTip,
  })
  const h = hello({ topLevelWidgets: [btn(100, 'Show grid'), btn(500, 'Show grid')] })
  const hits = findByLabel(h.topLevelWidgets, 'show grid')
  assert.equal(hits.length, 2)
  assert.deepEqual(
    hits.map((w) => w.screenX),
    [100, 500],
  )
})

test('findByLabel — 빈 needle 은 아무것도 맞히지 않는다', () => {
  assert.deepEqual(findByLabel(hello().topLevelWidgets, ''), [])
})
