// zwmac — macOS 에서 `zwwin.exe` 자리에 서는 I/O 가장자리. **같은 동사·같은 플래그·같은 JSON** 을 낸다.
//
//   node src/mac/zwmac.ts windows|shot|key|click|uia|record [--process P] [--pid N] [--title T] ...
//
// **왜 밖이 아니라 안인가.** macOS 에서 다른 앱의 창을 찍고 입력을 넣으려면 화면 기록·손쉬운 사용
// 권한(TCC)이 필요하고 사람이 시스템 설정에서 줘야 한다. 대상 앱 프로세스 안의 zwagent 는 그
// 권한 없이 자기 창을 찍고 입력을 넣는다(windows.cpp). 그래서 이 파일은 명령 채널(Unix 소켓)로
// 묻고, 답을 zwwin 모양으로 옮긴다. **판정하지 않는다** (절대 규칙 5) — 옮길 뿐이다.
//
// **보이는 것은 zwagent 를 얹은 앱의 창뿐이다.** 소켓이 없는 프로세스는 "창이 없다" 가 된다.
//
// zwwin.ts 가 macOS 에서 이 파일을 `spawnSync` 로 부른다 — CLI 의 동기 호출 모양을 그대로 두려고
// 프로세스를 하나 더 띄운다(호출당 수십 ms).

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { call } from '../agent/pipe.ts'
import { parseTreeResult } from '../agent/protocol.ts'
import { toQtKey } from '../input/qtKey.ts'
import type { WindowInfo } from '../win/zwwin.ts'
import { WS } from '../win/windowState.ts'
import { findTopLevel, uiaFromTree } from './uiaFromTree.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ENCODER = resolve(HERE, '../../bin/zwmac-encode')

/** zwagent `windows` op 가 싣는 창 하나. */
export type AgentWindow = {
  id: number
  owner: number
  title: string
  class: string
  objectName: string
  enabled: boolean
  blocked: boolean
  modal: boolean
  popup: boolean
  toolTip: boolean
  active: boolean
  minimized: boolean
  x: number
  y: number
  width: number
  height: number
  dpr: number
}

export type AgentWindows = {
  pid: number
  appVersion: string
  appFilePath: string
  windows: AgentWindow[]
}

/**
 * Qt 의 창 사실을 zwwin 의 `WindowInfo` 로. **판정 코드(windowState.ts)가 보는 것만 맞춘다** —
 * 소유 관계, 입력을 받는가, 크기. 모달에 막힌 창은 `enabled=false` + `WS_DISABLED` 로 싣는다:
 * Windows 에서 Qt 모달이 소유 창에 하는 것이 정확히 그것이다(2026-09-09 Qt 픽스처 실측).
 */
export function toWindowInfo(w: AgentWindow, app: Pick<AgentWindows, 'pid' | 'appVersion' | 'appFilePath'>): WindowInfo {
  const interactive = w.enabled && !w.blocked
  let style = WS.VISIBLE
  if (!interactive) style |= WS.DISABLED
  if (w.popup || w.toolTip) style |= WS.POPUP
  if (w.minimized) style |= WS.MINIMIZE
  return {
    hwnd: w.id,
    pid: app.pid,
    title: w.title,
    class: w.class,
    minimized: w.minimized,
    owner: w.owner,
    enabled: interactive,
    style: style >>> 0,
    exStyle: 0,
    fileVersion: app.appVersion,
    exePath: app.appFilePath,
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
  }
}

export type MacFilter = { process?: string; pid?: number; title?: string }

/** zwwin `Filter` 와 같은 규칙 — 프로세스 이름(확장자 무시), pid, 제목 부분 일치(대소문자 무시), 넓은 순. */
export function filterWindows(all: readonly WindowInfo[], f: MacFilter): WindowInfo[] {
  const want = f.process?.replace(/\.(exe|app)$/i, '').toLowerCase()
  return all
    .filter((w) => want === undefined || basename(w.exePath).replace(/\.(exe|app)$/i, '').toLowerCase() === want)
    .filter((w) => f.pid === undefined || w.pid === f.pid)
    .filter((w) => f.title === undefined || w.title.toLowerCase().includes(f.title.toLowerCase()))
    .sort((a, b) => b.width * b.height - a.width * a.height)
}

