// 2단 픽스처 통합 시험 — 가상 커서 입력(zwwin.exe v* 동사)과 가상 커서 프레임(zwwin.exe frame).
//
// **요점: 사용자의 실제 커서·포그라운드를 건드리지 않고 대상 창에 입력이 닿는가.**
// 정답은 구현이 아니라 바깥에서 온다.
//   - 닿았는가 → 픽스처 자신의 기록: WinForms 는 눌린 사분면을 검게 칠하고(캡처로 본다),
//     Qt 는 받은 이벤트를 mouseLog 라벨에 적는다(zwagent 위젯 트리로 읽는다 — Qt 가 실제로 본 것).
//   - 실제 커서·포그라운드가 그대로인가 → 별도 PowerShell 프로세스가 동작하는 동안 GetCursorPos·
//     GetForegroundWindow 를 계속 읽어 본 값을 모두 적는다. 잠깐 옮겼다 돌려놓는 것(기존 click 의
//     동작)도 잡힌다 — 그걸 대조 시험으로 먼저 증명한다.
//
// 이 시험이 도는 동안 사람이 마우스를 움직이면 커서 시험이 거짓 실패한다.
//
//   ZWEAVE_ROOT=... node --test src/win/virtual.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { click, listWindows, shot, startFrame, virtualInput, ZWWIN_EXE } from './zwwin.ts'
import { QTAPP_EXE, ZWAGENT_DLL, qtEnv, qtFilter, qtFixtureMissing } from './qtFixture.ts'
import { pixelAt } from '../image/stats.ts'
import { judgeVirtual } from '../input/virtual.ts'
import { withRealInput } from './realInputLock.ts'
import { findWidgets, flattenWidgets } from '../agent/hello.ts'
import { call } from '../agent/pipe.ts'
import { parseTreeResult } from '../agent/protocol.ts'
import type { Bgra } from '../image/stats.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_EXE = resolve(HERE, '../../bin/zwfixture.exe')

const winSkip =
  process.platform === 'darwin'
    ? 'Windows 전용 — 창 메시지로 넣는 가상 커서 입력'
    : existsSync(ZWWIN_EXE) && existsSync(FIXTURE_EXE)
      ? false
      : 'bin/ 이 비어 있다. bash tools/zwwin/build.sh && bash fixtures/winapp/build.sh 를 먼저 실행한다.'
const qtSkip =
  winSkip ||
  qtFixtureMissing() ||
  (existsSync(ZWAGENT_DLL) ? false : `${ZWAGENT_DLL} 가 없다. bash tools/zwagent/build.sh 를 먼저 실행한다.`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- 바깥 관찰자: 실제 커서·포그라운드 --------------------------------------------

const SAMPLER_PS1 = `
param($stop, $ready, $out)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class S {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$cur = @{}; $fg = @{}; $n = 0
New-Item -ItemType File -Force $ready | Out-Null
while (-not (Test-Path $stop)) {
  $p = New-Object S+P; [void][S]::GetCursorPos([ref]$p)
  $cur["$($p.X),$($p.Y)"] = 1
  $fg["$([S]::GetForegroundWindow().ToInt64())"] = 1
  $n++
}
@{ cursors = @($cur.Keys); foregrounds = @($fg.Keys); samples = $n } | ConvertTo-Json | Set-Content -Encoding UTF8 $out
`

type Observed = { cursors: string[]; foregrounds: string[]; samples: number }

/**
 * 동작 fn 이 도는 동안 실제 커서 위치와 포그라운드 창을 계속 읽어 본 값을 모두 돌려준다.
 * 실제 입력 잠금을 잡는다 — 동시에 도는 다른 시험 파일의 click 이 커서를 옮기면 거짓 실패한다(realInputLock.ts).
 */
function observe<T>(fn: () => T | Promise<T>): Promise<{ value: T; seen: Observed }> {
  return withRealInput(() => observeUnlocked(fn))
}

async function observeUnlocked<T>(fn: () => T | Promise<T>): Promise<{ value: T; seen: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-observe-'))
  const ps1 = join(dir, 'sampler.ps1')
  writeFileSync(ps1, SAMPLER_PS1)
  const stop = join(dir, 'stop'), ready = join(dir, 'ready'), out = join(dir, 'out.json')
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, stop, ready, out], {
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    const deadline = Date.now() + 20000
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error('관찰자가 20초 안에 준비되지 않았다')
      await sleep(50)
    }
    await sleep(100)
    const value = await fn()
    await sleep(100)
    writeFileSync(stop, '')
    while (!existsSync(out)) {
      if (Date.now() > deadline + 20000) throw new Error('관찰자가 결과를 쓰지 않았다')
      await sleep(50)
    }
    await sleep(100)
    const raw = JSON.parse(readFileSync(out, 'utf8').replace(/^﻿/, '')) as Partial<Observed>
    const seen: Observed = {
      cursors: ([] as string[]).concat(raw.cursors ?? []),
      foregrounds: ([] as string[]).concat(raw.foregrounds ?? []),
      samples: raw.samples ?? 0,
    }
    assert.ok(seen.samples > 50, `관찰자가 너무 적게 읽었다(${seen.samples}) — 판정할 수 없다`)
    return { value, seen }
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

function assertUntouched(seen: Observed, what: string) {
  assert.equal(seen.cursors.length, 1, `${what}: 실제 커서가 움직였다 — 본 위치 ${seen.cursors.join(' ')}`)
  assert.equal(seen.foregrounds.length, 1, `${what}: 포그라운드 창이 바뀌었다 — ${seen.foregrounds.join(' ')}`)
}

// ---- WinForms 픽스처 -----------------------------------------------------------

/**
 * extra: '--dpi-aware'(캡처 픽셀 = 화면 픽셀) · '--topmost'(화면 캡처에 다른 창이 안 낀다).
 * 둘 다 없으면 DPI 를 모르는 창이다 — 배율 모니터에서 PrintWindow 는 늘리기 전 그림을 준다(2026-11-15, 200% 실측).
 */
async function launchWinForms(title: string, at: string, extra: string[] = []) {
  const child = spawn(FIXTURE_EXE, ['--title', title, '--at', at, ...extra], { stdio: 'ignore' })
  const pid = child.pid!
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const found = listWindows({ pid, title })
    if (found.length > 0 && found[0]!.width > 0) {
      await sleep(300)
      return { child, pid, win: found[0]! }
    }
    await sleep(100)
  }
  child.kill()
  throw new Error('WinForms 픽스처 창이 뜨지 않았다')
}

