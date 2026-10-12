// 1단 순수 단위 테스트 — 소켓 없이 프로토콜만.
//
//   node --test src/agent/protocol.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  callableActions,
  decodeResponse,
  encodeRequest,
  matchActions,
  parseActions,
  parseCandidates,
  parseTreeResult,
  pipeNameFor,
  pipePathFor,
  takeLines,
} from './protocol.ts'

test('pipeNameFor — 이름에 pid 가 들어간다', () => {
  // 고정 이름이면 병렬 테스트가 서로의 파이프를 잡는다. `node --test` 가 파일을
  // 병렬로 돌린다는 것을 창 제목에서 이미 한 번 겪었다.
  assert.equal(pipeNameFor(1234), 'zwagent-1234')
  assert.notEqual(pipeNameFor(1234), pipeNameFor(1235))
})

test('pipePathFor — Windows named pipe 경로 형태', () => {
  assert.equal(pipePathFor(1234, 'win32'), '\\\\.\\pipe\\zwagent-1234')
})

test('pipePathFor — macOS 는 임시 폴더의 Unix 소켓. 끝 슬래시가 겹치지 않는다', () => {
  assert.equal(pipePathFor(1234, 'darwin', '/var/folders/x/T/'), '/var/folders/x/T/zwagent-1234')
  assert.equal(pipePathFor(1234, 'darwin', '/tmp'), '/tmp/zwagent-1234')
})

test('encodeRequest — 줄바꿈으로 끝난다. 서버가 줄로 끊어 읽는다', () => {
  const s = encodeRequest({ id: 7, op: 'ping' })
  assert.ok(s.endsWith('\n'), '줄바꿈이 없으면 서버가 영영 기다린다')
  assert.deepEqual(JSON.parse(s), { id: 7, op: 'ping' })
})

test('decodeResponse — 성공을 읽는다', () => {
  const r = decodeResponse('{"ok":true,"id":2,"op":"tree","widgetTotal":7}')
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.id, 2)
  assert.equal(r.op, 'tree')
  assert.equal(r.body.widgetTotal, 7)
})

test('decodeResponse — 서버가 준 실패 이유를 그대로 전한다', () => {
  const r = decodeResponse('{"ok":false,"id":3,"error":"모르는 op: \\"nope\\""}')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /모르는 op/)
})

test('decodeResponse — JSON 이 아니면 던지지 않고 이유를 준다', () => {
  // 파이프에 엉뚱한 것이 흘러도 자동 루프가 예외로 멈추면 안 된다.
  const r = decodeResponse('<html>nope</html>')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /JSON 이 아니다/)
})

test('decodeResponse — ok 필드가 없으면 성공으로 읽지 않는다', () => {
  // 모르는 것을 좋은 쪽으로 채우면 조용히 틀린다.
  for (const line of ['{}', '{"ok":1}', '{"ok":"true"}', 'null', '42']) {
    assert.equal(decodeResponse(line).ok, false, `${line} 은 성공이 아니어야 한다`)
  }
})

test('takeLines — 완전한 줄만 떼고 조각은 남긴다', () => {
  // **실앱 트리가 6MB 라 한 줄이 쪼개져 오는 것은 반드시 일어난다.**
  const first = takeLines('{"a":1}\n{"b":2}\n{"c"')
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}'])
  assert.equal(first.rest, '{"c"')

  const second = takeLines(first.rest + ':3}\n')
  assert.deepEqual(second.lines, ['{"c":3}'])
  assert.equal(second.rest, '')
})

test('takeLines — 줄이 하나도 완성되지 않으면 아무것도 안 준다', () => {
  const r = takeLines('{"partial"')
  assert.deepEqual(r.lines, [])
  assert.equal(r.rest, '{"partial"')
})

test('takeLines — 빈 줄은 버린다', () => {
  const r = takeLines('\n\n{"a":1}\n')
  assert.deepEqual(r.lines, ['{"a":1}'])
})

test('parseTreeResult — hello 와 같은 파서로 위젯을 읽는다', () => {
  const body = {
    widgetTotal: 7,
    sawUi: true,
    topLevelCount: 1,
    widgetBudgetLeft: 11993,
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
        screenX: 100,
        screenY: 200,
        windowTitle: 'zwqtfixture',
      },
    ],
  }
  const r = parseTreeResult(body)
  assert.equal(r.widgetTotal, 7)
  assert.equal(r.sawUi, true)
  assert.equal(r.topLevelCount, 1)
  assert.equal(r.widgetBudgetLeft, 11993)
  assert.equal(r.topLevelWidgets[0]!.objectName, 'zwqtfixtureMainWindow')
  // 라벨과 절대 좌표가 파이프 경로에서도 살아야 한다
  assert.equal(r.topLevelWidgets[0]!.windowTitle, 'zwqtfixture')
  assert.equal(r.topLevelWidgets[0]!.screenX, 100)
})