/** 소켓이 있고 살아 있는 zwagent pid 들. 소켓 이름이 `zwagent-<pid>` 다(protocol.ts `pipePathFor`). */
function agentPids(): number[] {
  const out: number[] = []
  for (const n of readdirSync(tmpdir())) {
    const m = /^zwagent-(\d+)$/.exec(n)
    if (m === null) continue
    const pid = Number(m[1])
    try {
      process.kill(pid, 0)
      out.push(pid)
    } catch {
      // 죽은 프로세스의 소켓 파일 — 비정상 종료가 남긴 것
    }
  }
  return out
}

type Raw = Record<string, unknown>

async function ask(pid: number, req: Raw, timeoutMs = 15000): Promise<Raw> {
  const r = await call(pid, { id: 1, ...req } as never, { timeoutMs })
  if (!r.ok) throw new Error(r.error)
  const body = (r as { body: Raw }).body
  if (body.ok === false) throw new Error(String(body.error ?? '원인 없이 실패했다'))
  return body
}

async function enumerate(f: MacFilter): Promise<Array<{ info: WindowInfo; agent: AgentWindow }>> {
  const pids = f.pid !== undefined ? agentPids().filter((p) => p === f.pid) : agentPids()
  const all: Array<{ info: WindowInfo; agent: AgentWindow }> = []
  for (const pid of pids) {
    let body: Raw
    try {
      body = await ask(pid, { op: 'windows' }, 5000)
    } catch {
      continue // 응답 없는 앱(모달 exec 중이 아니라 죽어가는 것)은 창이 없는 것으로 본다
    }
    const app = body as unknown as AgentWindows
    for (const w of app.windows) all.push({ info: toWindowInfo(w, app), agent: w })
  }
  const kept = new Set(filterWindows(all.map((x) => x.info), f))
  return all.filter((x) => kept.has(x.info)).sort((a, b) => b.info.width * b.info.height - a.info.width * a.info.height)
}

function parse(argv: string[]): { verb: string; a: Map<string, string> } {
  const verb = argv[0] ?? ''
  const a = new Map<string, string>()
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!
    if (!t.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      a.set(t.slice(2), next)
      i++
    } else a.set(t.slice(2), '')
  }
  return { verb, a }
}

function filterOf(a: Map<string, string>): MacFilter {
  return {
    ...(a.has('process') ? { process: a.get('process')! } : {}),
    ...(a.has('pid') ? { pid: Number(a.get('pid')) } : {}),
    ...(a.has('title') ? { title: a.get('title')! } : {}),
  }
}

async function pickOne(a: Map<string, string>) {
  const wins = await enumerate(filterOf(a))
  if (wins.length === 0) {
    throw new Error('조건에 맞는 창을 찾지 못했다. macOS 에서는 zwagent 를 얹어 띄운 앱만 보인다 (bash tools/launch-zweave.sh).')
  }
  return { first: wins[0]!, count: wins.length }
}

async function cmdShot(a: Map<string, string>): Promise<Raw> {
  const png = a.get('png')
  if (png === undefined || png === '') throw new Error('--png <경로> 가 필요하다.')
  const raw = a.get('raw')
  const mode = a.get('mode') ?? 'printwindow'
  const { first, count } = await pickOne(a)
  await ask(first.info.pid, {
    op: 'shotWindow',
    window: first.info.hwnd,
    pngPath: resolve(png),
    ...(raw !== undefined ? { rawPath: resolve(raw) } : {}),
    // screen = 겹친 다이얼로그·메뉴까지(화면에 보이는 그대로), printwindow = 그 창만
    composite: mode === 'screen',
    logical: true,
  }, 60000)
  return {
    ok: true,
    mode,
    png: resolve(png),
    raw: raw === undefined ? null : resolve(raw),
    format: 'bgra8',
    window: first.info,
    candidates: count,
  }
}