function capture(filter: { pid: number; title: string }, dir: string, name: string, mode?: 'screen'): Bgra {
  const raw = join(dir, `${name}.bgra`)
  const info = shot({ ...filter, png: join(dir, `${name}.png`), raw, mode })
  return { width: info.window.width, height: info.window.height, data: new Uint8Array(readFileSync(raw)) }
}

const isBlack = (img: Bgra, x: number, y: number) => {
  const p = pixelAt(img, x, y)
  return p.r < 20 && p.g < 20 && p.b < 20
}

test('대조: 기존 click 은 실제 커서를 옮긴다 — 관찰자가 그것을 잡는다', { skip: winSkip }, async () => {
  const title = 'zwprobe-vc-control'
  const { child, pid, win } = await launchWinForms(title, '760,140')
  try {
    const { seen } = await observe(() => click({ pid, title, x: Math.floor(win.width / 4), y: Math.floor(win.height / 4) }))
    assert.ok(seen.cursors.length > 1, `관찰자가 커서 이동을 못 잡았다 — 이 관찰자로는 아래 시험이 헛돈다 (${seen.cursors.join(' ')})`)
  } finally {
    child.kill()
  }
})

/** 네 사분면을 차례로 눌러, 누른 칸만 검게 변하는지 본다. 좌표는 캡처 픽셀(= 사람이 보는 화면 픽셀). */
async function quadrantCase(title: string, extra: string[], mode: 'screen' | undefined) {
  const { child, pid, win } = await launchWinForms(title, '760,140', extra)
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-vclick-'))
  try {
    const qx = Math.floor(win.width / 4), qy = Math.floor(win.height / 4)
    const cases: Array<[string, number, number]> = [
      ['좌상', qx, qy],
      ['우상', win.width - qx, qy],
      ['좌하', qx, win.height - qy],
      ['우하', win.width - qx, win.height - qy],
    ]
    for (const [name, cx, cy] of cases) {
      const { value: r, seen } = await observe(() => virtualInput({ op: 'click', x: cx, y: cy, pid, title }))
      assertUntouched(seen, `${name} vclick`)
      assert.equal(judgeVirtual(r).onTarget, true, judgeVirtual(r).reason)
      await sleep(150)
      const img = capture({ pid, title }, dir, `after-${name}`, mode)
      for (const [other, ox, oy] of cases) {
        assert.equal(isBlack(img, ox, oy), other === name, `${name} 을 눌렀는데 ${other} 사분면이 ${isBlack(img, ox, oy) ? '검다' : '검지 않다'} (창 DPI ${r.target.windowDpi}, 모니터 DPI ${r.target.monitorDpi})`)
      }
    }
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('vclick — 누른 사분면이 검어지고, 실제 커서·포그라운드는 그대로다', { skip: winSkip }, async () => {
  await quadrantCase('zwprobe-vc-winforms', ['--dpi-aware'], undefined)
})

test('vclick — DPI 를 모르는 앱도 사람이 보는 화면 픽셀 그대로 눌린다 (배율은 Windows 가 맞춘다)', { skip: winSkip }, async () => {
  // 정답은 사람이 보는 화면이다 — 맨 위로 띄운 픽스처를 화면 캡처로 본다. 배율 모니터면 Windows 가 늘려 보여준다.
  await quadrantCase('zwprobe-vc-unaware', ['--topmost'], 'screen')
})

test('vclick — 위에 겹친 투명 창(같은 프로세스)은 건너뛰고 그 아래 창이 받는다 (실제 클릭과 같다)', { skip: winSkip }, async () => {
  // 2026-11-15 실앱: CLO 가 메뉴 막대 위에 투명 레이어드 팝업(200x60, 소유자 없음, 맨 위)을 띄워 둬서
  // 가상 클릭 「파일」 이 그 팝업으로 갔다. 실제 마우스는 투명 창을 통과한다.
  const title = 'zwprobe-vc-ghost'
  const { child, pid, win } = await launchWinForms(title, '760,140', ['--topmost', '--dpi-aware', '--ghost'])
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-ghost-'))
  try {
    await sleep(500)
    assert.ok(listWindows({ pid, title: `${title}-ghost` }).length === 1, '사전 조건: 투명 창이 떠 있어야 한다')
    const cx = Math.floor(win.width / 4), cy = Math.floor(win.height / 4)
    const r = virtualInput({ op: 'click', x: cx, y: cy, pid, title })
    assert.equal(r.target.root, win.hwnd, `투명 창(hwnd=${r.target.root})이 받았다 — 메인 창 hwnd=${win.hwnd} 이어야 한다`)
    await sleep(150)
    assert.equal(isBlack(capture({ pid, title }, dir, 'ghost'), cx, cy), true, '왼쪽 위 사분면이 검지 않다 — 클릭이 메인 창에 안 닿았다')
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- Qt 픽스처 (mouseLog) ------------------------------------------------------

async function launchQt() {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-vqt-'))
  const hello = join(dir, 'hello.json')
  const child = spawn(QTAPP_EXE, ['--mousepad', '-style', 'zwagent'], { stdio: 'ignore', env: qtEnv({ ZWAGENT_HELLO: hello }) })
  const pid = child.pid!
  const filter = qtFilter(pid)
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (existsSync(hello) && listWindows(filter).length > 0) break
    await sleep(200)
  }
  await sleep(500)
  const tree = async () => {
    const t = await call(pid, { id: 9, op: 'tree' }, { timeoutMs: 10000 })
    assert.equal(t.ok, true, '위젯 트리를 못 읽었다')
    return t.ok ? parseTreeResult(t.body).topLevelWidgets : []
  }
  const log = async (): Promise<string[]> =>
    (findWidgets(await tree(), 'mouseLog')[0]?.text ?? '').split('\n').filter((l) => l !== '')
  // 판 위의 점을 캡처 좌표로 — 정답은 트리의 화면 좌표와 창 사각형에서 구한다(구현과 독립)
  const win = listWindows(filter)[0]!
  const pad = flattenWidgets(await tree()).find((w) => w.objectName === 'mousePad')!
  const at = (lx: number, ly: number) => ({ x: pad.screenX - win.x + lx, y: pad.screenY - win.y + ly })
  return {
    child, pid, filter, log, at,
    cleanup: () => { child.kill(); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** n 번째 이후 새로 적힌 줄 */
async function newLines(log: () => Promise<string[]>, from: number, waitMs = 400) {
  await sleep(waitMs)
  return (await log()).slice(from)
}

test('Qt — vclick 왼쪽·오른쪽·더블이 그 좌표의 press·release 로 적힌다', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    let n = (await q.log()).length
    const p = q.at(30, 40)
    const { value: r, seen } = await observe(() => virtualInput({ op: 'click', ...p, ...q.filter }))
    assertUntouched(seen, 'Qt vclick')
    assert.equal(judgeVirtual(r).onTarget, true, judgeVirtual(r).reason)
    let lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('press 30,40 b=L bs=L')), `press 가 없다: ${lines.join(' | ')}`)
    assert.ok(lines.some((l) => l.startsWith('release 30,40 b=L')), `release 가 없다: ${lines.join(' | ')}`)

    n = (await q.log()).length
    virtualInput({ op: 'click', ...q.at(50, 60), button: 'right', ...q.filter })
    lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('press 50,60 b=R bs=R')), `오른쪽 press 가 없다: ${lines.join(' | ')}`)

    n = (await q.log()).length
    virtualInput({ op: 'click', ...q.at(70, 80), double: true, ...q.filter })
    lines = await newLines(q.log, n)
    assert.ok(lines.filter((l) => l.startsWith('press 70,80 b=L')).length >= 2, `더블클릭의 두 번째 누름이 없다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vclick --ctrl 이면 Qt 가 Ctrl 을 본다 (m=C)', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    const n = (await q.log()).length
    virtualInput({ op: 'click', ...q.at(30, 40), mods: { ctrl: true }, ...q.filter })
    const lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => /^press 30,40 b=L bs=L m=C/.test(l)), `Ctrl 이 안 실렸다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vdrag 는 press → 누른 채 move → 끝점 release', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    const n = (await q.log()).length
    const a = q.at(30, 40), b = q.at(130, 40)
    const { seen } = await observe(() => virtualInput({ op: 'drag', ...a, toX: b.x, toY: b.y, steps: 5, ...q.filter }))
    assertUntouched(seen, 'Qt vdrag')
    const lines = await newLines(q.log, n)
    const press = lines.findIndex((l) => l.startsWith('press 30,40 b=L'))
    const release = lines.findIndex((l) => l.startsWith('release 130,40 b=L'))
    assert.ok(press >= 0 && release > press, `press·release 순서가 틀렸다: ${lines.join(' | ')}`)
    const held = lines.slice(press + 1, release).filter((l) => /^move \d+,40 b=- bs=L/.test(l))
    assert.ok(held.length >= 3, `누른 채 움직인 move 가 모자라다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vwheel 은 그 좌표의 휠로 적힌다', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    const n = (await q.log()).length
    virtualInput({ op: 'wheel', ...q.at(30, 40), delta: -120, ...q.filter })
    const lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('wheel 30,40 d=-120')), `휠이 없다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vmove 는 버튼 없이 옮긴다 (press 없음), 출발점을 주면 중간 move 가 이어진다', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    let n = (await q.log()).length
    const { seen } = await observe(() => virtualInput({ op: 'move', ...q.at(60, 70), ...q.filter }))
    assertUntouched(seen, 'Qt vmove')
    let lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('move 60,70 b=- bs=-')), `move 가 없다: ${lines.join(' | ')}`)
    assert.ok(!lines.some((l) => l.startsWith('press')), `move 인데 press 가 있다: ${lines.join(' | ')}`)

    n = (await q.log()).length
    const a = q.at(10, 20), b = q.at(110, 20)
    virtualInput({ op: 'move', ...b, fromX: a.x, fromY: a.y, steps: 5, ...q.filter })
    lines = await newLines(q.log, n)
    const moves = lines.filter((l) => /^move \d+,20 b=- bs=-/.test(l))
    assert.ok(moves.length >= 4, `중간 move 가 모자라다: ${lines.join(' | ')}`)
    assert.ok(moves[moves.length - 1]!.startsWith('move 110,20'), `끝점이 아니다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vkey 는 키로, Ctrl 조합은 m=C 로 적힌다', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    let n = (await q.log()).length
    const { seen } = await observe(() => virtualInput({ op: 'key', vk: 0x41, ...q.filter }))
    assertUntouched(seen, 'Qt vkey')
    let lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('keypress k=41 m=- t=a')), `A 키가 없다: ${lines.join(' | ')}`)

    n = (await q.log()).length
    virtualInput({ op: 'key', vk: 0x41, mods: { ctrl: true }, ...q.filter })
    lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('keypress k=41 m=C')), `Ctrl+A 가 없다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vtype 은 글자를 순서대로 넣는다', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    const n = (await q.log()).length
    virtualInput({ op: 'type', text: 'aB1', ...q.filter })
    const lines = await newLines(q.log, n)
    const typed = lines.filter((l) => l.startsWith('keypress')).map((l) => l.replace(/^.* t=/, ''))
    assert.deepEqual(typed, ['a', 'B', '1'], `글자가 다르다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

test('Qt — vtype 은 키보드로 못 치는 글자(한글)도 그대로 넣는다', { skip: qtSkip }, async () => {
  // 2026-11-15 실앱(Z-Weave 파일 열기 창)에서 "가상커서_확인" 이 "?좆按_Ux" 로 깨졌다 — 그 회귀 시험
  const q = await launchQt()
  try {
    const n = (await q.log()).length
    virtualInput({ op: 'type', text: 'a가나_확인', ...q.filter })
    const lines = await newLines(q.log, n)
    const typed = lines.filter((l) => l.startsWith('keypress')).map((l) => l.replace(/^.* t=/, ''))
    assert.deepEqual(typed, ['a', '가', '나', '_', '확', '인'], `글자가 다르다: ${lines.join(' | ')}`)
  } finally {
    q.cleanup()
  }
})

// ---- CLI 끝까지 ----------------------------------------------------------------

const CLI_TS = resolve(HERE, '../cli.ts')
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI_TS, ...args], { encoding: 'utf8', windowsHide: true, env: qtEnv() })

test('CLI — click --virtual 이 프레임을 알아서 띄우고 Qt 가 받는다, frame stop 이 닫는다', { skip: qtSkip }, async () => {
  const q = await launchQt()
  try {
    const target = listWindows(q.filter)[0]!
    const n = (await q.log()).length
    const p = q.at(40, 50)
    const r = cli('click', String(p.x), String(p.y), '--virtual', '--pid', String(q.pid), '--title', 'zwqtfixture')
    assert.equal(r.status, 0, `종료 코드 ${r.status}\n${r.stdout}\n${r.stderr}`)
    const lines = await newLines(q.log, n)
    assert.ok(lines.some((l) => l.startsWith('press 40,50 b=L')), `press 가 없다: ${lines.join(' | ')}`)
    const frame = listWindows({ title: `zwprobe-vcursor:${target.hwnd}` })
    assert.equal(frame.length, 1, '프레임이 하나 떠 있어야 한다')

    const s = cli('frame', 'stop', '--pid', String(q.pid), '--title', 'zwqtfixture')
    assert.equal(s.status, 0, `${s.stdout}\n${s.stderr}`)
    assert.equal(listWindows({ title: `zwprobe-vcursor:${target.hwnd}` }).length, 0, 'frame stop 뒤에도 프레임이 남았다')
  } finally {
    cli('frame', 'stop', '--pid', String(q.pid), '--title', 'zwqtfixture')
    q.cleanup()
  }
})

// ---- 가상 커서 프레임 ----------------------------------------------------------

const WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000

async function withFrame<T>(filter: { pid: number; title: string }, opts: { exclude: boolean }, fn: (hwnd: number, framePid: number) => Promise<T>) {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-frame-'))
  const stop = join(dir, 'stop'), result = join(dir, 'result.json')
  const target = listWindows(filter)[0]!
  const framePid = startFrame({ ...filter, stop, result, excludeFromCapture: opts.exclude })
  try {
    const deadline = Date.now() + 8000
    let frame
    while (Date.now() < deadline) {
      frame = listWindows({ pid: framePid, title: `zwprobe-vcursor:${target.hwnd}` })[0]
      if (frame) break
      await sleep(100)
    }
    assert.ok(frame, '프레임 창이 뜨지 않았다')
    return await fn(frame.hwnd, framePid)
  } finally {
    writeFileSync(stop, '')
    await sleep(300)
    spawnSync('taskkill', ['/F', '/PID', String(framePid)], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  }
}

test('frame — 클릭 통과·비활성·맨 위 창으로 대상 창을 덮고, 띄워도 포그라운드가 그대로다', { skip: winSkip }, async () => {
  const title = 'zwprobe-vc-frame'
  const { child, pid, win } = await launchWinForms(title, '760,140')
  try {
    const { seen } = await observe(() =>
      withFrame({ pid, title }, { exclude: true }, async (hwnd, framePid) => {
        const f = listWindows({ title: `zwprobe-vcursor:${win.hwnd}` }).find((w) => w.hwnd === hwnd)!
        // 프레임 프로세스의 창 전부(빛·선·알약·커서, 2026-11-17 Claude in Chrome 디자인)가 클릭 통과·비활성·맨 위여야 한다
        const all = listWindows({ pid: framePid })
        assert.ok(all.length >= 1, '프레임 프로세스 창이 없다')
        for (const w of all) {
          for (const [bit, name] of [[WS_EX_TOPMOST, 'TOPMOST'], [WS_EX_TRANSPARENT, 'TRANSPARENT'], [WS_EX_TOOLWINDOW, 'TOOLWINDOW'], [WS_EX_LAYERED, 'LAYERED'], [WS_EX_NOACTIVATE, 'NOACTIVATE']] as const) {
            assert.ok((w.exStyle & bit) !== 0, `프레임 창 "${w.title}" 에 WS_EX_${name} 가 없다`)
          }
        }
        // 테두리를 대상 창 안쪽 가장자리에 그린다 — 밖에 그리면 최대화된 창에서 모니터 밖으로 나가 안 보인다(2026-11-17).
        // 픽스처는 모니터 안에 있으므로 프레임 = 대상 창 그대로다.
        assert.deepEqual(
          { x: f.x, y: f.y, width: f.width, height: f.height },
          { x: win.x, y: win.y, width: win.width, height: win.height },
          '프레임이 대상 창과 같은 자리·크기가 아니다',
        )
      }),
    )
    assert.equal(seen.foregrounds.length, 1, `프레임을 띄우자 포그라운드가 바뀌었다: ${seen.foregrounds.join(' ')}`)
  } finally {
    child.kill()
  }
})

test('frame — 가상 커서는 사람에게만 보이고 캡처에는 안 찍힌다 (대조: 제외를 끄면 찍힌다)', { skip: winSkip }, async () => {
  // 맨 위 픽스처여야 한다 — 아니면 화면 캡처에 다른 창이 끼어 "커서 픽셀" 이 그 창의 픽셀이 된다
  // (2026-11-15 첫 시도가 그렇게 헛돌았다: 제외가 됐는데도 280픽셀이 잡혔다).
  const title = 'zwprobe-vc-capture'
  const { child, pid, win } = await launchWinForms(title, '760,140', ['--topmost', '--dpi-aware'])
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-fcap-'))
  // 좌상 사분면을 눌러 검게 만든 뒤 그 자리에 가상 커서가 있다. 검은 칸 위의 커서 색이 보이는지 본다.
  const cx = Math.floor(win.width / 4), cy = Math.floor(win.height / 4)
  const nonBlackNear = (img: Bgra) => {
    let n = 0
    for (let dy = 0; dy < 20; dy++) for (let dx = 0; dx < 14; dx++) if (!isBlack(img, cx + dx, cy + dy)) n++
    return n
  }
  try {
    for (const exclude of [false, true]) {
      await withFrame({ pid, title }, { exclude }, async () => {
        const r = virtualInput({ op: 'click', x: cx, y: cy, pid, title })
        assert.equal(r.frame, true, '가상 입력이 프레임에 커서 위치를 알리지 않았다')
        await sleep(400)
        const n = nonBlackNear(capture({ pid, title }, dir, `screen-${exclude}`, 'screen'))
        if (exclude) assert.equal(n, 0, `캡처 제외인데 커서 픽셀 ${n}개가 찍혔다`)
        else assert.ok(n > 10, `대조 실패 — 제외를 껐는데 커서가 안 찍혔다(${n}). 커서를 안 그린 것이면 위 시험이 헛돈다`)
      })
    }
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- 프레임이 사람에게 보이는가 — Claude in Chrome 디자인 (2026-11-17) ----------------------
//
// Z-Weave 를 4K 보조 모니터에 최대화해 두자 테두리가 안 보였다 — 대상 창 **바깥** 3px 에 그려서
// 위·오른쪽은 모니터 밖, 왼쪽은 옆 모니터, 아래는 작업 표시줄 위에 놓였다. 그 뒤 사용자가 "Claude in Chrome 과
// 같은 디자인" 을 요청했다. 기준 값은 구현이 아니라 Claude in Chrome 확장(1.0.107)
// `assets/agent-visual-indicator.js` 의 CSS 에서 왔다:
//   - 색 B = rgb(198, 97, 63)
//   - 테두리: 안쪽 3px 단색 선 + 안쪽 빛 inset 0 0 22px/44px/66px rgba(B, .8/.5/.25), 빛만 2초 주기로 0.6↔1 숨쉬기
//   - 커서: 22px 칸(viewBox 18)에 끝이 왼쪽 위인 삼각 화살표, B 채움 + 흰 외곽선 1.5, 0.2초 미끄러짐
//   - 클릭: 34px 원(3px B 테두리, B 30% 바탕)이 0.22→1 로 커지며 0.65초 동안 사라진다
//   - 알약: 위 가운데에 붙은 B 바탕 + 흰 글자 (Stop 버튼은 뺐다 — 멈추는 장치가 따로 필요하다)
// 정답은 화면 픽셀이다: 캡처 제외를 끈 프레임을 띄우고 대상 창을 화면 캡처한다. 배율의 기준 dpi 는
// 구현이 아니라 PowerShell 의 GetDpiForWindow 로 따로 읽는다.

const BORDER_BASE = 3 // 96 dpi 에서의 선 두께
const GLOW_REACH_BASE = 66 // 96 dpi 에서 가장 넓은 빛의 번짐 반경 — 그 밖은 원래 색
const ARROW_BASE_H = 19 // 96 dpi 에서의 화살표 높이 (채움 17.4 + 외곽선)

const B = { r: 198, g: 97, b: 63 }
const isOrange = (img: Bgra, x: number, y: number) => {
  const p = pixelAt(img, x, y)
  return Math.abs(p.r - B.r) < 12 && Math.abs(p.g - B.g) < 12 && Math.abs(p.b - B.b) < 12
}
const isWhite = (img: Bgra, x: number, y: number) => {
  const p = pixelAt(img, x, y)
  return p.r > 200 && p.g > 200 && p.b > 200
}

function dpiOf(hwnd: number): number {
  const ps = `Add-Type -Namespace W -Name D -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);'; [W.D]::GetDpiForWindow([IntPtr]${hwnd})`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  const dpi = Number(r.stdout.trim())
  assert.ok(dpi >= 96, `GetDpiForWindow 를 못 읽었다: ${r.stdout} ${r.stderr}`)
  return dpi
}

/** 맨 위 픽스처 + 캡처 제외 끈 프레임으로 fn 을 돌린다 */
async function withVisibleFrame(name: string, extra: string[], fn: (ctx: { pid: number; title: string; win: { width: number; height: number; hwnd: number }; dpi: number; shot: (n: string) => Bgra }) => Promise<void>) {
  const title = `zwprobe-vc-${name}`
  const { child, pid, win } = await launchWinForms(title, '760,140', ['--topmost', '--dpi-aware', ...extra])
  const dir = mkdtempSync(join(tmpdir(), `zwprobe-f${name}-`))
  try {
    const dpi = dpiOf(win.hwnd)
    await withFrame({ pid, title }, { exclude: false }, async () => {
      await sleep(400)
      await fn({ pid, title, win, dpi, shot: (n) => capture({ pid, title }, dir, n, 'screen') })
    })
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const maximized of [false, true]) {
  test(`frame — 테두리 선이 대상 창 네 변 안쪽에 보이고 두께가 배율을 따른다 (${maximized ? '최대화' : '보통'} 창)`, { skip: winSkip }, async () => {
    await withVisibleFrame(`border-${maximized ? 'max' : 'win'}`, maximized ? ['--maximized'] : [], async ({ dpi, shot }) => {
      const want = Math.round((BORDER_BASE * dpi) / 96)
      const img = shot('border')
      // 위 변은 가운데에 알약이 붙으므로 왼쪽 1/4 지점에서 본다
      const qx = Math.floor(img.width / 4), my = Math.floor((img.height * 3) / 4)
      const edges: Array<[string, number, number]> = [
        ['위', qx, 0], ['아래', qx, img.height - 1], ['왼쪽', 0, my], ['오른쪽', img.width - 1, my],
      ]
      const missing = edges.filter(([, x, y]) => !isOrange(img, x, y)).map(([n, x, y]) => `${n}(${x},${y})=${JSON.stringify(pixelAt(img, x, y))}`)
      assert.deepEqual(missing, [], `테두리가 안 보이는 변: ${missing.join(' ')}`)
      let run = 0
      while (run < img.width && isOrange(img, run, my)) run++
      assert.equal(run, want, `왼쪽 테두리 두께 ${run}px — dpi ${dpi} 에서 ${want}px 여야 한다`)
    })
  })
}

test('frame — 선 안쪽으로 빛이 옅어지며 번지고, 번짐 반경 밖은 원래 색 그대로다', { skip: winSkip }, async () => {
  await withVisibleFrame('glow', [], async ({ dpi, shot }) => {
    const t = Math.round((BORDER_BASE * dpi) / 96), reach = Math.round((GLOW_REACH_BASE * dpi) / 96)
    const img = shot('glow')
    // 왼쪽 아래 사분면은 파랑(0,0,255) — 그 위에 B 가 섞인 만큼 빨강 채널이 오른다
    const lines: Array<[string, (d: number) => [number, number]]> = [
      ['왼쪽', (d) => [d, Math.floor((img.height * 3) / 4)]],
      ['아래', (d) => [Math.floor(img.width / 4), img.height - 1 - d]],
    ]
    for (const [name, at] of lines) {
      const reds = Array.from({ length: reach - t + 3 }, (_, i) => pixelAt(img, ...at(t + i)).r)
      assert.ok(reds[0]! > 50, `${name}: 선 바로 안쪽에 빛이 없다 (빨강 ${reds[0]}) — ${reds.join(',')}`)
      const mid = Math.floor((reach - t) / 3)
      assert.ok(reds[mid]! > 3 && reds[mid]! < reds[0]!, `${name}: 번짐 중간이 옅어지는 중이 아니다 — ${reds.join(',')}`)
      for (let i = 1; i < reds.length; i++) assert.ok(reds[i]! <= reds[i - 1]! + 2, `${name}: 안쪽으로 갈수록 옅어져야 하는데 ${i} 에서 진해졌다 — ${reds.join(',')}`)
      const out = pixelAt(img, ...at(reach + 2))
      assert.ok(out.r < 6 && out.g < 6 && out.b > 249, `${name}: 번짐 반경 밖(${reach + 2}px)이 원래 파랑이 아니다 ${JSON.stringify(out)}`)
    }
  })
})

test('frame — 빛이 숨쉰다 (진하기가 시간에 따라 바뀌고, 선은 그대로다)', { skip: winSkip }, async () => {
  await withVisibleFrame('pulse', [], async ({ dpi, shot }) => {
    const t = Math.round((BORDER_BASE * dpi) / 96)
    const reds: number[] = [], lineOk: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const img = shot(`pulse-${i}`)
      const my = Math.floor((img.height * 3) / 4)
      reds.push(pixelAt(img, t + 2, my).r)
      lineOk.push(isOrange(img, 0, my))
      await sleep(500)
    }
    assert.ok(Math.max(...reds) - Math.min(...reds) >= 15, `빛 세기가 시간에 따라 안 바뀐다 — ${reds.join(',')}`)
    assert.deepEqual(lineOk, [true, true, true, true], '숨쉬는 동안 선 색이 흔들렸다')
  })
})

test('frame — 가상 커서 화살표: 크기가 배율을 따르고, B 채움에 흰 외곽선이다', { skip: winSkip }, async () => {
  await withVisibleFrame('arrow', [], async ({ pid, title, win, dpi, shot }) => {
    const want = Math.round((ARROW_BASE_H * dpi) / 96)
    // 좌상 사분면을 눌러 검게 만든 뒤 그 자리에 화살표가 있다 — 클릭 원이 사라진 뒤(1초) 잰다
    const cx = Math.floor(win.width / 4), cy = Math.floor(win.height / 4)
    virtualInput({ op: 'click', x: cx, y: cy, pid, title })
    await sleep(1000)
    const img = shot('arrow')
    const rowHasArrow = (y: number) => {
      for (let x = cx - 8; x < cx + 45; x++) if (!isBlack(img, x, y)) return true
      return false
    }
    const rows: number[] = []
    for (let y = cy - 8; y < Math.min(img.height / 2, cy + 60); y++) if (rowHasArrow(y)) rows.push(y)
    const h = rows.length === 0 ? 0 : rows[rows.length - 1]! - rows[0]! + 1
    let fill = 0, white = 0
    for (let y = cy - 8; y < cy + 60; y++) for (let x = cx - 8; x < cx + 45; x++) {
      if (isOrange(img, x, y)) fill++
      if (isWhite(img, x, y)) white++
    }
    assert.ok(fill > 30, `화살표 채움이 B 색이 아니다 (그 색 픽셀 ${fill}개)`)
    assert.ok(white > 10, `화살표에 흰 외곽선이 없다 (흰 픽셀 ${white}개)`)
    assert.ok(Math.abs(h - want) <= 3, `화살표 높이 ${h}px — dpi ${dpi} 에서 ${want}px(±3) 여야 한다`)
  })
})

test('frame — 가상 클릭하면 누른 자리에 원이 퍼졌다가 사라진다', { skip: winSkip }, async () => {
  await withVisibleFrame('ring', [], async ({ pid, title, win, dpi, shot }) => {
    // 먼저 한 번 눌러 좌상 사분면을 검게 만들고 원이 사라지길 기다린다 — 검은 바탕 위에서 원을 본다
    const cx = Math.floor(win.width / 4), cy = Math.floor(win.height / 4)
    virtualInput({ op: 'click', x: cx, y: cy, pid, title })
    await sleep(1200)
    // 화살표는 끝점의 오른쪽 아래에 있으므로 원은 왼쪽 위 1/4 고리에서 센다
    const r = Math.round((22 * dpi) / 96)
    const ringPixels = (img: Bgra) => {
      let n = 0
      for (let y = cy - r; y < cy - 2; y++) for (let x = cx - r; x < cx - 2; x++) if (pixelAt(img, x, y).r > 15) n++
      return n
    }
    const before = ringPixels(shot('ring-before'))
    assert.equal(before, 0, `누르기 전인데 원 자리에 픽셀 ${before}개`)
    virtualInput({ op: 'click', x: cx, y: cy, pid, title })
    const during = ringPixels(shot('ring-during'))
    assert.ok(during > 10, `누른 직후 원이 안 보인다 (픽셀 ${during}개)`)
    await sleep(1000)
    const after = ringPixels(shot('ring-after'))
    assert.equal(after, 0, `1초 뒤에도 원이 남았다 (픽셀 ${after}개)`)
  })
})

test('frame — 위 가운데에 B 바탕·흰 글자 알약이 붙는다', { skip: winSkip }, async () => {
  await withVisibleFrame('pill', [], async ({ dpi, shot }) => {
    const s = dpi / 96
    const img = shot('pill')
    const mx = Math.floor(img.width / 2), y = Math.round(16 * s)
    // 가운데에서 양쪽으로 B·흰색(글자)·그 사이 섞인 색이 이어지는 폭. 빛이 덮인 픽스처 빨강·초록은
    // 초록 채널(빨강 위)이나 빨강 채널(초록 위)이 낮아 여기에 안 든다
    const inPill = (x: number) => {
      const p = pixelAt(img, x, y)
      return p.r >= 185 && p.g >= 85 && p.b >= 50
    }
    assert.ok(inPill(mx) || inPill(mx - 1), `위 가운데 (${mx},${y}) 가 알약이 아니다 ${JSON.stringify(pixelAt(img, mx, y))}`)
    let l = mx, r = mx
    while (l > 0 && inPill(l - 1)) l--
    while (r < img.width - 1 && inPill(r + 1)) r++
    const w = r - l + 1
    assert.ok(w >= 80 * s && w <= 320 * s, `알약 폭 ${w}px — ${Math.round(80 * s)}~${Math.round(320 * s)}px 여야 한다`)
    let white = 0
    for (let yy = 0; yy < Math.round(34 * s); yy++) for (let x = l; x <= r; x++) if (isWhite(img, x, yy)) white++
    assert.ok(white > 20, `알약에 흰 글자가 없다 (흰 픽셀 ${white}개)`)
  })
})
