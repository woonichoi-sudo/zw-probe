// macOS 의 가장자리(zwmac — 창 목록·캡처·클릭·키·UIA 대체·녹화)를 Qt 픽스처로 시험한다.
// Windows 의 zwwin.integration.test.ts(WinForms 픽스처)에 해당한다. **Z-Weave 없이 돈다.**
//
// 픽스처는 zwagent 를 얹어 띄운다 — macOS 에서는 플러그인이 있는 앱만 보인다(zwmac.ts 머리말).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IS_MAC, QTAPP_EXE, ZWAGENT_DLL, qtEnv, qtFilter, qtFixtureMissing } from '../win/qtFixture.ts'
import { click, listWindows, sendKey, shot, startRecord, uiaTree } from '../win/zwwin.ts'
import { judgeActivity } from '../win/windowState.ts'
import { findNodes, clickPoint } from '../uia/tree.ts'
import { judgeRecording, parseRecordResult, readMp4Summary } from '../record/record.ts'
import { ENCODER } from './zwmac.ts'

const skip = !IS_MAC
  ? 'macOS 전용 — Windows 는 zwwin.integration.test.ts 가 같은 것을 본다'
  : qtFixtureMissing() || (existsSync(ZWAGENT_DLL) ? false : `${ZWAGENT_DLL} 가 없다. bash tools/zwagent/build.sh 를 먼저 실행한다.`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Fx = { pid: number; dir: string; kill: () => void }

async function start(args: string[] = []): Promise<Fx> {
  const dir = mkdtempSync(join(tmpdir(), 'zwmac-it-'))
  const child = spawn(QTAPP_EXE, [...args, '-style', 'zwagent'], {
    stdio: 'ignore',
    env: qtEnv({ ZWAGENT_HELLO: join(dir, 'hello.json') }),
  })
  const pid = child.pid!
  const kill = () => {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      if (listWindows({ pid }).length > 0) return { pid, dir, kill }
    } catch {
      /* 소켓이 아직 없다 */
    }
    await sleep(200)
  }
  kill()
  throw new Error('픽스처 창이 20초 안에 안 보였다 (zwagent 가 로드되지 않았을 수 있다)')
}

/** BGRA 생 픽셀의 한 점. */
function pixel(raw: string, width: number, x: number, y: number): [number, number, number] {
  const b = readFileSync(raw)
  const i = (y * width + x) * 4
  return [b[i + 2]!, b[i + 1]!, b[i]!] // RGB
}

test('zwmac — 창 목록·idle 판정·캡처 픽셀이 위젯 색이다', { skip }, async () => {
  const fx = await start()
  try {
    const wins = listWindows(qtFilter(fx.pid))
    assert.equal(wins.length, 1)
    const w = wins[0]!
    assert.equal(w.class, 'QMainWindow')
    assert.equal(judgeActivity(listWindows({ pid: fx.pid })).state, 'idle')

    const png = join(fx.dir, 's.png')
    const raw = join(fx.dir, 's.bgra')
    const info = shot({ ...qtFilter(fx.pid), png, raw })
    assert.equal(info.window.hwnd, w.hwnd)
    assert.equal(readFileSync(raw).length, w.width * w.height * 4, '논리 크기로 찍혀야 한다(PNG 좌표 = 클릭 좌표)')
    // 사분면 — 왼쪽 위 빨강, 오른쪽 위 초록, 왼쪽 아래 파랑 (macOS 메뉴바는 화면 위라 창 안에 없다)
    const qx = Math.floor(w.width / 4)
    const qy = Math.floor(w.height / 4)
    assert.deepEqual(pixel(raw, w.width, qx, qy), [255, 0, 0])
    assert.deepEqual(pixel(raw, w.width, qx * 3, qy), [0, 255, 0])
    assert.deepEqual(pixel(raw, w.width, qx, qy * 3), [0, 0, 255])
  } finally {
    fx.kill()
  }
})