async function cmdKey(a: Map<string, string>): Promise<Raw> {
  const vk = Number(a.get('vk'))
  if (!Number.isInteger(vk) || vk <= 0) throw new Error('--vk <가상 키 코드> 가 필요하다.')
  if ((a.get('method') ?? 'send') === 'post') throw new Error('macOS 에는 post 방식이 없다 — 진단용 Windows 전용이다.')
  const stroke = { vk, ctrl: a.has('ctrl'), alt: a.has('alt'), shift: a.has('shift') }
  const qk = toQtKey(stroke)
  const { first } = await pickOne(a)
  const body = await ask(first.info.pid, {
    op: 'keyWindow',
    window: first.info.hwnd,
    key: qk.key,
    text: qk.text,
    modifiers: { ctrl: stroke.ctrl, alt: stroke.alt, shift: stroke.shift },
    holdMs: a.has('hold') ? Number(a.get('hold')) : 0,
  })
  return {
    ok: true,
    method: 'inprocess',
    vk,
    ctrl: stroke.ctrl,
    alt: stroke.alt,
    shift: stroke.shift,
    activated: body.activeAfter === true,
    foregroundAfter: body.activeAfter === true ? first.info.hwnd : 0,
    window: first.info,
  }
}

async function cmdClick(a: Map<string, string>): Promise<Raw> {
  const x = Number(a.get('x'))
  const y = Number(a.get('y'))
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('--x --y 가 필요하다.')
  const { first } = await pickOne(a)
  const slow = a.has('slow')
  if (slow) await new Promise((r) => setTimeout(r, 500))
  const body = await ask(first.info.pid, {
    op: 'clickWindow',
    window: first.info.hwnd,
    x,
    y,
    button: a.get('button') ?? 'left',
    double: a.has('double'),
    holdMs: a.has('hold') ? Number(a.get('hold')) : 0,
  })
  if (slow) await new Promise((r) => setTimeout(r, 500))
  const hit = body.hit as { id: number }
  const root = body.root as { id: number }
  return {
    ok: true,
    button: a.get('button') ?? 'left',
    double: a.has('double'),
    x,
    y,
    screenX: body.screenX,
    screenY: body.screenY,
    // 프로세스 안 입력은 커서·포그라운드와 무관하다 — 첫 클릭이 활성화로 소비되지 않는다
    activated: true,
    moved: true,
    foregroundAfter: first.info.hwnd,
    hwndAtPoint: hit.id,
    rootAtPoint: root.id,
    cursorRestored: !a.has('stay'),
    window: first.info,
  }
}

async function cmdUia(a: Map<string, string>): Promise<Raw> {
  const t0 = Date.now()
  const { first } = await pickOne(a)
  const depth = a.has('depth') ? Number(a.get('depth')) : 24
  const max = a.has('max') ? Number(a.get('max')) : 2000
  const r = await call(first.info.pid, { id: 1, op: 'tree', maxDepth: depth }, { timeoutMs: 60000 })
  if (!r.ok) throw new Error(r.error)
  const tree = parseTreeResult((r as { body: Record<string, unknown> }).body)
  const top = findTopLevel(tree.topLevelWidgets, { ...first.agent })
  if (top === null) throw new Error(`위젯 트리에서 창 "${first.agent.title}"(${first.agent.class}) 를 하나로 찾지 못했다.`)
  const { nodes, truncated } = uiaFromTree(top, { originX: first.info.x, originY: first.info.y, maxDepth: depth, maxNodes: max })
  return { ok: true, elapsedMs: Date.now() - t0, maxDepth: depth, maxNodes: max, truncated, nodes, window: first.info }
}

async function cmdWindows(a: Map<string, string>): Promise<Raw> {
  return { ok: true, windows: (await enumerate(filterOf(a))).map((w) => w.info) }
}

/**
 * 녹화. zwwin record 와 같은 계약 — 분리된 프로세스로 돌고, `--stop` 파일이 생기면 마무리하고,
 * 결과를 `--result` 에 쓴다. 프레임은 zwagent `shotWindow` 로 찍고 `zwmac-encode`(AVFoundation)가
 * H.264 MP4 로 묶는다. **시간은 고정 간격** — 뒤처지면 직전 화면을 복제한다(zwwin 과 같은 이유).
 */
