// 2단 픽스처 통합 테스트 — `zwagent.dll` 이 Qt 픽스처 앱에 로드되는지.
//
// **M4 의 본질이 이 파일이다.** 현 설계의 유일한 기술적 불확실성은 "스타일 플러그인
// 경로로 대상 앱 프로세스 안에 들어갈 수 있는가" 였다. 대상 앱을 띄우지 않고
// 픽스처로 답한다 — 실패해도 대상 앱에 아무 영향이 없다.
//
//   node --test src/win/zwagent.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QTAPP_EXE, ZWAGENT_DLL, qtEnv, qtFilter, qtFixtureMissing } from './qtFixture.ts'
import { listWindows, shot, uiaTree } from './zwwin.ts'
import { diff, judgeSame } from '../image/diff.ts'
import { findWidgets, judgeAbi, parseAgentHello } from '../agent/hello.ts'
import { call } from '../agent/pipe.ts'
import {
  callableActions,
  parseActions,
  parseCandidates,
  parseTreeResult,
  pipeNameFor,
} from '../agent/protocol.ts'
import { findNodes } from '../uia/tree.ts'
import type { AgentHello } from '../agent/hello.ts'
import type { Bgra } from '../image/stats.ts'

const skip =
  qtFixtureMissing() ||
  (existsSync(ZWAGENT_DLL)
    ? false
    : `${ZWAGENT_DLL} 가 없다. bash tools/zwagent/build.sh 를 먼저 실행한다.`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// pid 로 좁힌다 — 제목만으로는 병렬 실행되는 다른 테스트 파일의 픽스처와 섞인다
// (qtFilter 주석 참고).
async function waitForWindow(filter: { pid: number; title: string }, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = listWindows(filter)
    if (found.length > 0 && found[0]!.width > 0) return found[0]!
    await sleep(200)
  }
  throw new Error(`픽스처 창을 ${timeoutMs}ms 안에 찾지 못했다`)
}

/** hello 파일이 나타날 때까지 기다린다. 안 나타나면 로드되지 않은 것이다. */
async function waitForHello(path: string, timeoutMs = 15000): Promise<AgentHello> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const parsed = parseAgentHello(JSON.parse(readFileSync(path, 'utf8')))
        if (parsed.ok) return parsed.hello
        // 쓰는 중일 수 있다. 잠깐 뒤 다시 본다.
      } catch {
        /* 쓰는 중 — JSON 이 아직 온전하지 않다 */
      }
    }
    await sleep(200)
  }
  throw new Error(
    `hello 파일이 ${timeoutMs}ms 안에 안 나왔다: ${path}\n` +
      '  플러그인이 로드되지 않았다. QT_DEBUG_PLUGINS=1 로 다시 띄워 이유를 본다.',
  )
}

