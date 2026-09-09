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
    assert.equal(h.topLevelCount, 1, `최상위 위젯이 하나여야 한다 — 실제 ${h.topLevelCount}개`)
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
