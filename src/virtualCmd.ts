// 가상 커서 CLI 동사 — click --virtual · key --virtual · drag · wheel · type · frame (2026-11-15).
//
// 실제 커서·포그라운드를 건드리지 않고 입력한다(src/input/virtual.ts 머리말). 입력하기 전에 대상 창에
// 가상 커서 프레임이 없으면 띄운다 — 사람이 "프로그램 안의 두 번째 커서" 를 보게 하려는 것이다(--no-frame 으로 끈다).
// 판정은 judgeVirtual, I/O 는 zwwin.ts. 이 파일은 그 둘을 잇고 사람이 읽을 줄을 찍는다.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { frameTitle, listWindows, startFrame, virtualInput } from './win/zwwin.ts'
import { judgeVirtual } from './input/virtual.ts'
import { frameLabel } from './input/frameLabel.ts'
import type { Mods, VirtualRequest, VirtualResult } from './input/virtual.ts'
import type { WindowFilter, WindowInfo } from './win/zwwin.ts'

/** 부르는 위치와 상관없이 이 리포의 runs/frames — 다른 폴더에서 CLI 를 부르면 그 폴더에 파일이 생기던 함정을 피한다 */
const FRAMES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../runs/frames')
const FRAME_PREFIX = 'zwprobe-vcursor:'

/** 사람이 알약의 「중지」 를 누르면 생기는 파일 — 대상 창마다 하나 (2026-11-17) */
export const haltFileOf = (targetHwnd: number) => join(FRAMES_DIR, `${targetHwnd}.halt`)

/** 사람이 멈췄을 때의 종료 코드. MCP 도구의 exits[4] 와 같다 */
export const EXIT_HALTED = 4

const HALT_HELP =
  '사람이 알약의 「중지」 를 눌렀다 — 사용자에게 묻는다. 스스로 풀지 않는다. ' +
  '재개는 사람이 알약의 「재개」 를 누르거나 (사람이) zwprobe frame resume'

/** 창 크기가 좌표의 기준과 달라 넣지 않았을 때의 종료 코드. MCP 도구의 exits[5] 와 같다 (2026-11-17) */
export const EXIT_RESIZED = 5

const RESIZE_HELP = '좌표가 어긋났을 수 있다 — 다시 캡처(zwprobe shot)해서 좌표를 새로 잡는다. 사람이 창 크기를 바꿨을 수 있다'

/**
 * 좌표의 기준이 된 창 크기 — 대상 창마다 하나. shot·uia(좌표를 주는 관찰)와 성공한 가상 입력이 쓰고,
 * 마우스 가상 입력이 입력 전에 견준다. 위치만 옮긴 것은 좌표가 창 기준이라 상관없어 크기만 본다 (2026-11-17 사용자).
 */
export const sizeFileOf = (hwnd: number) => join(FRAMES_DIR, `${hwnd}.size`)

export function recordSize(w: { hwnd: number; width: number; height: number }): void {
  try {
    mkdirSync(FRAMES_DIR, { recursive: true })
    writeFileSync(sizeFileOf(w.hwnd), `${w.width}x${w.height}`, 'utf8')
  } catch {
    // 기준을 못 적어도 관찰은 그대로 — 다음 입력은 그때 크기를 기준으로 한다
  }
}