test('zwagent.dll 이 Qt 픽스처 앱에 로드되고 위젯 트리를 본다', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-agent-'))
  const hello = join(dir, 'hello.json')
  const child = spawn(QTAPP_EXE, ['-style', 'zwagent'], {
    detached: false,
    stdio: 'ignore',
    env: qtEnv({ ZWAGENT_HELLO: hello }),
  })
  assert.ok(child.pid !== undefined, '픽스처 프로세스를 띄우지 못했다')

  try {
    await waitForWindow(qtFilter(child.pid))
    const h = await waitForHello(hello)

    // ① 로드됐고 우리 키로 불렸다
    assert.equal(h.loaded, true)
    assert.equal(h.styleKey, 'zwagent')

    // ② ABI 가 맞는다 — 다르면 지금 동작해도 나중에 조용히 깨진다
    const abi = judgeAbi(h)
    assert.equal(abi.match, true, abi.reason)
    assert.match(h.qtRuntime, /^5\.15\./, `Qt 5.15.x 여야 한다 — 실제 ${h.qtRuntime}`)

    // ③ 우리가 겨냥한 프로세스 안에 있다
    assert.match(h.appFilePath, /zwqtfixture\.exe$/i)
    assert.ok(h.pid > 0)

    // ④ **살아 있는 위젯 트리를 본다. 이것이 M5 의 핵심 능력이다.**
    // sawUi 가 false 면 트리가 빈 이유가 "위젯이 없다" 가 아니라 "아직 안 만들어졌다"
    // 이므로 아래 단정이 의미를 잃는다. 먼저 그것을 확인한다.
    assert.equal(h.sawUi, true, `UI 가 뜬 뒤에 보고해야 한다 (시도 ${h.attempts}회)`)
    assert.ok(h.attempts >= 1, `시도 횟수가 실려야 한다 — 실제 ${h.attempts}`)
    // **최상위 위젯은 창 하나 + 메뉴들이어야 한다.** Qt 에서 `QMenu` 는 팝업이라
    // 안 열려 있어도 최상위 위젯으로 잡힌다 — 실앱도 QMenu 23개가 최상위에 있다.
    //
    // 개수를 고정하지 않는 대신 **보이는 최상위가 창 하나뿐인지**를 본다. 이 단정이
    // 원래 잡으려던 것은 부모 없이 만든 QWidget 이 최상위로 새는 것이었고
    // (2026-09-09: topLevelCount 가 2로 나왔다), 그것은 이 형태로도 잡힌다.
    const visibleTops = h.topLevelWidgets.filter((w) => w.visible)
    assert.equal(
      visibleTops.length,
      1,
      `보이는 최상위 위젯이 하나여야 한다 — 실제 ${visibleTops.map((w) => w.class).join(', ')}`,
    )
    assert.equal(visibleTops[0]!.objectName, 'zwqtfixtureMainWindow')
    assert.ok(
      h.topLevelWidgets.every((w) => w.visible || w.class === 'QMenu'),
      `숨은 최상위는 QMenu 뿐이어야 한다 — 실제 ${h.topLevelWidgets
        .filter((w) => !w.visible)
        .map((w) => w.class)
        .join(', ')}`,
    )
    const target = findWidgets(h.topLevelWidgets, 'fixtureTarget')
    assert.equal(target.length, 1, 'fixtureTarget 을 트리에서 찾아야 한다')
    assert.equal(target[0]!.class, 'QPushButton')
    assert.equal(target[0]!.visible, true)
    assert.ok(target[0]!.width > 0 && target[0]!.height > 0)

    // objectName 은 UIA 와 달리 경로가 아니라 원래 이름이다
    assert.equal(findWidgets(h.topLevelWidgets, 'centralArea').length, 1)
    assert.equal(
      findWidgets(h.topLevelWidgets, 'zwqtfixtureMainWindow.centralArea.fixtureTarget').length,
      0,
      '프로세스 안에서는 UIA 의 경로 형태로 찾히지 않아야 한다',
    )

    // 트리가 상한에 닿지 않았다 — 닿았으면 "없다" 를 믿을 수 없다
    assert.ok(h.widgetBudgetLeft > 0, `위젯 상한에 닿았다 (남은 ${h.widgetBudgetLeft})`)
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zwagent 를 얹어도 위젯 화면이 바뀌지 않는다', { skip }, async () => {
  // **이것이 지켜져야 픽셀 baseline 이 살아남는다.** 프로브가 대상 앱의 외관을
  // 바꾸면 에이전트를 얹은 순간 모든 baseline 이 무효가 되고, 그러면 M3 이
  // 만들어 놓은 것을 M5 가 깨뜨린다. QProxyStyle 로 감싸기만 하는 이유다.
  //
  // **타이틀바는 비교에서 뺀다.** 제목 글자는 DWM 이 그리고 **창 활성 상태에 따라
  // 다르게 렌더링된다.** 전체 스위트에서는 다른 테스트 파일이 병렬로 창을 띄우고
  // 닫으므로 활성 상태가 흔들리고, 그 때문에 이 테스트가 한 번 거짓 실패했다
  // (2026-09-09: 355픽셀, 영역이 정확히 제목 글자였다. 플러그인 없이 두 번 찍은
  // 대조에서는 픽셀 하나도 안 달랐다). 스타일이 바꿀 수 있는 것은 **클라이언트
  // 영역**이므로 거기만 본다.
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-agent-px-'))

  /** 픽스처를 띄워 한 장 찍고, 클라이언트 영역이 시작하는 y 도 함께 돌려준다. */
  async function captureOnce(args: string[], base: string): Promise<{ img: Bgra; clientTop: number }> {
    const child = spawn(QTAPP_EXE, args, {
      detached: false,
      stdio: 'ignore',
      env: qtEnv({ ZWAGENT_HELLO: join(dir, 'hello.json') }),
    })
    assert.ok(child.pid !== undefined, '픽스처 프로세스를 띄우지 못했다')
    const filter = qtFilter(child.pid)
    try {
      const w = await waitForWindow(filter)
      await sleep(600) // 첫 페인트가 끝나도록. 스타일이 다르면 여기서 드러난다

      // 클라이언트 영역의 위치는 UIA 에서 얻는다 — 타이틀바 높이는 DPI 에 따라
      // 변하므로 상수로 두면 배율이 다른 PC 에서 어긋난다.
      //
      // **전체 경로로 찾는다.** UIA AutomationId 는 부모 이름이 붙은 경로이므로
      // `centralArea` 만 주면 자식들(`...centralArea.cellTopLeft` 등)까지 부분
      // 일치로 걸려 5개가 된다 (2026-09-09 실측).
      const central = findNodes(uiaTree(filter).nodes, {
        automationId: 'zwqtfixtureMainWindow.centralArea',
      })
      assert.equal(central.length, 1, `centralArea 를 UIA 에서 하나 찾아야 한다 — 실제 ${central.length}개`)

      const raw = join(dir, `${base}.bgra`)
      shot({ ...filter, png: join(dir, `${base}.png`), raw })
      return {
        img: { width: w.width, height: w.height, data: new Uint8Array(readFileSync(raw)) },
        clientTop: central[0]!.wy,
      }
    } finally {
      child.kill()
      await sleep(400) // 다음 인스턴스와 창이 겹치지 않도록
    }
  }

  try {
    const plain = await captureOnce([], 'plain')
    const styled = await captureOnce(['-style', 'zwagent'], 'styled')

    assert.equal(plain.clientTop, styled.clientTop, '클라이언트 영역 위치가 같아야 비교가 성립한다')
    assert.ok(plain.clientTop > 0, `타이틀바가 있어야 한다 — clientTop=${plain.clientTop}`)

    const v = judgeSame(
      diff(plain.img, styled.img, {
        ignore: [{ x: 0, y: 0, width: plain.img.width, height: plain.clientTop }],
      }),
    )
    assert.equal(v.same, true, `zwagent 가 클라이언트 영역을 바꿨다 — ${v.reason}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('명령 채널이 열리고 온디맨드로 지금의 트리를 준다', { skip }, async () => {
  // **이것이 hello 파일과 다른 점이다.** hello 는 UI 가 정착한 순간의 스냅샷 하나뿐이라
  // 그 뒤에 화면이 바뀌면 낡는다. 파이프는 물어보는 시점의 트리를 준다.
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-pipe-'))
  const hello = join(dir, 'hello.json')
  const child = spawn(QTAPP_EXE, ['-style', 'zwagent'], {
    detached: false,
    stdio: 'ignore',
    env: qtEnv({ ZWAGENT_HELLO: hello }),
  })
  assert.ok(child.pid !== undefined, '픽스처 프로세스를 띄우지 못했다')
  const pid = child.pid!

  try {
    await waitForWindow(qtFilter(pid))
    const h = await waitForHello(hello)

    // ① hello 가 파이프 이름을 알려준다. 이름에 pid 가 들어가므로 밖에서 찾을 수 있다.
    assert.equal(h.pipeName, pipeNameFor(pid), 'hello 의 파이프 이름이 pid 와 맞아야 한다')
    assert.equal(h.pipeListening, true, `파이프가 안 열렸다: ${h.pipeError ?? '(이유 없음)'}`)

    // ② ping — 파이프가 열렸다는 것 자체가 로드 확인이다
    const ping = await call(pid, { id: 1, op: 'ping' }, { timeoutMs: 10000 })
    assert.equal(ping.ok, true, ping.ok ? '' : ping.error)
    if (!ping.ok) return
    assert.equal(ping.body.pid, pid, '우리가 겨냥한 프로세스가 답해야 한다')
    assert.match(String(ping.body.appFilePath), /zwqtfixture\.exe$/i)

    // ③ tree — hello 와 같은 모양이어야 한다. 두 벌이면 밖에서 어느 쪽을 읽었는지에
    //    따라 답이 달라진다.
    const tree = await call(pid, { id: 2, op: 'tree' }, { timeoutMs: 10000 })
    assert.equal(tree.ok, true, tree.ok ? '' : tree.error)
    if (!tree.ok) return
    const parsed = parseTreeResult(tree.body)
    assert.equal(parsed.topLevelCount, h.topLevelCount)
    assert.equal(parsed.widgetTotal, h.widgetTotal)
    const target = findWidgets(parsed.topLevelWidgets, 'fixtureTarget')
    assert.equal(target.length, 1, '파이프로 받은 트리에서도 fixtureTarget 을 찾아야 한다')
    assert.equal(target[0]!.class, 'QPushButton')

    // ④ 라벨과 절대 좌표가 파이프로도 온다
    assert.equal(target[0]!.text, 'fixture-target')
    assert.ok(target[0]!.screenX > 0, '화면 절대 좌표가 실려야 한다')

    // ⑤ 모르는 op 는 조용히 넘어가지 않고 거부한다
    const bad = await call(pid, { id: 3, op: 'nope' } as never, { timeoutMs: 10000 })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error, /모르는 op/)
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('앱이 없으면 파이프 실패를 이유와 함께 알린다', { skip }, async () => {
  // **"안 열렸다" 와 "로드가 안 됐다" 를 밖에서 갈라야 한다.** 없는 pid 로 열면
  // 연결 자체가 실패하고, 그때 무엇을 확인할지가 메시지에 있어야 한다.
  const r = await call(999999, { id: 1, op: 'ping' }, { timeoutMs: 3000 })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /zwagent-999999|zwagent\.dll/)
  }
})

test('QAction::trigger() 가 실제로 대상 앱을 바꾼다', { skip }, async () => {
  // **M5 에서 zwagent 가 처음으로 쓰기를 하는 지점이다.** 불렀다는 응답만으로는
  // 부족하다 — 화면이 바뀌어야 진짜 부른 것이다. 픽스처의 Mark 액션은 오른쪽 아래
  // 사분면을 검게 만든다.
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-trigger-'))
  const hello = join(dir, 'hello.json')
  const child = spawn(QTAPP_EXE, ['-style', 'zwagent'], {
    detached: false,
    stdio: 'ignore',
    env: qtEnv({ ZWAGENT_HELLO: hello }),
  })
  assert.ok(child.pid !== undefined, '픽스처 프로세스를 띄우지 못했다')
  const pid = child.pid!

  try {
    await waitForWindow(qtFilter(pid))
    await waitForHello(hello)

    // ① 목록에 우리가 심은 액션이 경로와 함께 나온다
    const listed = await call(pid, { id: 1, op: 'actions' }, { timeoutMs: 10000 })
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error)
    if (!listed.ok) return
    const actions = parseActions(listed.body)
    const mark = actions.find((a) => a.text === 'Mark')
    assert.ok(mark !== undefined, 'Mark 액션을 찾아야 한다')
    assert.equal(mark!.path, 'Fixture', '메뉴 경로가 실려야 한다')
    // 서브메뉴 항목은 경로가 이어붙어야 한다 — 실앱의 File > Recent files 가 이 모양이다
    const nested = actions.find((a) => a.path === 'Fixture > Recent')
    assert.ok(nested !== undefined, '서브메뉴 경로가 이어붙어야 한다')
    // 서브메뉴를 여는 항목과 구분선은 명령이 아니다
    assert.ok(
      callableActions(actions).every((a) => !a.isMenu),
      '부를 수 있는 목록에 서브메뉴 항목이 섞이면 안 된다',
    )

    // ② **이름이 겹치면 부르지 않는다.** 조용히 첫 번째를 고르면 다른 명령이 실행된다.
    const ambiguous = await call(pid, { id: 2, op: 'trigger', text: 'Ambiguous' }, { timeoutMs: 10000 })
    assert.equal(ambiguous.ok, false, '겹치는 이름은 거부해야 한다')
    if (!ambiguous.ok) {
      assert.match(ambiguous.error, /2개/)
      // 후보를 줘야 다음에 무엇을 할지 안다
      const cands = ambiguous.body ? parseCandidates(ambiguous.body) : []
      assert.equal(cands.length, 2)
      assert.deepEqual(cands.map((c) => c.path).sort(), ['Fixture > Recent', 'Other'])
    }

    // ③ 경로로 좁히면 통과한다
    const narrowed = await call(
      pid,
      { id: 3, op: 'trigger', text: 'Ambiguous', path: 'Other' },
      { timeoutMs: 10000 },
    )
    assert.equal(narrowed.ok, true, narrowed.ok ? '' : narrowed.error)

    // ④ **비활성은 거부한다.** Qt 는 조용히 무시하므로 부르고 나면 원인을 못 짚는다.
    const off = await call(
      pid,
      { id: 4, op: 'trigger', text: 'Disabled', path: 'Other' },
      { timeoutMs: 10000 },
    )
    assert.equal(off.ok, false)
    if (!off.ok) assert.match(off.error, /비활성/)

    // ⑤ **화면이 실제로 바뀐다.** 여기가 이 테스트의 본론이다.
    const before = shot({ pid, title: 'zwqtfixture', png: join(dir, 'before.png'), raw: join(dir, 'before.bgra') })
    const fired = await call(
      pid,
      { id: 5, op: 'trigger', text: 'Mark', path: 'Fixture' },
      { timeoutMs: 10000 },
    )
    assert.equal(fired.ok, true, fired.ok ? '' : fired.error)

    // 큐에 넣고 답하므로 실제 실행은 다음 이벤트 루프다. 바뀔 때까지 기다린다.
    let changed = false
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !changed) {
      await sleep(200)
      const after = shot({ pid, title: 'zwqtfixture', png: join(dir, 'after.png'), raw: join(dir, 'after.bgra') })
      const a: Bgra = {
        width: before.window.width,
        height: before.window.height,
        data: new Uint8Array(readFileSync(join(dir, 'before.bgra'))),
      }
      const b: Bgra = {
        width: after.window.width,
        height: after.window.height,
        data: new Uint8Array(readFileSync(join(dir, 'after.bgra'))),
      }
      changed = !judgeSame(diff(a, b)).same
    }
    assert.equal(changed, true, 'trigger 뒤에 화면이 바뀌어야 한다 — 안 바뀌면 부른 것이 아니다')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})
