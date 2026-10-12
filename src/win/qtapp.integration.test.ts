// 2단 픽스처 통합 테스트 — Qt 픽스처 앱 대상. Z-Weave 없이 돈다.
//
// **WinForms 픽스처로는 답할 수 없는 것들을 여기서 답한다.** Qt 의 창 구조·모달
// 구현·UIA 노출은 WinForms 와 다르고, 대상 앱은 Qt 다.
//
//   node --test src/win/qtapp.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QTAPP_EXE, QTAPP_TITLE, qtEnv, qtFilter, qtFixtureMissing, windowsOnly } from './qtFixture.ts'
import { listWindows, shot } from './zwwin.ts'
import { judgeActivity } from './windowState.ts'
import { analyze, judgeBlank, pixelAt } from '../image/stats.ts'
import { findNodes, isClickable } from '../uia/tree.ts'
import { uiaTree } from './zwwin.ts'
import type { Bgra, Rgb } from '../image/stats.ts'
import type { WindowInfo } from './zwwin.ts'

// 플러그인 없이 띄운 Qt 창의 Win32·UIA 사실(창 클래스·WS_DISABLED·AutomationId)을 본다 — macOS 에는 없는 것들이다
const skip = windowsOnly('Win32 창·UIA 를 시험한다') || qtFixtureMissing()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Qt 픽스처를 띄운다. Qt DLL·플러그인 경로가 실려야 뜬다.
 *
 * pid 를 함께 돌려준다 — 창을 고를 때 제목만으로는 병렬 실행되는 다른 테스트
 * 파일의 픽스처와 섞인다 (qtFilter 주석 참고).
 */
function spawnQtApp(args: string[] = []) {
  const child = spawn(QTAPP_EXE, args, { detached: false, stdio: 'ignore', env: qtEnv() })
  assert.ok(child.pid !== undefined, '픽스처 프로세스를 띄우지 못했다')
  return { child, filter: qtFilter(child.pid) }
}

/** 창이 뜰 때까지 기다린다. Qt 앱은 WinForms 보다 시작이 느리다. */
async function waitForWindows(
  filter: { pid: number; title: string },
  count: number,
  timeoutMs = 15000,
): Promise<WindowInfo[]> {
  const deadline = Date.now() + timeoutMs
  let last: WindowInfo[] = []
  while (Date.now() < deadline) {
    last = listWindows(filter)
    if (last.length >= count && last.every((w) => w.width > 0)) return last
    await sleep(200)
  }
  throw new Error(`창 ${count}개를 ${timeoutMs}ms 안에 찾지 못했다 — 실제 ${last.length}개`)
}

function near(a: Rgb, r: number, g: number, b: number, tol = 12): boolean {
  return Math.abs(a.r - r) <= tol && Math.abs(a.g - g) <= tol && Math.abs(a.b - b) <= tol
}

function show(c: Rgb): string {
  return `rgb(${c.r},${c.g},${c.b})`
}

test('Qt 창이 대상 앱과 같은 창 클래스로 뜬다', { skip }, async () => {
  // Qt 는 버전·디버그 여부·창 플래그로 클래스 이름을 조합한다. 대상 앱의 메인 창이
  // `Qt5156dQWindowIcon` 이었으므로(2026-09-09 실측) 픽스처도 그래야 한다 —
  // 같지 않으면 픽스처가 다른 Qt 를 쓰고 있다는 뜻이고 ABI 전제가 깨진다.
  const { child, filter } = spawnQtApp()
  try {
    const wins = await waitForWindows(filter, 1)
    assert.equal(wins.length, 1)
    const w = wins[0]!
    assert.match(w.class, /^Qt5156d/, `Qt 5.15.6 디버그 창 클래스여야 한다 — 실제 ${w.class}`)
    assert.equal(w.owner, 0, '메인 창은 소유자가 없다')
    assert.equal(w.enabled, true)
  } finally {
    child.kill()
  }
})

