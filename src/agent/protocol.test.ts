// 1단 순수 단위 테스트 — 소켓 없이 프로토콜만.
//
//   node --test src/agent/protocol.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeResponse,
  encodeRequest,
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
  assert.equal(pipePathFor(1234), '\\\\.\\pipe\\zwagent-1234')
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