test('zwmac — UIA 대체 트리에서 이름으로 찾아 누르면 실제로 눌린다', { skip }, async () => {
  const fx = await start()
  try {
    const dump = uiaTree(qtFilter(fx.pid))
    const hits = findNodes(dump.nodes, { name: 'fixture-target' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.automationId, 'zwqtfixtureMainWindow.centralArea.fixtureTarget', 'Qt 의 objectName 경로 규칙')
    const p = clickPoint(hits[0]!)
    const r = click({ ...qtFilter(fx.pid), x: p.x, y: p.y })
    assert.equal(r.rootAtPoint, r.window.hwnd)
    await sleep(500)
    const raw = join(fx.dir, 'after.bgra')
    shot({ ...qtFilter(fx.pid), png: join(fx.dir, 'after.png'), raw })
    assert.deepEqual(pixel(raw, r.window.width, p.x, p.y), [0, 0, 0], '눌리면 오른쪽 아래가 검게 바뀐다')
  } finally {
    fx.kill()
  }
})

test('zwmac — 모달이 뜨면 busy 이고 메인은 막혔다. Esc(keyWindow)로 닫으면 idle', { skip }, async () => {
  const fx = await start(['--modal'])
  try {
    let wins = listWindows({ pid: fx.pid })
    for (let i = 0; i < 25 && wins.length < 2; i++) {
      await sleep(200)
      wins = listWindows({ pid: fx.pid })
    }
    const act = judgeActivity(wins)
    assert.equal(act.state, 'busy', act.reason)
    const main = wins.find((w) => w.class === 'QMainWindow')!
    const dlg = wins.find((w) => w.class === 'QDialog')!
    assert.equal(main.enabled, false, '모달 뒤의 메인 창은 입력을 못 받는다')
    assert.equal(dlg.owner, main.hwnd, '다이얼로그의 소유 창은 메인이다')

    const k = sendKey({ pid: fx.pid, title: 'zwqtfixture-modal', stroke: { vk: 0x1b, ctrl: false, alt: false, shift: false } })
    // activated 는 단정하지 않는다 — 병렬로 도는 다른 테스트가 제 창을 활성화하려고 다투면 1.5초 안에
    // 못 얻을 수 있다(2026-10-12, 전체 스위트에서 4번 중 2번). 확인할 것은 아래의 결과(모달이 닫힌다)다.
    void k
    // --modal 픽스처는 exec() 가 끝나면 종료한다 — 창이 다 사라지는 것이 "닫혔다" 이다
    let gone = false
    for (let i = 0; i < 25 && !gone; i++) {
      await sleep(200)
      try {
        gone = listWindows({ pid: fx.pid }).every((w) => w.class !== 'QDialog')
      } catch {
        gone = true
      }
    }
    assert.ok(gone, 'Esc 로 모달이 닫혀야 한다')
  } finally {
    fx.kill()
  }
})

test('zwmac — 녹화가 정지 파일로 끝나고 재생 가능한 MP4 를 남긴다', { skip: skip || (existsSync(ENCODER) ? false : `${ENCODER} 가 없다. bash tools/zwmac/build.sh`) }, async () => {
  const fx = await start()
  try {
    const out = join(fx.dir, 'r.mp4')
    const result = join(fx.dir, 'r.json')
    const stop = join(fx.dir, 'r.stop')
    startRecord({ ...qtFilter(fx.pid), out, result, stop, fps: 4, maxSeconds: 30, mode: 'screen', cursor: true })
    await sleep(2500)
    writeFileSync(stop, '')
    for (let i = 0; i < 50 && !existsSync(result); i++) await sleep(200)
    const r = parseRecordResult(readFileSync(result, 'utf8'))
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    if (!r.ok) return
    assert.equal(r.stopReason, 'stop')
    const file = readMp4Summary(readFileSync(out))
    assert.equal(file.hasMoov, true)
    assert.equal(file.samples, r.frames)
    const v = judgeRecording(r, file)
    assert.equal(v.usable, true, v.notes.join('; '))
  } finally {
    fx.kill()
  }
})