test('parseTreeResult — 위젯이 없어도 던지지 않는다', () => {
  const r = parseTreeResult({ widgetTotal: 0, sawUi: false })
  assert.deepEqual(r.topLevelWidgets, [])
  assert.equal(r.sawUi, false)
})

/** 실앱에서 실제로 나온 모양. Import 와 Export 밑에 같은 이름이 있다. */
const ACTIONS = {
  actions: [
    { text: 'File', path: '', objectName: '', enabled: true, visible: true, isMenu: true },
    { text: '', path: 'File', objectName: '', enabled: true, visible: true, separator: true },
    {
      text: 'Open',
      path: 'File',
      objectName: 'actionOpen',
      enabled: true,
      visible: true,
      shortcut: 'Ctrl+O',
    },
    { text: 'OBJ', path: 'File > Import', objectName: '', enabled: true, visible: true },
    { text: 'OBJ', path: 'File > Export', objectName: '', enabled: false, visible: true },
    {
      text: 'Show Grid',
      path: '',
      objectName: '',
      enabled: true,
      visible: true,
      checkable: true,
      checked: true,
    },
  ],
}

test('parseActions — 액션을 읽는다', () => {
  const a = parseActions(ACTIONS)
  assert.equal(a.length, 6)
  assert.equal(a[2]!.text, 'Open')
  assert.equal(a[2]!.shortcut, 'Ctrl+O')
  assert.equal(a[3]!.path, 'File > Import')
  assert.equal(a[4]!.enabled, false)
  assert.equal(a[5]!.checked, true)
})

test('parseActions — 없는 필드는 좋은 쪽으로 채우지 않는다', () => {
  // enabled 가 없으면 false 여야 한다. true 로 채우면 못 부를 것을 부를 수 있다고 보고한다.
  const a = parseActions({ actions: [{ text: 'X' }] })
  assert.equal(a[0]!.enabled, false)
  assert.equal(a[0]!.checkable, false)
})

test('parseActions — 배열이 아니면 빈 목록', () => {
  assert.deepEqual(parseActions({}), [])
  assert.deepEqual(parseActions({ actions: 'nope' }), [])
})

test('callableActions — 구분선과 서브메뉴 항목은 명령이 아니다', () => {
  // 목록에 섞여 있으면 "왜 안 되지" 를 헤매게 된다. 서브메뉴는 눌러도 메뉴만 열린다.
  const c = callableActions(parseActions(ACTIONS))
  assert.deepEqual(
    c.map((a) => `${a.path}/${a.text}`),
    ['File/Open', 'File > Import/OBJ', 'File > Export/OBJ', '/Show Grid'],
  )
})

test('matchActions — 이름·경로·단축키 어디에 걸려도 찾는다', () => {
  const all = parseActions(ACTIONS)
  assert.equal(matchActions(all, 'Ctrl+O').length, 1)
  assert.equal(matchActions(all, 'import').length, 1, '경로로도 걸려야 한다')
  assert.equal(matchActions(all, 'obj').length, 2, '이름이 겹치면 둘 다 나와야 한다')
})

test('matchActions — 빈 조각은 전부', () => {
  assert.equal(matchActions(parseActions(ACTIONS), '').length, 6)
})

test('parseCandidates — 거부 응답의 후보를 읽는다', () => {
  // **거부하면서 무엇을 줬는지가 다음 행동을 정한다.** 후보가 없으면 무엇으로
  // 좁혀야 할지 알 수 없다.
  const body = { ok: false, error: '"OBJ" 이 2개다.', candidates: ACTIONS.actions.slice(3, 5) }
  const c = parseCandidates(body)
  assert.equal(c.length, 2)
  assert.deepEqual(
    c.map((x) => x.path),
    ['File > Import', 'File > Export'],
  )
})

test('decodeResponse — 실패에도 본문을 실어야 후보를 꺼낼 수 있다', () => {
  const r = decodeResponse('{"ok":false,"error":"둘이다","candidates":[{"text":"OBJ","path":"File > Import"}]}')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.ok(r.body !== undefined, '실패 본문이 없으면 후보를 꺼낼 수 없다')
  assert.equal(parseCandidates(r.body!).length, 1)
})

test('decodeResponse — 연결 실패에는 본문이 없다', () => {
  // 서버가 거부한 것과 아예 못 읽은 것은 다르다.
  const r = decodeResponse('nope')
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.body, undefined)
})

test('encodeRequest — trigger 는 text 와 path 를 그대로 싣는다', () => {
  const s = encodeRequest({ id: 9, op: 'trigger', text: 'OBJ', path: 'File > Import' })
  assert.deepEqual(JSON.parse(s), { id: 9, op: 'trigger', text: 'OBJ', path: 'File > Import' })
})