async function cmdRecord(a: Map<string, string>): Promise<Raw> {
  const out = resolve(a.get('out') ?? '')
  const resultPath = resolve(a.get('result') ?? '')
  const stopPath = resolve(a.get('stop') ?? '')
  const fps = Number(a.get('fps') ?? '10')
  const maxSeconds = Number(a.get('max-seconds') ?? '600')
  const mode = a.get('mode') ?? 'screen'
  const cursor = !a.has('no-cursor')
  if (!existsSync(ENCODER)) throw new Error(`인코더가 없다: ${ENCODER} — bash tools/zwmac/build.sh 를 먼저 실행한다.`)

  const { first } = await pickOne(a)
  const pid = first.info.pid
  const frameDir = join(tmpdir(), `zwmac-rec-${process.pid}`)
  mkdirSync(frameDir, { recursive: true })
  const framePath = join(frameDir, 'f.bgra')
  // H.264 는 짝수 크기를 요구한다 — 인코더가 오른쪽·아래 1px 을 자른다
  const width = first.info.width
  const height = first.info.height
  mkdirSync(dirname(out), { recursive: true })
  const enc = spawn(ENCODER, ['--out', out, '--width', String(width), '--height', String(height), '--fps', String(fps)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let encOut = ''
  enc.stdout.on('data', (d) => (encOut += d))
  enc.stderr.on('data', (d) => (encOut += d))

  const frameBytes = width * height * 4
  let last: Buffer | null = null
  let frames = 0
  let duplicated = 0
  let captureFailures = 0
  let stopReason: 'stop' | 'max-seconds' | 'window-gone' = 'stop'
  const t0 = Date.now()
  const interval = 1000 / fps

  const write = (buf: Buffer) =>
    new Promise<void>((res) => (enc.stdin.write(buf) ? res() : enc.stdin.once('drain', () => res())))

  for (;;) {
    if (existsSync(stopPath)) break
    const elapsed = Date.now() - t0
    if (elapsed >= maxSeconds * 1000) {
      stopReason = 'max-seconds'
      break
    }
    // 이 시각까지 있어야 할 프레임 수. 모자라면 직전 화면으로 채운다
    const due = Math.floor(elapsed / interval) + 1
    let buf: Buffer | null = null
    try {
      await ask(pid, { op: 'shotWindow', window: first.info.hwnd, rawPath: framePath, composite: mode === 'screen', logical: true, cursor, fast: true }, 5000)
      const b = readFileSync(framePath)
      if (b.length === frameBytes) buf = b
      else captureFailures++ // 창 크기가 바뀌었다 — 직전 화면으로 둔다
    } catch (e) {
      if (/보이는 창이 없다|열지 못했다/.test(String(e))) {
        stopReason = 'window-gone'
        break
      }
      captureFailures++
    }
    if (buf !== null) last = buf
    if (last === null) {
      await new Promise((r) => setTimeout(r, interval))
      continue
    }
    const target = Math.floor((Date.now() - t0) / interval) + 1
    const n = Math.max(1, Math.min(target, due + 1) - frames)
    for (let i = 0; i < n; i++) {
      await write(last)
      frames++
      if (i > 0 || buf === null) duplicated++
    }
    const wait = frames * interval - (Date.now() - t0)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  enc.stdin.end()
  await new Promise<void>((r) => enc.on('close', () => r()))
  rmSync(frameDir, { recursive: true, force: true })

  const bytes = existsSync(out) ? readFileSync(out).length : 0
  const result: Raw = {
    ok: true,
    out,
    bytes,
    frames,
    captureFailures,
    duplicated,
    seconds: frames / fps,
    fps,
    width: width - (width % 2),
    height: height - (height % 2),
    mode,
    stopReason,
    window: first.info,
    encoder: encOut.trim(),
  }
  writeFileSync(resultPath, JSON.stringify(result))
  return result
}

async function main(): Promise<number> {
  const { verb, a } = parse(process.argv.slice(2))
  try {
    let r: Raw
    switch (verb) {
      case 'windows': r = await cmdWindows(a); break
      case 'shot': r = await cmdShot(a); break
      case 'key': r = await cmdKey(a); break
      case 'click': r = await cmdClick(a); break
      case 'uia': r = await cmdUia(a); break
      case 'record': r = await cmdRecord(a); break
      default: throw new Error(`모르는 동사: "${verb}". windows·shot·key·click·uia·record`)
    }
    process.stdout.write(JSON.stringify(r))
    return 0
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    process.stdout.write(JSON.stringify({ ok: false, error }))
    if (verb === 'record' && a.has('result')) writeFileSync(resolve(a.get('result')!), JSON.stringify({ ok: false, error }))
    return 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