test('UIA 가 준 좌표에서 찍은 픽셀이 그 위젯의 색이다', { skip }, async () => {
  // **이것이 두 좌표계가 맞는지 확인하는 테스트다.** UIA 사각형은 화면 절대 좌표이고
  // 원점이 캡처 사각형과 다르다 — 대상 앱에서 8px 어긋났다(2026-09-09 실측). zwwin 이
  // 창 기준 `wx`·`wy` 로 변환해 주는데, 그 변환이 맞으면 위젯 사각형 한가운데의
  // 픽셀이 그 위젯 색이어야 한다. 눈대중 좌표로 찍으면 이걸 검증할 수 없다.
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-qt-'))
  const { child, filter } = spawnQtApp()
  try {
    await waitForWindows(filter, 1)
    await sleep(400) // Qt 의 첫 페인트가 끝나도록

    const dump = uiaTree(filter)
    const raw = join(dir, 'qt.bgra')
    const info = shot({ ...filter, png: join(dir, 'qt.png'), raw })
    const w = info.window
    const img: Bgra = {
      width: w.width,
      height: w.height,
      data: new Uint8Array(readFileSync(raw)),
    }
    assert.equal(img.data.length, w.width * w.height * 4)
    assert.equal(judgeBlank(analyze(img)).blank, false, '캡처가 비어 있다')

    const cells: Array<[string, number, number, number]> = [
      ['cellTopLeft', 255, 0, 0],
      ['cellTopRight', 0, 255, 0],
      ['cellBottomLeft', 0, 0, 255],
    ]
    for (const [id, r, g, b] of cells) {
      const hit = findNodes(dump.nodes, { automationId: id })
      assert.equal(hit.length, 1, `${id} 가 하나 있어야 한다 — 실제 ${hit.length}개`)
      const n = hit[0]!
      const px = pixelAt(img, n.wx + Math.floor(n.width / 2), n.wy + Math.floor(n.height / 2))
      assert.ok(
        near(px, r, g, b),
        `${id} 한가운데(${n.wx + Math.floor(n.width / 2)},${n.wy + Math.floor(n.height / 2)})가 ` +
          `rgb(${r},${g},${b}) 여야 한다 — 실제 ${show(px)}`,
      )
    }
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Qt 가 objectName 을 AutomationId 경로로 조합한다', { skip }, async () => {
  // 대상 앱에서 `ViewWidget.dock_manager` 처럼 나온 것과 같은 규칙이다
  // (2026-09-09 실측). `setObjectName` 이 44곳뿐이라 UIA 가 취약할 것으로 봤던
  // 우려가 왜 과했는지가 여기서 재현된다 — 부모 이름이 경로로 붙는다.
  const { child, filter } = spawnQtApp()
  try {
    await waitForWindows(filter, 1)
    const dump = uiaTree(filter)

    const root = dump.nodes[0]!
    assert.equal(root.automationId, 'zwqtfixtureMainWindow')

    const target = findNodes(dump.nodes, { automationId: 'fixtureTarget' })
    assert.equal(target.length, 1, 'fixture-target 버튼이 하나 있어야 한다')
    assert.equal(
      target[0]!.automationId,
      'zwqtfixtureMainWindow.centralArea.fixtureTarget',
      '부모 objectName 이 경로로 붙어야 한다',
    )
    assert.equal(target[0]!.name, 'fixture-target')
    assert.equal(target[0]!.controlType, 'Button')
    assert.equal(isClickable(target[0]!), true)
  } finally {
    child.kill()
  }
})

test('Qt 모달 다이얼로그는 소유자 창을 Win32 수준에서 비활성화한다', { skip }, async () => {
  // **이것이 CLAUDE.md 의 열린 항목이었다.** WinForms 는 ShowDialog 에서 소유자에
  // EnableWindow(FALSE) 를 걸지만 Qt 는 자체 이벤트 루프로 모달을 처리할 수도 있고,
  // 이 PC 에 Qt 소스가 없어 읽어서 확인할 수 없었다. 픽스처로 실측한다.
  const { child, filter } = spawnQtApp(['--modal'])
  try {
    const wins = await waitForWindows(filter, 2)
    const activity = judgeActivity(wins)
    const { main, extras } = activity.classified

    assert.notEqual(main, null)
    assert.equal(main!.title, QTAPP_TITLE)
    assert.equal(main!.enabled, false, 'Qt 모달이 떠 있으면 소유자가 비활성이어야 한다')

    assert.equal(extras.length, 1)
    assert.equal(extras[0]!.relation, 'owned-by-main')
    assert.equal(extras[0]!.window.title, `${QTAPP_TITLE}-modal`)
    assert.equal(extras[0]!.interactive, true, '다이얼로그 자신은 입력을 받는다')

    assert.equal(activity.state, 'busy')
    assert.match(activity.reason, /입력을 받지 않는다/)
  } finally {
    child.kill()
  }
})

test('Qt 비모달 다이얼로그는 소유자를 비활성화하지 않는다', { skip }, async () => {
  // 모달과의 차이가 러너에게 중요하다 — 비모달이면 메인 창에 계속 입력할 수 있다.
  const { child, filter } = spawnQtApp(['--modeless'])
  try {
    const wins = await waitForWindows(filter, 2)
    const activity = judgeActivity(wins)
    const { main, extras } = activity.classified

    assert.notEqual(main, null)
    assert.equal(main!.enabled, true, '비모달이면 소유자가 살아 있어야 한다')

    assert.equal(extras.length, 1)
    assert.equal(extras[0]!.relation, 'owned-by-main')
    assert.equal(extras[0]!.window.title, `${QTAPP_TITLE}-modeless`)

    // 둘 다 busy 지만 이유가 다르다. 그 차이가 구분의 근거다.
    assert.equal(activity.state, 'busy')
    assert.match(activity.reason, /다른 창이 1개 떠 있다/)
    assert.doesNotMatch(activity.reason, /입력을 받지 않는다/)
  } finally {
    child.kill()
  }
})