/** 적어 둔 기준 크기. 없거나 못 읽으면 undefined */
export function savedSize(hwnd: number): { width: number; height: number } | undefined {
  try {
    const m = /^(\d+)x(\d+)$/.exec(readFileSync(sizeFileOf(hwnd), 'utf8').trim())
    return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function modsFrom(flags: Map<string, string>): Mods {
  return { ctrl: flags.has('ctrl'), shift: flags.has('shift'), alt: flags.has('alt') }
}

/** 떠 있는 프레임들. 제목 조각 필터는 "…:12" 가 "…:123" 에도 맞으므로 대상 hwnd 를 정확히 비교한다 */
function frames(): Array<{ frame: WindowInfo; target: number }> {
  return listWindows({ title: FRAME_PREFIX })
    .filter((w) => w.title.startsWith(FRAME_PREFIX))
    .map((w) => ({ frame: w, target: Number(w.title.slice(FRAME_PREFIX.length)) }))
}

/** 대상 창 — zwwin.exe 와 같은 선택 규칙(조건에 맞는 것 중 가장 큰 창, listWindows 가 그 순서로 준다) */
function targetOf(filter: WindowFilter): WindowInfo | undefined {
  return listWindows(filter)[0]
}

/**
 * 대상 창에 프레임이 없으면 띄우고 뜰 때까지 기다린다. 띄운 것이 있으면 true.
 * 알약 문구는 **부를 때마다** `<hwnd>.label` 에 쓴다 — 떠 있는 프레임이 0.5초마다 읽으므로 다른 AI 가 이어서
 * 부르면 문구가 바뀐다 (--label > ZWPROBE_AGENT > 기본, frameLabel.ts, 2026-11-17).
 */
export async function ensureFrame(filter: WindowFilter, flags?: Map<string, string>): Promise<{ target?: WindowInfo; started: boolean }> {
  const target = targetOf(filter)
  if (target === undefined) return { started: false }
  mkdirSync(FRAMES_DIR, { recursive: true })
  const labelFile = join(FRAMES_DIR, `${target.hwnd}.label`)
  writeFileSync(labelFile, frameLabel(process.env.ZWPROBE_AGENT, flags?.get('label')), 'utf8')
  if (frames().some((f) => f.target === target.hwnd)) return { target, started: false }
  const stop = join(FRAMES_DIR, `${target.hwnd}.stop`)
  rmSync(stop, { force: true })
  startFrame({ pid: target.pid, title: target.title, stop, result: join(FRAMES_DIR, `${target.hwnd}.json`), labelFile, haltFile: haltFileOf(target.hwnd), busyDir: join(FRAMES_DIR, 'busy') })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (frames().some((f) => f.target === target.hwnd)) return { target, started: true }
    await sleep(100)
  }
  console.error('주의  가상 커서 프레임이 5초 안에 뜨지 않았다. 입력은 그대로 한다.')
  return { target, started: false }
}

/** 입력하고 결과를 찍는다. 0=대상이 받았다 2=의심 4=사람이 멈춤 5=창 크기가 기준과 다름 */
async function runVirtual(req: VirtualRequest, filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  // 사람이 멈췄으면 아무것도 하지 않는다 — --no-frame 이어도 (멈춤은 대상 창에 붙는다)
  const target = targetOf(filter)
  const halt = target !== undefined ? haltFileOf(target.hwnd) : undefined
  if (halt !== undefined && existsSync(halt)) {
    console.log(`멈춤  입력하지 않았다 — ${HALT_HELP}`)
    return EXIT_HALTED
  }
  // 마우스 입력은 좌표가 창 기준이다 — 마지막 캡처 뒤 창 크기가 바뀌었으면 넣지 않는다 (키·글자는 좌표와 무관)
  const mouse = req.op === 'click' || req.op === 'drag' || req.op === 'wheel' || req.op === 'move'
  const saved = mouse && target !== undefined ? savedSize(target.hwnd) : undefined
  if (mouse && target !== undefined && saved !== undefined && (saved.width !== target.width || saved.height !== target.height)) {
    console.log(`크기  입력하지 않았다 — 창 크기가 바뀌었다 (기준 ${saved.width}x${saved.height} → 지금 ${target.width}x${target.height}). ${RESIZE_HELP}`)
    return EXIT_RESIZED
  }
  const expectSize = mouse && target !== undefined ? (saved ?? { width: target.width, height: target.height }) : undefined
  if (!flags.has('no-frame')) {
    const f = await ensureFrame(filter, flags)
    if (f.started) console.log(`프레임  대상 창 위에 가상 커서를 띄웠다 (끄기: zwprobe frame stop)`)
  }
  // 누르기 전의 창 목록 — 소유 다이얼로그가 받은 것을 맞다고 판정하려면 필요하다(judgeVirtual)
  const before = listWindows(filter.pid !== undefined ? { pid: filter.pid } : filter)
  const r: VirtualResult = virtualInput({ ...req, ...filter, ...(halt !== undefined ? { haltFile: halt } : {}), ...(expectSize !== undefined ? { expectSize } : {}) })
  if (r.halted === true) {
    console.log(`멈춤  ${r.stepsDone === 0 ? '입력하지 않았다' : `${r.stepsDone} 단계에서 끊었다 (끌기면 그 자리에서 버튼을 뗐다)`} — ${HALT_HELP}`)
    return EXIT_HALTED
  }
  if (r.resized === true) {
    console.log(`크기  ${r.stepsDone === 0 ? '입력하지 않았다' : `${r.stepsDone} 단계에서 끊었다 (끌기면 그 자리에서 버튼을 뗐다)`} — 창 크기가 바뀌었다. ${RESIZE_HELP}`)
    return EXIT_RESIZED
  }
  if (mouse && target !== undefined && saved === undefined) recordSize({ hwnd: target.hwnd, width: target.width, height: target.height })
  printVirtual(r)
  const v = judgeVirtual(r, before.filter((w) => w.pid === r.window.pid))
  console.log(`판정  ${v.onTarget ? '정상' : '의심'} — ${v.reason}`)
  return v.onTarget ? 0 : 2
}

function printVirtual(r: VirtualResult): void {
  const at = r.x !== undefined ? ` 창 기준 (${r.x},${r.y})` : ''
  console.log(`가상  ${r.op}${at} → 받은 창 hwnd=${r.target.hwnd} (${r.target.clientX},${r.target.clientY})`)
  console.log(`대상  ${r.window.width}x${r.window.height} hwnd=${r.window.hwnd} pid=${r.window.pid} "${r.window.title}"`)
  const same =
    r.cursorBefore.x === r.cursorAfter.x && r.cursorBefore.y === r.cursorAfter.y && r.foregroundBefore === r.foregroundAfter
  // 사실만 — 그사이 사람이 움직였을 수 있으므로 판정에 넣지 않는다
  console.log(same ? '커서  실제 커서·포그라운드 그대로' : '커서  실제 커서나 포그라운드가 바뀌었다 (사람이 움직였을 수 있다)')
}

function ints(names: string[], values: Array<string | undefined>): number[] | string {
  const out: number[] = []
  for (let i = 0; i < names.length; i++) {
    const v = values[i]
    if (v === undefined) return `${names.join(' ')} 가 필요하다`
    const n = Number(v)
    if (!Number.isInteger(n)) return `${names[i]} 는 정수여야 한다: "${v}"`
    out.push(n)
  }
  return out
}

function buttonFrom(flags: Map<string, string>): 'left' | 'right' | 'middle' | string {
  return flags.get('button') || 'left'
}

export async function virtualClick(x: number, y: number, filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  if (flags.has('slow') || flags.has('stay')) {
    console.error('--slow·--stay 는 실제 커서를 쓰는 click 의 것이다. --virtual 과 함께 쓸 수 없다.')
    return 1
  }
  const button = buttonFrom(flags)
  if (button !== 'left' && button !== 'right' && button !== 'middle') {
    console.error(`--button 은 left, right, middle 중 하나여야 한다: ${button}`)
    return 1
  }
  return runVirtual(
    {
      op: 'click', x, y, button, double: flags.has('double'), mods: modsFrom(flags),
      ...(flags.has('hold') ? { holdMs: Number(flags.get('hold')) } : {}),
    },
    filter,
    flags,
  )
}

export async function virtualKey(stroke: { vk: number; ctrl: boolean; shift: boolean; alt: boolean }, filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  return runVirtual({ op: 'key', vk: stroke.vk, mods: { ctrl: stroke.ctrl, shift: stroke.shift, alt: stroke.alt } }, filter, flags)
}

export async function cmdDrag(rest: string[], filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  const p = ints(['x', 'y', 'to-x', 'to-y'], rest)
  if (typeof p === 'string') {
    console.error(`${p}\n  zwprobe drag <x> <y> <끝x> <끝y> [--steps 10] [--button left] [--ctrl] [--shift] [--alt]`)
    return 1
  }
  const button = buttonFrom(flags)
  if (button !== 'left' && button !== 'right' && button !== 'middle') {
    console.error(`--button 은 left, right, middle 중 하나여야 한다: ${button}`)
    return 1
  }
  return runVirtual(
    {
      op: 'drag', x: p[0]!, y: p[1]!, toX: p[2]!, toY: p[3]!, button, mods: modsFrom(flags),
      ...(flags.has('steps') ? { steps: Number(flags.get('steps')) } : {}),
    },
    filter,
    flags,
  )
}

export async function cmdWheel(rest: string[], filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  const p = ints(['x', 'y', 'delta'], rest)
  if (typeof p === 'string') {
    console.error(`${p}\n  zwprobe wheel <x> <y> <delta>   delta 120 = 한 칸 위, -120 = 한 칸 아래`)
    return 1
  }
  return runVirtual({ op: 'wheel', x: p[0]!, y: p[1]!, delta: p[2]!, mods: modsFrom(flags) }, filter, flags)
}

/** 버튼 없이 옮긴다. --from x,y 를 주면 거기서부터 --steps 번에 걸쳐 지난다(마우스를 올려야 열리는 메뉴) */
export async function cmdMove(rest: string[], filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  const p = ints(['x', 'y'], rest)
  if (typeof p === 'string') {
    console.error(`${p}\n  zwprobe move <x> <y> [--from x,y] [--steps 10]`)
    return 1
  }
  let from: { fromX: number; fromY: number } | {} = {}
  if (flags.has('from')) {
    const f = ints(['from-x', 'from-y'], (flags.get('from') ?? '').split(','))
    if (typeof f === 'string') {
      console.error(`--from 은 x,y 다: "${flags.get('from')}"`)
      return 1
    }
    from = { fromX: f[0]!, fromY: f[1]! }
  }
  return runVirtual(
    { op: 'move', x: p[0]!, y: p[1]!, ...from, ...(flags.has('steps') ? { steps: Number(flags.get('steps')) } : {}) },
    filter,
    flags,
  )
}

export async function cmdType(rest: string[], filter: WindowFilter, flags: Map<string, string>): Promise<number> {
  if (rest.length !== 1 || rest[0] === '') {
    console.error('넣을 글자 하나가 필요하다. 띄어쓰기가 있으면 따옴표로 묶는다:\n  zwprobe type "D:/a b.zls"')
    return 1
  }
  return runVirtual({ op: 'type', text: rest[0]! }, filter, flags)
}

export async function cmdFrame(rest: string[], filter: WindowFilter, hasFilter: boolean, flags?: Map<string, string>): Promise<number> {
  const action = rest[0] ?? 'status'
  if (action === 'start') {
    const f = await ensureFrame(filter, flags)
    if (f.target === undefined) {
      console.error('대상 창을 찾지 못했다.')
      return 1
    }
    console.log(`프레임  ${f.started ? '띄웠다' : '이미 떠 있다'} — 대상 hwnd=${f.target.hwnd} "${f.target.title}"`)
    return 0
  }
  // 필터를 줬으면 그 창들의 프레임만, 안 줬으면 전부
  const targets = hasFilter ? new Set(listWindows(filter).map((w) => w.hwnd)) : undefined
  const mine = frames().filter((f) => targets === undefined || targets.has(f.target))
  if (action === 'status') {
    if (mine.length === 0) {
      console.log('프레임  떠 있는 것이 없다')
      return 1
    }
    for (const f of mine) console.log(`프레임  pid=${f.frame.pid} 대상 hwnd=${f.target}`)
    return 0
  }
  if (action === 'resume') {
    // 사람이 쓰라고 둔다 — MCP 에는 없다 (AI 가 스스로 멈춤을 풀지 못하게)
    const ts = hasFilter ? listWindows(filter) : frames().map((f) => ({ hwnd: f.target }))
    let n = 0
    for (const t of ts) {
      const h = haltFileOf(t.hwnd)
      if (existsSync(h)) { rmSync(h, { force: true }); n++ }
    }
    console.log(n === 0 ? '멈춤  멈춘 것이 없다' : `멈춤  ${n}개를 풀었다 — 가상 입력을 다시 받는다`)
    return 0
  }
  if (action === 'stop') {
    if (mine.length === 0) {
      console.log('프레임  떠 있는 것이 없다')
      return 1
    }
    mkdirSync(FRAMES_DIR, { recursive: true })
    for (const f of mine) writeFileSync(join(FRAMES_DIR, `${f.target}.stop`), '')
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && frames().some((f) => mine.some((m) => m.frame.hwnd === f.frame.hwnd))) await sleep(100)
    for (const f of frames().filter((f) => mine.some((m) => m.frame.hwnd === f.frame.hwnd))) {
      spawnSync('taskkill', ['/F', '/PID', String(f.frame.pid)], { stdio: 'ignore' })
    }
    for (const f of mine) {
      const stop = join(FRAMES_DIR, `${f.target}.stop`)
      if (existsSync(stop)) rmSync(stop, { force: true })
    }
    console.log(`프레임  ${mine.length}개 닫았다`)
    return 0
  }
  console.error(`frame 뒤에는 start · stop · status · resume 중 하나를 쓴다: '${action}'`)
  return 1
}
