// zwprobe — Z-Weave 를 외부에서 조작·관찰·판정하는 CLI.
//
//   node src/cli.ts shot [--process z-weave] [--pid N] [--title 조각] [--out 경로]
//   node src/cli.ts windows [--process z-weave]

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

import { TARGET_PROCESS, click, listWindows, sendKey, shot, startRecord, uiaTree } from './win/zwwin.ts'
import { analyze, judgeCapture } from './image/stats.ts'
import { readCapture, writeCaptureMeta } from './image/captureFile.ts'
import { checkBaseline } from './image/captureMeta.ts'
import { diff, judgeSame } from './image/diff.ts'
import type { WindowFilter } from './win/zwwin.ts'
import {
  elapsedSeconds,
  judgeRecording,
  parseRecordResult,
  parseRecordingState,
  readMp4Summary,
  validateRecordOptions,
} from './record/record.ts'
import type { RecordingState } from './record/record.ts'
import { findConflicts, findShortcut } from './input/shortcut.ts'
import { loadShortcuts } from './input/shortcutFile.ts'
import { locateLog, logDir, readEntries } from './log/logFile.ts'
import { summarize, toSeverity } from './log/parse.ts'
import { classifyWindows, judgeActivity, styleNames } from './win/windowState.ts'
import { call } from './agent/pipe.ts'
import {
  callableActions,
  matchActions,
  parseActions,
  parseCandidates,
  parseTreeResult,
} from './agent/protocol.ts'
import type { Request } from './agent/protocol.ts'
import { findPopupItem, parsePopup, popupLines } from './agent/popup.ts'
import { judgeClick } from './input/click.ts'
import { needsWidgetSize, planMouse } from './input/mouseArgs.ts'
import { toQtKey } from './input/qtKey.ts'
import type { ShortcutEntry } from './input/shortcut.ts'
import { activePanel, clickPoint, findNodes, findOne, readDocumentState } from './uia/tree.ts'
import type { NodeQuery } from './uia/tree.ts'
import { BASELINE_DIR, listBaselines, runScenario } from './scenario/run.ts'
import type { Scenario } from './scenario/steps.ts'
import {
  findByLabel,
  findWidgets,
  flattenWidgets,
  judgeAbi,
  judgeTree,
  parseAgentHello,
  widgetCenter,
  widgetLabels,
} from './agent/hello.ts'

function parseArgs(argv: string[]): { verb: string; rest: string[]; flags: Map<string, string> } {
  const verb = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : ''
  const rest: string[] = []
  const flags = new Map<string, string>()
  for (let i = verb === '' ? 0 : 1; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) {
      rest.push(a)
      continue
    }
    const next = argv[i + 1]
    flags.set(a.slice(2), next !== undefined && !next.startsWith('--') ? (i++, next) : '')
  }
  return { verb, rest, flags }
}

function filterFrom(flags: Map<string, string>): WindowFilter {
  const f: WindowFilter = {}
  const p = flags.get('process')
  const pid = flags.get('pid')
  const title = flags.get('title')
  if (p) f.process = p
  if (pid) f.pid = Number(pid)
  if (title) f.title = title
  return f
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

function cmdWindows(flags: Map<string, string>): number {
  const wins = listWindows(filterFrom(flags))
  if (wins.length === 0) {
    console.log('조건에 맞는 창이 없다.')
    return 1
  }
  for (const w of wins) {
    const size = `${w.width}x${w.height}`.padEnd(11)
    const min = w.minimized ? ' [최소화]' : ''
    console.log(`${size} pid=${String(w.pid).padEnd(7)} ${w.class.padEnd(26)} ${w.title}${min}`)
  }
  return 0
}

function cmdShot(flags: Map<string, string>): number {
  const out = resolve(flags.get('out') || `captures/shot-${timestamp()}.png`)
  mkdirSync(dirname(out), { recursive: true })

  const raw = out.replace(/\.png$/i, '') + '.bgra'
  const mode = flags.get('mode') === 'screen' ? 'screen' : 'printwindow'
  // 필터가 없으면 대상 앱으로 좁힌다. 예전에는 "가장 큰 창" 규칙이 그대로 적용돼
  // **바탕화면(두 모니터를 덮는 5360x1440)을 찍었다** — 2026-09-09 실측. 판정까지
  // "정상" 이 나오므로 화면을 열어보기 전까지 틀린 것을 모른다.
  const info = shot({ ...targetFilter(flags), png: out, raw, mode })
  const w = info.window

  console.log(`창    ${w.width}x${w.height} pid=${w.pid} "${w.title}"`)
  console.log(`저장  ${info.png}  (${(statSync(info.png).size / 1024).toFixed(0)} KB, mode=${info.mode})`)
  if (info.candidates > 1) {
    console.log(`주의  조건에 맞는 창이 ${info.candidates} 개다. 가장 큰 창을 찍었다.`)
  }

  // 사이드카를 함께 쓴다. `.bgra` 는 자기 크기를 모르므로 baseline 으로 며칠 뒤에
  // 읽으려면 이것이 있어야 한다. 근거는 src/image/captureMeta.ts 머리말.
  writeCaptureMeta(out, {
    format: 'bgra8',
    width: w.width,
    height: w.height,
    takenAt: new Date().toISOString(),
    mode: info.mode,
    window: {
      title: w.title,
      class: w.class,
      pid: w.pid,
      fileVersion: w.fileVersion,
      width: w.width,
      height: w.height,
    },
  })

  const stats = analyze({
    width: w.width,
    height: w.height,
    data: new Uint8Array(readFileSync(raw)),
  })
  const verdict = judgeCapture(w, stats)

  console.log(
    `픽셀  검정 ${(stats.blackRatio * 100).toFixed(1)}% · ` +
      `평균 휘도 ${stats.meanLuminance.toFixed(1)} · 색상 ${stats.distinctColors}`,
  )

  if (!verdict.usable) {
    console.log(`판정  쓸 수 없다 — ${verdict.reason}`)
    if (w.minimized) {
      console.log('      창을 복원한 뒤 다시 찍는다.')
    } else if (mode === 'printwindow') {
      console.log('      PrintWindow 가 내용을 못 잡았을 수 있다. --mode screen 으로 다시 시도한다.')
    } else {
      console.log('      화면 캡처로도 비어 있다. 창이 다른 창에 가려졌는지 확인한다.')
    }
    return 2
  }

  console.log('판정  정상')
  return 0
}

/**
 * 실행 중인 대상 앱의 버전. 창을 못 찾으면 undefined — 그러면 최신 디렉토리로 떨어진다.
 *
 * 필터가 하나도 없으면 대상 프로세스로 기본값을 넣는다. 예전에는 필터 없이 첫 창의
 * 버전을 읽어서 **엉뚱한 프로세스의 버전** 으로 shortcut.ini 를 골랐다
 * (2026-09-09 실측: 앱은 5.0.34 인데 5.1.0 을 newest 로 골랐다). 버전이 다르면
 * 같은 이름의 기능이 다른 키에 묶여 있을 수 있으므로 조용히 다른 명령이 나간다.
 */
function runningAppVersion(flags: Map<string, string>): string | undefined {
  const f = filterFrom(flags)
  if (f.process === undefined && f.pid === undefined && f.title === undefined) {
    f.process = TARGET_PROCESS
  }
  try {
    // 창이 여럿이면 버전을 읽은 첫 창을 쓴다. 같은 프로세스이므로 값이 같다.
    return listWindows(f).find((w) => w.fileVersion !== '')?.fileVersion
  } catch {
    return undefined
  }
}

function warnIfVersionGuessed(file: { appVersion: string; how: string }): void {
  if (file.how === 'newest') {
    console.log(
      `주의  실행 중인 앱 버전에 맞는 설정 디렉토리를 찾지 못해 최신(${file.appVersion})을 골랐다.\n` +
        '      버전 간에 매핑이 바뀐 단축키는 다른 명령을 실행할 수 있다.',
    )
  }
}

function cmdShortcuts(flags: Map<string, string>): number {
  const file = loadShortcuts(flags.get('app-version') || runningAppVersion(flags))
  const needle = (flags.get('filter') || '').toLowerCase()

  console.log(
    `${file.path}\n` +
      `  앱 버전 ${file.appVersion} (${file.how}) · ini 스키마 Version=${file.version} · 항목 ${file.entries.length}개`,
  )
  warnIfVersionGuessed(file)
  let section = ''
  for (const e of file.entries) {
    if (needle && !e.name.toLowerCase().includes(needle)) continue
    if (e.section !== section) {
      section = e.section
      console.log(`\n[${section}]`)
    }
    console.log(`  ${e.name.padEnd(26)} ${e.spec}`)
  }

  if (file.unparsed.length > 0) {
    console.log(`\n못 읽은 줄 ${file.unparsed.length}개:`)
    for (const u of file.unparsed) console.log(`  ${u.line}행 ${u.text} — ${u.reason}`)
  }

  const conflicts = findConflicts(file)
  if (conflicts.length > 0) {
    console.log('\n같은 키에 묶인 기능:')
    for (const c of conflicts) console.log(`  ${c.spec} → ${c.names.join(', ')}`)
  }
  return 0
}

function cmdKey(rest: string[], flags: Map<string, string>): number | Promise<number> {
  const name = rest[0]
  if (name === undefined) {
    console.error('기능 이름이 필요하다. 목록은 `zwprobe shortcuts` 로 본다.')
    return 1
  }

  const file = loadShortcuts(flags.get('app-version') || runningAppVersion(flags))
  warnIfVersionGuessed(file)

  const entry = findShortcut(file, name)
  if (entry === undefined) {
    console.error(`"${name}" 을 ${file.path} 에서 찾지 못했다. \`zwprobe shortcuts --filter ${name}\` 로 확인한다.`)
    return 1
  }

  // `--object` 면 프로세스 안에서 그 위젯에 보낸다 — 포그라운드를 안 뺏으니 남의 창으로 새지 않는다.
  if (flags.has('object')) return keyInProcess(entry, flags)

  // 필터가 없으면 대상 앱으로 좁힌다. **안 좁히면 화면의 첫 창에 키가 간다** —
  // 2026-09-15 에 ESC 가 z-weave 가 아니라 "Program Manager"(바탕화면)로 갔다.
  // 틀린 창에 간 키는 거기서 다른 명령이다.
  const method = flags.get('method') === 'post' ? 'post' : 'send'
  const r = sendKey({ ...targetFilter(flags), stroke: entry.stroke, method })

  console.log(`전송  ${entry.name} = ${entry.spec}  (vk=${r.vk}${r.ctrl ? ' +ctrl' : ''}${r.alt ? ' +alt' : ''}${r.shift ? ' +shift' : ''})`)
  console.log(`대상  pid=${r.window.pid} "${r.window.title}"`)

  if (method === 'post') {
    console.log('주의  post 는 수식키를 싣지 못한다. 수식키가 있는 단축키는 다른 명령이 실행된다.')
    return 0
  }

  if (!r.activated) {
    console.log('실패  창을 포그라운드로 올리지 못했다. 키가 다른 창으로 갔을 수 있다.')
    return 2
  }
  console.log('활성  포그라운드 확보됨')
  return 0
}

/**
 * 앱의 창 구조와 "지금 조작할 수 있는가" 를 보고한다.
 *
 * M3 러너가 sleep 추측 대신 물어볼 질문이 이것이다. 필터를 주지 않으면 대상 앱으로
 * 좁힌다 — 화면의 모든 창을 섞으면 "메인 창" 이 무의미해진다.
 *
 * 종료 코드로도 답한다: 0=idle, 3=busy, 1=못 찾음. 셸에서 바로 분기할 수 있다.
 */
function cmdState(flags: Map<string, string>): number {
  const f = filterFrom(flags)
  if (f.process === undefined && f.pid === undefined && f.title === undefined) {
    f.process = TARGET_PROCESS
  }

  const activity = judgeActivity(listWindows(f))
  const { main, extras } = activity.classified

  if (main === null) {
    const shown = [
      f.process !== undefined ? `process=${f.process}` : '',
      f.pid !== undefined ? `pid=${f.pid}` : '',
      f.title !== undefined ? `title=${f.title}` : '',
    ]
      .filter((s) => s !== '')
      .join(' ')
    console.log(`대상  ${shown} — 보이는 창을 찾지 못했다`)
  } else {
    console.log(`메인  ${main.width}x${main.height} hwnd=${main.hwnd} pid=${main.pid} "${main.title}"`)
    console.log(`      ${styleNames(main.style, main.exStyle).join(' ')}`)
  }

  for (const e of extras) {
    const w = e.window
    const flag = e.interactive ? '' : ' [입력 불가]'
    console.log(`추가  ${w.width}x${w.height} hwnd=${w.hwnd} owner=${w.owner} ${e.relation}${flag} "${w.title}"`)
    console.log(`      ${styleNames(w.style, w.exStyle).join(' ')}`)
  }

  console.log(`판정  ${activity.state} — ${activity.reason}`)
  return activity.state === 'idle' ? 0 : activity.state === 'busy' ? 3 : 1
}

/**
 * 창의 한 점을 누른다. 좌표는 **`shot` 이 찍은 PNG 의 좌표와 같다** — 화면에서 본
 * 자리를 그대로 넘긴다.
 *
 * 되돌릴 수 없는 조작이므로 좌표를 한 번 더 찍어서 보여준다. 창 밖이면 zwwin.exe 가
 * 거부한다.
 */
function cmdClick(rest: string[], flags: Map<string, string>): number {
  const f = filterFrom(flags)
  if (f.process === undefined && f.pid === undefined && f.title === undefined) {
    f.process = TARGET_PROCESS
  }

  // 좌표를 직접 주는 길과 UIA 로 요소를 찾아 그 한가운데를 누르는 길이 있다.
  // **이름으로 누르는 쪽이 눈대중 좌표보다 낫다** — 창 크기나 레이아웃이 바뀌어도
  // 따라간다. 다만 이름이 없는 요소(툴바 버튼)는 여전히 좌표뿐이다.
  const q = queryFrom(flags)
  let x: number
  let y: number

  if (q !== undefined) {
    if (rest.length > 0 || flags.has('x') || flags.has('y')) {
      console.error('좌표와 요소 질의를 함께 줄 수 없다. 어느 쪽을 눌러야 하는지 정할 수 없다.')
      return 1
    }
    // 누를 수 있는 것만 본다 — 크기 0 이나 화면 밖 요소는 좌표가 있어도 못 누른다.
    const dump = uiaTree({ ...f, ...(flags.has('max') ? { max: Number(flags.get('max')) } : {}) })
    const hit = findOne(dump, { ...q, clickableOnly: true })
    if (!hit.found) {
      console.error(`요소를 특정하지 못했다 — ${hit.reason}`)
      return 1
    }
    const p = clickPoint(hit.node)
    x = p.x
    y = p.y
    console.log(
      `요소  [${hit.node.controlType}] "${hit.node.name}"` +
        `${hit.node.automationId ? ` id="${hit.node.automationId}"` : ''} cls=${hit.node.class}` +
        ` (${hit.node.wx},${hit.node.wy}) ${hit.node.width}x${hit.node.height}`,
    )
  } else {
    // 위치 인자 "x y" 도 받는다 — 좌표를 두 번 타이핑하는 것이 성가시기 때문이다.
    const xs = flags.get('x') ?? rest[0]
    const ys = flags.get('y') ?? rest[1]
    if (xs === undefined || ys === undefined) {
      console.error(
        '좌표나 요소 질의가 필요하다:\n' +
          '  zwprobe click <x> <y>            창 왼쪽 위 기준. shot 의 PNG 좌표와 같다\n' +
          '  zwprobe click --name "Simulation"  UIA 로 찾아 한가운데를 누른다',
      )
      return 1
    }
    x = Number(xs)
    y = Number(ys)
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      console.error(`좌표는 정수여야 한다: "${xs}" "${ys}"`)
      return 1
    }
  }

  const buttonArg = flags.get('button') || 'left'
  if (buttonArg !== 'left' && buttonArg !== 'right' && buttonArg !== 'middle') {
    console.error(`--button 은 left, right, middle 중 하나여야 한다: ${buttonArg}`)
    return 1
  }

  const r = click({
    ...f,
    x,
    y,
    button: buttonArg,
    double: flags.has('double'),
    slow: flags.has('slow'),
    stay: flags.has('stay'),
    ...(flags.has('hold') ? { holdMs: Number(flags.get('hold')) } : {}),
  })

  console.log(`클릭  ${r.button}${r.double ? ' ×2' : ''} 창 기준 (${r.x},${r.y}) → 화면 (${r.screenX},${r.screenY})`)
  console.log(`대상  ${r.window.width}x${r.window.height} hwnd=${r.window.hwnd} pid=${r.window.pid} "${r.window.title}"`)

  const v = judgeClick(r)
  console.log(`판정  ${v.onTarget ? '정상' : '의심'} — ${v.reason}`)
  if (!r.cursorRestored && !flags.has('stay')) {
    console.log('주의  커서를 원래 자리로 돌려놓지 못했다.')
  }
  return v.onTarget ? 0 : 2
}

/** 필터를 주지 않았으면 대상 앱으로 좁힌다. 화면의 모든 창을 섞으면 의미가 없다. */
function targetFilter(flags: Map<string, string>): WindowFilter {
  const f = filterFrom(flags)
  if (f.process === undefined && f.pid === undefined && f.title === undefined) {
    f.process = TARGET_PROCESS
  }
  return f
}

/** CLI 플래그에서 노드 질의를 만든다. 아무것도 없으면 undefined. */
function queryFrom(flags: Map<string, string>): NodeQuery | undefined {
  const q: NodeQuery = {}
  const name = flags.get('name')
  const id = flags.get('id')
  const cls = flags.get('class')
  const type = flags.get('type')
  if (name) q.name = name
  if (id) q.automationId = id
  if (cls) q.class = cls
  if (type) q.controlType = type
  if (flags.has('clickable')) q.clickableOnly = true
  return Object.keys(q).length > 0 ? q : undefined
}

/**
 * UIA 트리를 덤프하거나 질의로 걸러 보여준다.
 *
 * 좌표는 **창 기준**으로 찍는다 — `click` 이 받는 것과 같은 좌표계이므로 그대로
 * 넘길 수 있다. UIA 의 화면 좌표는 원점이 캡처 사각형과 달라(실측 8px) 직접 쓰면 어긋난다.
 */
function cmdUia(flags: Map<string, string>): number {
  const dump = uiaTree({
    ...targetFilter(flags),
    ...(flags.has('depth') ? { depth: Number(flags.get('depth')) } : {}),
    ...(flags.has('max') ? { max: Number(flags.get('max')) } : {}),
  })

  const q = queryFrom(flags)
  const shown = q === undefined ? dump.nodes : findNodes(dump.nodes, q)

  console.log(
    `창    ${dump.window.width}x${dump.window.height} hwnd=${dump.window.hwnd} "${dump.window.title}"`,
  )
  console.log(
    `트리  노드 ${dump.nodes.length}개 · ${dump.elapsedMs}ms · depth<=${dump.maxDepth}` +
      (q === undefined ? '' : ` · 질의에 맞는 것 ${shown.length}개`),
  )
  if (dump.truncated) {
    console.log(`주의  노드 ${dump.maxNodes}개에서 잘렸다. 없는 것을 없다고 단정할 수 없다 — --max 를 올린다.`)
  }

  const doc = readDocumentState(dump)
  if (doc.fileName !== null) {
    console.log(`문서  ${doc.fileName}${doc.dirty === true ? '  [저장 안 됨]' : ''}`)
  }

  console.log('')
  for (const n of shown) {
    const indent = q === undefined ? '  '.repeat(n.depth) : ''
    const rect = n.hasRect ? `(${n.wx},${n.wy}) ${n.width}x${n.height}` : '사각형 없음'
    const marks = `${n.enabled ? '' : ' [비활성]'}${n.offscreen ? ' [화면 밖]' : ''}`
    console.log(
      `${indent}[${n.controlType}] "${n.name}"` +
        `${n.automationId ? ` id="${n.automationId}"` : ''}` +
        ` cls=${n.class} ${rect}${marks}`,
    )
  }

  if (q !== undefined && shown.length === 0) {
    console.log('질의에 맞는 요소가 없다.')
    return 1
  }
  return 0
}

/**
 * 열린 파일명과 dirty 플래그를 읽는다.
 *
 * OS 창 제목에는 없는 정보다 — Windows 빌드는 커스텀 헤더 위젯에만 넣는다.
 * 종료 코드: 0=읽었고 저장됨, 3=읽었고 저장 안 됨, 1=못 읽음.
 */
function cmdDoc(flags: Map<string, string>): number {
  const dump = uiaTree({ ...targetFilter(flags), depth: 3 })
  const doc = readDocumentState(dump)

  if (doc.fileName === null) {
    console.log(`문서  못 읽었다 — ${doc.reason}`)
    return 1
  }
  console.log(`문서  ${doc.fileName}`)
  console.log(`저장  ${doc.dirty === true ? '안 됨 (변경 있음)' : '됨'}`)
  console.log(`근거  ${doc.reason}`)
  return doc.dirty === true ? 3 : 0
}

/**
 * 시나리오 파일을 실행한다. 파일은 TS 모듈이고 `Scenario` 를 export 한다 —
 * `export default` 또는 `export const scenario`.
 *
 * TS 로 둔 이유: 편집기가 단계 타입을 검사해주고, 사용자가 직접 고치는 부분이
 * TS 라는 것이 이 프로젝트의 스택 결정이다(CLAUDE.md).
 *
 * 종료 코드: 0=전부 통과, 2=실패한 단계 있음, 1=시나리오를 못 읽거나 검증 거부.
 */
async function cmdRun(rest: string[], flags: Map<string, string>): Promise<number> {
  const file = rest[0]
  if (file === undefined) {
    console.error('시나리오 파일이 필요하다: zwprobe run scenarios/foo.ts')
    return 1
  }

  const path = resolve(file)
  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>
  } catch (err) {
    console.error(`시나리오를 읽지 못했다: ${path}\n  ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const sc = (mod.default ?? mod.scenario) as Scenario | undefined
  if (sc === undefined || typeof sc !== 'object' || !Array.isArray((sc as Scenario).steps)) {
    console.error(
      `${path} 가 시나리오를 export 하지 않았다.\n` +
        '  export default { name, what, steps } 또는 export const scenario = {...} 여야 한다.',
    )
    return 1
  }

  console.log('주의  시나리오가 도는 동안 포그라운드를 점유한다. 다른 창을 만지면 입력이 그쪽으로 간다.')
  console.log('')

  const r = await runScenario(sc, {
    filter: filterFrom(flags),
    ...(flags.has('out') ? { outDir: flags.get('out')! } : {}),
    ...(flags.has('baselines') ? { baselineDir: flags.get('baselines')! } : {}),
    ...(flags.has('keep-going') ? { keepGoing: true } : {}),
    onProgress: (line) => console.log(line),
  })

  if (r.rejected !== null) {
    console.error(`\n시작하지 않았다 — 시나리오에 문제가 ${r.rejected.length}개 있다:`)
    for (const line of r.rejected) console.error(`  ${line}`)
    console.error('\n앱을 조작하기 전에 거부했다. 앱 상태는 그대로다.')
    return 1
  }

  console.log('')
  for (const line of r.summary.lines) console.log(line)
  console.log(`\n산출물  ${r.outDir}`)
  return r.summary.failed > 0 ? 2 : 0
}

/**
 * baseline 을 뜬다. 지금 화면이 "정상" 이라는 것을 사람이 확인한 상태에서 부른다.
 *
 * **덮어쓰기는 명시해야 한다.** baseline 을 무심코 덮으면 회귀가 정상으로 굳는다 —
 * 이 도구에서 가장 조용히 나쁜 실패다.
 */
function cmdBaseline(rest: string[], flags: Map<string, string>): number {
  const dir = flags.get('dir') || BASELINE_DIR
  const name = flags.get('save') ?? rest[0]

  if (name === undefined) {
    const names = listBaselines(dir)
    console.log(`${resolve(dir)}`)
    if (names.length === 0) {
      console.log('  baseline 이 없다. `zwprobe baseline <이름>` 으로 지금 화면을 뜬다.')
      return 0
    }
    for (const n of names) {
      try {
        const c = readCapture(join(dir, n))
        console.log(
          `  ${n.padEnd(24)} ${c.meta.width}x${c.meta.height}  앱 ${c.meta.window.fileVersion || '?'}  ${c.meta.takenAt}`,
        )
      } catch (err) {
        console.log(`  ${n.padEnd(24)} 읽을 수 없다 — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return 0
  }

  if (!/^[A-Za-z0-9._가-힣-]+$/.test(name)) {
    console.error(`baseline 이름에 파일 이름으로 쓸 수 없는 문자가 있다: "${name}"`)
    return 1
  }

  const base = join(resolve(dir), name)
  if (existsSync(`${base}.json`) && !flags.has('force')) {
    console.error(
      `baseline "${name}" 이 이미 있다. 덮어쓰려면 --force 를 준다.\n` +
        '  무심코 덮으면 회귀가 정상으로 굳는다 — 지금 화면이 정말 정상인지 먼저 본다.',
    )
    return 1
  }

  mkdirSync(resolve(dir), { recursive: true })
  const info = shot({ ...targetFilter(flags), png: `${base}.png`, raw: `${base}.bgra` })
  const w = info.window
  writeCaptureMeta(base, {
    format: 'bgra8',
    width: w.width,
    height: w.height,
    takenAt: new Date().toISOString(),
    mode: info.mode,
    window: {
      title: w.title,
      class: w.class,
      pid: w.pid,
      fileVersion: w.fileVersion,
      width: w.width,
      height: w.height,
    },
  })

  console.log(`baseline  ${name} ← ${w.width}x${w.height} 앱 ${w.fileVersion || '?'}`)
  console.log(`저장      ${base}.png / .bgra / .json`)
  console.log('확인      PNG 를 직접 보고 이 화면이 정말 정상인지 판단한다.')
  return 0
}

/**
 * 두 캡처를 비교한다. baseline 실패를 손으로 파볼 때 쓴다.
 *
 * 종료 코드: 0=같다, 2=다르다, 1=비교할 수 없다.
 */
function cmdDiff(rest: string[], flags: Map<string, string>): number {
  const [a, b] = rest
  if (a === undefined || b === undefined) {
    console.error(
      '두 캡처가 필요하다: zwprobe diff <a> <b>\n' +
        '  이름은 확장자 없이 준다 (.png/.bgra/.json 셋이 함께 다닌다).\n' +
        '  baseline 은 `zwprobe diff baselines/빈씬 runs/.../03-actual` 처럼 경로로 준다.',
    )
    return 1
  }

  let left, right
  try {
    left = readCapture(a)
    right = readCapture(b)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }

  const compat = checkBaseline(left.meta, right.meta)
  for (const w of compat.warnings) console.log(`주의  ${w}`)

  const tolerance = flags.has('tolerance') ? Number(flags.get('tolerance')) : undefined
  const d = diff(left.img, right.img, tolerance !== undefined ? { tolerance } : {})
  const max = flags.has('max-changed') ? Number(flags.get('max-changed')) : 0
  const v = judgeSame(d, max)

  console.log(`왼쪽  ${left.meta.width}x${left.meta.height}  앱 ${left.meta.window.fileVersion || '?'}  ${left.meta.takenAt}`)
  console.log(`오른쪽 ${right.meta.width}x${right.meta.height}  앱 ${right.meta.window.fileVersion || '?'}  ${right.meta.takenAt}`)
  console.log(`판정  ${v.same ? '같다' : '다르다'} — ${v.reason}`)

  if (!d.comparable) return 1
  return v.same ? 0 : 2
}

/** hello 파일에서 대상 앱 pid. 못 읽으면 이유를 찍고 null */
function helloPid(flags: Map<string, string>): number | null {
  const path = flags.get('hello') || join(tmpdir(), 'zwagent-hello.json')
  try {
    const parsed = parseAgentHello(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.ok) return parsed.hello.pid
    console.error(`hello 파일이 쓸 수 없다: ${path}` + String.fromCharCode(10) + `  ${parsed.reason}`)
  } catch (err) {
    console.error(`hello 파일을 읽지 못했다: ${path}` + String.fromCharCode(10) + `  ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

/** 단축키 하나를 위젯에 QKeyEvent 로 (zwagent `key`). 키 값은 qtKey.ts 가 정한다 */
async function keyInProcess(entry: ShortcutEntry, flags: Map<string, string>): Promise<number> {
  const pid = helloPid(flags)
  if (pid === null) return 1
  let qk: { key: number; text: string }
  try {
    qk = toQtKey(entry.stroke)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  const st = entry.stroke
  const modifiers = { ...(st.shift ? { shift: true } : {}), ...(st.ctrl ? { ctrl: true } : {}), ...(st.alt ? { alt: true } : {}) }
  const objectName = flags.get('object') ?? ''
  const res = await call(pid, { id: 1, op: 'key', objectName, key: qk.key, text: qk.text, modifiers })
  if (!res.ok) {
    console.error(`보내지 않았다: ${res.error}`)
    return 1
  }
  console.log(`전송  ${entry.name} = ${entry.spec}  (Qt 키 0x${qk.key.toString(16)} → ${objectName}, 프로세스 안)`)
  console.log(`받음  ${res.body.class} · 누름 ${res.body.pressAccepted === true ? '받아들임' : '무시됨(위젯이 accept 안 함)'}`)
  return 0
}

/**
 * 위젯 하나에 마우스 이벤트를 넣는다 — 클릭·끌기. **대상 앱을 바꾼다.**
 *
 * 인자 → 이벤트 목록은 순수 함수(`planMouse`)가, 이벤트 하나하나의 검사와 보내기는 플러그인이
 * 한다. 여기는 둘을 잇고, 월드 좌표면 그 사이에 위젯 크기를 받아 온다.
 */
async function cmdMouse(flags: Map<string, string>): Promise<number> {
  const path = flags.get('hello') || join(tmpdir(), 'zwagent-hello.json')
  let pid: number
  try {
    const parsed = parseAgentHello(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.ok) {
      console.error(`hello 파일이 쓸 수 없다: ${path}\n  ${parsed.reason}`)
      return 1
    }
    pid = parsed.hello.pid
  } catch (err) {
    console.error(`hello 파일을 읽지 못했다: ${path}\n  ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  let size: { width: number; height: number } | undefined
  if (needsWidgetSize(flags)) {
    // **지금의** 크기 — 사람이 창이나 패널 크기를 바꿨으면 hello 스냅샷은 틀리다
    const t = await call(pid, { id: 1, op: 'tree' })
    if (!t.ok) {
      console.error(`위젯 크기를 받지 못했다: ${t.error}`)
      return 1
    }
    const hits = findWidgets(parseTreeResult(t.body).topLevelWidgets, flags.get('object') ?? '')
    if (hits.length !== 1) {
      console.error(`objectName "${flags.get('object') ?? ''}" 인 위젯이 ${hits.length}개다 — 하나여야 크기를 쓴다`)
      return 1
    }
    size = { width: hits[0]!.width, height: hits[0]!.height }
  }

  const plan = planMouse(flags, size)
  if (!plan.ok) {
    console.error(plan.error)
    return 1
  }
  if (plan.camera !== undefined) {
    const c = plan.camera
    console.log(
      `카메라  리셋 가정 — 중심 (${c.cx}, ${c.cy}) cm · 필름 높이 ${c.filmHeight} cm · 위젯 ${c.width}x${c.height} · ${(c.height / c.filmHeight).toFixed(4)} px/cm`,
    )
  }
  const first = plan.events[0]!
  const last = plan.events[plan.events.length - 1]!
  console.log(`보냄  ${plan.events.length}개 — ${first.type} (${first.x.toFixed(1)},${first.y.toFixed(1)}) … ${last.type} (${last.x.toFixed(1)},${last.y.toFixed(1)})`)

  const res = await call(pid, { id: 2, op: 'mouse', objectName: plan.objectName, events: plan.events })
  if (!res.ok) {
    console.error(`보내지 않았다: ${res.error}`)
    return 1
  }
  const b = res.body
  console.log(`받음  ${b.objectName} (${b.class}) ${b.width}x${b.height} · 화면 원점 (${b.screenX},${b.screenY}) · 넣은 이벤트 ${b.delivered}개`)
  console.log('주의  무슨 일이 일어났는지는 관찰해서 확인한다 — zwprobe agent --live · zwprobe shot · History')
  return 0
}

/**
 * `zwagent.dll` 이 남긴 hello 파일을 읽어 보고한다.
 *
 * **플러그인이 프로세스 안에 들어갔는지 확인하는 유일한 방법이다.** stdout 은 대상
 * 앱이 이미 쓰고 있고 콘솔 없는 빌드에서는 사라지므로 파일로 받는다.
 *
 * 종료 코드: 0=로드됐고 UI 까지 봤다, 3=로드됐지만 UI 를 못 봤다, 1=못 읽었다.
 * 3을 따로 두는 이유: 트리가 비어 있는 것이 "위젯이 없다" 가 아니라 "아직 안
 * 만들어졌다" 일 수 있고, 그 둘은 원인이 다르다.
 */
async function cmdAgent(flags: Map<string, string>): Promise<number> {
  const path = flags.get('hello') || join(tmpdir(), 'zwagent-hello.json')

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    console.error(
      `hello 파일을 읽지 못했다: ${path}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n` +
        '  플러그인이 로드되지 않았거나 아직 쓰지 않았다. 확인할 것:\n' +
        '    · 앱을 `-style zwagent` 로 띄웠는가\n' +
        '    · QT_PLUGIN_PATH 에 이 리포의 bin/plugins 가 있는가\n' +
        '      (또는 앱 배포 폴더의 styles/ 에 zwagent.dll 을 뒀는가)\n' +
        '    · 디버그 구성으로 빌드했는가 — 아니면 Qt 가 조용히 건너뛴다\n' +
        '      QT_DEBUG_PLUGINS=1 로 띄우면 이유가 stderr 로 나온다',
    )
    return 1
  }

  const parsed = parseAgentHello(raw)
  if (!parsed.ok) {
    console.error(`hello 파일이 쓸 수 없다: ${path}\n  ${parsed.reason}`)
    return 1
  }
  const h = parsed.hello

  console.log(`파일  ${path}`)
  console.log(`로드  styleKey="${h.styleKey}" pid=${h.pid} · ${h.writtenAt}`)
  console.log(`대상  ${h.appFilePath || '(모름)'}`)

  const abi = judgeAbi(h)
  console.log(`ABI   ${abi.match ? '일치' : '어긋남'} — ${abi.reason}`)

  // **hello 는 스냅샷이다. 그 프로세스가 아직 살아 있는지는 별개다.**
  //
  // 기본 hello 경로(`%TEMP%`)에는 앞선 실행이나 픽스처가 남긴 파일이 있을 수 있고,
  // 그걸 읽으면 "채널 열림" 이라고 보고한다 — **기록 시점에는 사실이었기 때문이다.**
  // 2026-09-10 에 실제로 죽은 픽스처의 hello 를 읽고 열렸다고 보고했다. 그 상태로
  // `--live` 를 부르면 "파이프를 열지 못했다" 만 나오고 원인이 hello 라는 것을 모른다.
  const alive = listWindows({ pid: h.pid }).length > 0
  if (h.pipeName !== '') {
    const how = h.pipeListening ? '열림' : `못 열었다 — ${h.pipeError || '(이유 없음)'}`
    console.log(`채널  ${h.pipeName} · ${how} (기록 시점)`)
  } else {
    console.log('채널  없다 — 명령 채널이 없는 옛 플러그인이다. 다시 빌드한다.')
  }
  if (!alive) {
    console.log(
      `주의  pid=${h.pid} 의 창이 지금 없다. **이 hello 는 끝난 프로세스의 것이다.**\n` +
        `      위 "채널" 은 기록 당시의 상태이고 지금 연결되지는 않는다.\n` +
        `      --hello 로 지금 앱의 파일을 가리킨다 (기본값은 %TEMP% 라 픽스처 것이 섞인다).`,
    )
  }

  // `--grab` 은 위젯 하나만 찍는다. **`shot` 과 달리 가려져 있어도 찍힌다** —
  // 위젯이 자기를 직접 그리기 때문이다. 플러그인이 파일을 쓰고 우리는 사이드카를
  // 붙여 `diff`·`baseline` 이 그대로 받게 한다.
  const grab = flags.get('grab')
  if (grab !== undefined && grab !== '') {
    const out = resolve(flags.get('out') || `captures/grab-${grab}-${timestamp()}.png`)
    const rawPath = out.replace(/\.png$/i, '') + '.bgra'
    const res = await call(h.pid, { id: 1, op: 'grab', objectName: grab, pngPath: out, rawPath })
    if (!res.ok) {
      console.error(`\n찍지 못했다: ${res.error}`)
      return 1
    }
    const b = res.body
    const width = Number(b.width)
    const height = Number(b.height)
    // 대상 창은 사이드카에 남길 근거로만 쓴다. 없으면 빈 값으로 둔다 — **모르는 것을
    // 지어내지 않는다.** baseline 비교 때 "그때 그 창이었나" 를 따질 때 쓰인다.
    const win = classifyWindows(listWindows({ pid: h.pid })).main
    writeCaptureMeta(out, {
      format: 'bgra8',
      width,
      height,
      takenAt: new Date().toISOString(),
      // `shot` 의 printwindow·screen 과 구분되는 세 번째 방식이다. 창이 아니라 위젯이다.
      mode: 'grab',
      window: {
        title: win?.title ?? '',
        class: String(b.class ?? ''),
        pid: h.pid,
        fileVersion: win?.fileVersion ?? '',
        width,
        height,
      },
    })
    console.log(`\n찍었다  ${grab} (${b.class}) ${width}x${height}${b.visible === true ? '' : ' [숨김]'}`)
    console.log(`저장  ${out}`)
    console.log(`      ${rawPath}`)
    return 0
  }

  // `--popup` 은 지금 열린 팝업 메뉴(2D 뷰 문맥 메뉴)의 항목. `--json` 이면 응답 그대로.
  // `--popup-trigger "A > B"` 는 그 메뉴에서 항목을 고른다 — **대상 앱을 바꾼다**. 고르기 전에 TS 가 항목을 확인한다
  if (flags.has('popup') || flags.has('popup-trigger')) {
    const res = await call(h.pid, { id: 1, op: 'popup' })
    if (!res.ok) {
      console.error(`\n팝업 메뉴를 읽지 못했다: ${res.error}`)
      return 1
    }
    const p = parsePopup(res.body)
    const want = flags.get('popup-trigger')
    if (want === undefined) {
      if (flags.has('json')) console.log(JSON.stringify(p))
      else if (!p.open) console.log('\n열린 팝업 메뉴가 없다')
      else console.log(`\n열린 팝업 메뉴:\n${popupLines(p.items).map((l) => `  ${l}`).join('\n')}`)
      return 0
    }
    if (!p.open) {
      console.error('\n열린 팝업 메뉴가 없다')
      return 1
    }
    const f = findPopupItem(p.items, want)
    if (!f.ok) {
      console.error(`\n고르지 않았다: ${f.error}`)
      return 1
    }
    const t = await call(h.pid, { id: 2, op: 'popupTrigger', path: f.path })
    if (!t.ok) {
      console.error(`\n고르지 않았다: ${t.error}`)
      return 1
    }
    console.log(`\n골랐다  "${f.path.join(' > ')}" (메뉴를 닫고 큐에서 실행 — 결과는 관찰로 확인)`)
    return 0
  }

  // `--actions` 는 부를 수 있는 명령 목록. 파이프가 있어야 한다.
  if (flags.has('actions')) {
    const res = await call(h.pid, { id: 1, op: 'actions' })
    if (!res.ok) {
      console.error(`\n액션 목록을 받지 못했다:\n  ${res.error}`)
      return 1
    }
    const all = parseActions(res.body)
    const shown = matchActions(callableActions(all), flags.get('actions') || '')
    const needle = flags.get('actions') || ''
    console.log(
      `\n부를 수 있는 명령 ${callableActions(all).length}개` +
        `${needle ? ` 중 "${needle}" 에 맞는 ${shown.length}개` : ''} (전체 항목 ${all.length}개):`,
    )
    for (const a of shown.slice(0, Number(flags.get('max') || '60'))) {
      const marks = `${a.enabled ? '' : ' [비활성]'}${a.checkable ? (a.checked ? ' [켬]' : ' [끔]') : ''}`
      const sc = a.shortcut !== undefined ? `  ${a.shortcut}` : ''
      console.log(`  ${(a.path || '(툴바)').padEnd(28)} ${a.text}${sc}${marks}`)
    }
    console.log('\n부를 때: zwprobe agent --trigger "<이름>" [--path "<경로>"]')
    return 0
  }

  // `--trigger` 는 **대상 앱을 바꾼다.** 여기가 zwprobe 에서 프로세스 안으로 명령을
  // 보내는 유일한 지점이다.
  const trigger = flags.get('trigger')
  if (trigger !== undefined && trigger !== '') {
    const req: Request = flags.has('path')
      ? { id: 1, op: 'trigger', text: trigger, path: flags.get('path') || '' }
      : { id: 1, op: 'trigger', text: trigger }
    const res = await call(h.pid, req)
    if (!res.ok) {
      console.error(`\n부르지 못했다: ${res.error}`)
      // 이름이 겹쳐서 거부됐으면 후보를 보여준다. **무엇을 골라야 하는지가 답이다.**
      const cands = res.body ? parseCandidates(res.body) : []
      if (cands.length > 0) {
        console.error('\n후보:')
        for (const c of cands) {
          console.error(`  --path "${c.path}"   ${c.text}${c.enabled ? '' : ' [비활성]'}`)
        }
      }
      return 1
    }
    const t = parseActions({ actions: [res.body.triggered] })[0]
    console.log(`\n불렀다  "${t?.text ?? trigger}"${t?.path ? ` (경로 "${t.path}")` : ''}`)
    console.log(
      '주의  큐에 넣고 바로 답한 것이다 — 모달 다이얼로그가 뜨면 이벤트 루프가 멈춰\n' +
        '      응답이 못 나오기 때문이다. **무슨 일이 일어났는지는 관찰해서 확인한다:**\n' +
        '      zwprobe state · zwprobe shot · zwprobe agent --live',
    )
    return 0
  }

  // `--live` 는 hello 스냅샷 대신 **지금**의 트리를 파이프로 받는다. hello 는 UI 가
  // 정착한 순간의 한 장이라 그 뒤에 사람이 탭을 바꾸면 낡는다.
  let tops = h.topLevelWidgets
  let liveTotal = h.widgetTotal
  if (flags.has('live')) {
    const res = await call(h.pid, { id: 1, op: 'tree' })
    if (!res.ok) {
      console.error(`\n파이프로 트리를 받지 못했다:\n  ${res.error}`)
      return 1
    }
    const live = parseTreeResult(res.body)
    tops = live.topLevelWidgets
    liveTotal = live.widgetTotal
    console.log(`실시간 파이프로 지금의 트리를 받았다 (위젯 ${liveTotal}개).`)
  }

  const flat = flattenWidgets(tops)
  const total = liveTotal >= 0 ? liveTotal : flat.length
  console.log(
    `위젯  최상위 ${h.topLevelCount}개 · 전체 ${total}개 · 트리에 실린 것 ${flat.length}개`,
  )
  const secs = h.elapsedMs >= 0 ? ` · ${(h.elapsedMs / 1000).toFixed(1)}초 걸림` : ''
  const rewrote = h.writeCount > 1 ? ` · ${h.writeCount}번째 스냅샷(앞의 것을 덮었다)` : ''
  console.log(`시점  시도 ${h.attempts}회${secs}${rewrote}`)

  const tree = judgeTree(h)
  console.log(`트리  ${tree.trustworthy ? '믿을 수 있다' : '믿을 수 없다'} — ${tree.reason}`)
  if (tree.truncated) {
    console.log(
      `주의  위젯 상한에 닿았다. ${total - flat.length}개가 트리에 없으니 "없다" 를 단정할 수 없다.`,
    )
  }

  const max = Number(flags.get('max') || '60')

  // `--find` 는 라벨로 찾는다. objectName 뿐 아니라 text·toolTip·accessibleName·
  // QAction 텍스트를 함께 본다 — **툴바 버튼은 objectName 이 비어 있고 라벨이 다른
  // 곳에 있다.** 찾은 것은 누를 수 있게 창 기준 좌표까지 준다.
  const find = flags.get('find') || ''
  if (find !== '') {
    const hits = findByLabel(tops, find)
    // 캡처 사각형 원점을 살아 있는 창에서 가져온다. **hello 는 스냅샷이므로 그 뒤에
    // 창이 움직였으면 좌표가 낡는다** — 창을 못 찾으면 좌표를 아예 내지 않는다.
    // 틀린 좌표를 내는 것이 안 내는 것보다 나쁘다.
    // 어느 창이 메인인지는 `classifyWindows` 가 이미 판정한다 (`state` 와 같은 규칙).
    // 여기서 "가장 큰 창" 을 다시 쓰면 규칙이 두 벌이 된다.
    const origin = classifyWindows(listWindows({ pid: h.pid })).main ?? undefined

    console.log(`\n"${find}" 에 맞는 위젯 ${hits.length}개:`)
    if (origin === undefined) {
      console.log(`주의  pid=${h.pid} 의 창을 찾지 못해 창 기준 좌표를 낼 수 없다 (앱이 닫혔나).`)
    }
    for (const w of hits.slice(0, max)) {
      const marks = `${w.visible ? '' : ' [숨김]'}${w.enabled ? '' : ' [비활성]'}`
      const labels = widgetLabels(w)
      const at =
        origin === undefined
          ? `화면 ${w.screenX},${w.screenY}`
          : (() => {
              const c = widgetCenter(w, origin)
              return `창 기준 한가운데 ${c.x},${c.y}`
            })()
      console.log(`  ${w.class.padEnd(28)} ${w.width}x${w.height}${marks}  ${at}`)
      console.log(`    라벨: ${labels.map((l) => JSON.stringify(l)).join(' · ')}`)
    }
    if (hits.length > max) console.log(`  ... ${hits.length - max}개 더 (--max 로 늘린다)`)
    if (hits.length > 0 && origin !== undefined) {
      console.log('\n누를 때는 위 "창 기준 한가운데" 를 그대로 쓴다: zwprobe click <x> <y>')
    }
    return tree.trustworthy ? 0 : 3
  }

  // 기본 목록은 **가리킬 수 있는 위젯**만 보여준다. 라벨이 하나도 없는 것은 주소를
  // 매길 수 없으므로 M5 설계에 정보를 주지 않는다.
  const named = flat.filter((w) => widgetLabels(w).length > 0)
  const needle = (flags.get('filter') || '').toLowerCase()
  const shown = needle ? named.filter((w) => w.objectName.toLowerCase().includes(needle)) : named

  console.log(`\n가리킬 수 있는 위젯 ${named.length}개${needle ? ` 중 "${needle}" 에 맞는 ${shown.length}개` : ''}:`)
  for (const w of shown.slice(0, max)) {
    const marks = `${w.visible ? '' : ' [숨김]'}${w.enabled ? '' : ' [비활성]'}`
    const name = w.objectName !== '' ? w.objectName : widgetLabels(w)[0]!
    console.log(`  ${w.class.padEnd(28)} ${name}  ${w.width}x${w.height}${marks}`)
  }
  if (shown.length > max) {
    console.log(`  ... ${shown.length - max}개 더 (--max 로 늘린다)`)
  }

  if (!abi.match) return 1
  // **과도 상태 트리는 없는 트리와 같이 쓸 수 없다.** 그래서 sawUi 만 보지 않고
  // judgeTree 를 쓴다 — 스플래시 시절 트리로 0을 돌려주면 조용히 틀린 판단이 나간다.
  return tree.trustworthy ? 0 : 3
}

function cmdLog(flags: Map<string, string>): number {
  const found = locateLog(flags.get('app-version') || runningAppVersion(flags))
  if (found === null) {
    console.error(
      `로그 파일을 찾지 못했다. ${logDir() ?? '%LOCALAPPDATA%'} 를 확인한다. ` +
        '대상 앱을 한 번도 실행하지 않았으면 없을 수 있다.',
    )
    return 1
  }

  console.log(`${found.path}`)
  console.log(
    `  앱 버전 ${found.appVersion} (${found.how}) · 시작 ${found.startedUtc.toISOString()} (UTC) · ${(found.sizeBytes / 1024).toFixed(0)} KB`,
  )
  if (found.how === 'newest') {
    console.log('주의  실행 중인 앱 버전과 일치하는 로그가 없어 전체 최신을 골랐다.')
  }

  const min = toSeverity(flags.get('min-severity') || 'WARNING')
  const entries = readEntries(found.path)
  const s = summarize(entries, min)

  const counts = (['FATAL', 'ASSERT', 'ERROR', 'WARNING', 'INFO', 'UNKNOWN'] as const)
    .filter((k) => s.counts[k] > 0)
    .map((k) => `${k} ${s.counts[k]}`)
    .join(' · ')
  console.log(`  항목 ${s.total}개 — ${counts || '없음'}${s.worst ? ` · 최악 ${s.worst}` : ''}`)

  const tailN = Number(flags.get('tail') || '0')
  const show = flags.has('all')
    ? entries
    : tailN > 0
      ? entries.slice(-tailN)
      : s.problems

  if (show.length === 0) {
    console.log(`\n${min} 이상 항목이 없다.`)
    return 0
  }

  console.log(`\n${flags.has('all') || tailN > 0 ? `${show.length}개` : `${min} 이상 ${show.length}개`}:`)
  for (const e of show) {
    const t = e.time ? e.time.toTimeString().slice(0, 8) : '--:--:--'
    console.log(`  ${t} [${e.severity}] ${e.classContext}: ${e.message.replace(/\n/g, '\n           ')}`)
  }
  return 0
}

// ── 녹화 ─────────────────────────────────────────────────────
//
// start → (다른 명령으로 조작) → stop. zwwin.exe record 가 백그라운드로 돌고, 상태 파일이 그 사이를
// 잇는다. 한 번에 하나만 녹화한다 — 둘을 띄우면 어느 stop 이 어느 영상을 끝내는지 섞인다.

const RECORDING_STATE = resolve('runs/recording.json')

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readRecordingState(): RecordingState | undefined {
  if (!existsSync(RECORDING_STATE)) return undefined
  const s = parseRecordingState(readFileSync(RECORDING_STATE, 'utf8'))
  if (!s.ok) {
    console.error(`상태 파일을 읽지 못했다 (${RECORDING_STATE}): ${s.reason}`)
    return undefined
  }
  return s.value
}

async function cmdRecord(rest: string[], flags: Map<string, string>): Promise<number> {
  const action = rest[0] ?? 'status'
  if (action === 'start') return await recordStart(flags)
  if (action === 'stop') return await recordStop(flags)
  if (action === 'status') return recordStatus()
  console.error(`record 뒤에는 start · stop · status 중 하나를 쓴다: '${action}'`)
  return 1
}

async function recordStart(flags: Map<string, string>): Promise<number> {
  const running = readRecordingState()
  if (running && isAlive(running.pid)) {
    console.error(`이미 녹화 중이다 (pid ${running.pid}, ${running.out}). 먼저 'zwprobe record stop'.`)
    return 1
  }

  const v = validateRecordOptions({
    out: flags.get('out') || `captures/rec-${timestamp()}.mp4`,
    fps: flags.get('fps') || undefined,
    maxSeconds: flags.get('max-seconds') || undefined,
    mode: flags.get('mode') || undefined,
    noCursor: flags.has('no-cursor'),
  })
  if (!v.ok) {
    console.error(v.reason)
    return 1
  }
  const opts = v.value

  const filter = targetFilter(flags)
  const wins = listWindows(filter)
  if (wins.length === 0) {
    console.error('녹화할 창을 찾지 못했다 — 앱이 떠 있는지 zwprobe state 로 본다.')
    return 1
  }

  const out = resolve(opts.out)
  const stamp = timestamp()
  const result = resolve(`runs/recording-${stamp}.result.json`)
  const stop = resolve(`runs/recording-${stamp}.stop`)
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(dirname(result), { recursive: true })
  for (const f of [result, stop]) rmSync(f, { force: true })

  const pid = startRecord({ ...filter, out, result, stop, fps: opts.fps, maxSeconds: opts.maxSeconds, mode: opts.mode, cursor: opts.cursor })
  const state: RecordingState = {
    pid, out, result, stop, startedAt: new Date().toISOString(), fps: opts.fps, maxSeconds: opts.maxSeconds, mode: opts.mode,
  }
  writeFileSync(RECORDING_STATE, JSON.stringify(state, null, 2))

  // 인코더를 못 만들었거나 창을 못 찾았으면 바로 결과를 쓰고 끝난다. 그걸 여기서 잡는다 —
  // 모르고 조작을 이어가면 녹화되지 않은 채 stop 에서야 알게 된다.
  await sleepMs(1500)
  if (existsSync(result)) {
    const r = parseRecordResult(readFileSync(result, 'utf8'))
    rmSync(RECORDING_STATE, { force: true })
    if (!r.ok) {
      console.error(`녹화가 시작하자마자 끝났다: ${r.error}`)
      return 1
    }
  }
  if (!isAlive(pid)) {
    rmSync(RECORDING_STATE, { force: true })
    console.error('녹화 프로세스가 결과 없이 끝났다.')
    return 1
  }

  const w = wins[0]!
  console.log(`녹화  시작 — pid=${pid}`)
  console.log(`창    ${w.width}x${w.height} pid=${w.pid} "${w.title}"  (mode=${opts.mode}, ${opts.fps} fps, 커서 ${opts.cursor ? '그림' : '안 그림'})`)
  console.log(`저장  ${out}  (끝나야 생긴다)`)
  console.log(`상한  ${opts.maxSeconds}초 — 그 전에 'zwprobe record stop' 으로 끝낸다`)
  return 0
}

async function recordStop(flags: Map<string, string>): Promise<number> {
  const state = readRecordingState()
  if (!state) {
    console.error('진행 중인 녹화가 없다.')
    return 1
  }

  writeFileSync(state.stop, '')
  // 마무리(인코더 비우기·moov 쓰기)는 길이에 비례한다. 10분 녹화에 수 초.
  const timeoutMs = Number(flags.get('timeout') || 60) * 1000
  const deadline = Date.now() + timeoutMs
  while (!existsSync(state.result) && Date.now() < deadline) {
    if (!isAlive(state.pid) && !existsSync(state.result)) break
    await sleepMs(200)
  }

  if (!existsSync(state.result)) {
    console.error(
      isAlive(state.pid)
        ? `${timeoutMs / 1000}초 안에 마무리되지 않았다 (pid ${state.pid} 가 아직 돈다). --timeout 을 늘려 다시 stop 한다.`
        : '녹화 프로세스가 결과를 쓰지 않고 끝났다 — 영상이 깨졌을 수 있다.',
    )
    return 1
  }

  const r = parseRecordResult(readFileSync(state.result, 'utf8'))
  rmSync(RECORDING_STATE, { force: true })
  rmSync(state.stop, { force: true })
  if (!r.ok) {
    console.error(`녹화 실패: ${r.error}`)
    return 1
  }

  const file = existsSync(r.out) ? readMp4Summary(readFileSync(r.out)) : { hasMoov: false, samples: 0, seconds: 0 }
  const verdict = judgeRecording(r, file)
  console.log(`저장  ${r.out}  (${(r.bytes / 1024 / 1024).toFixed(1)} MB)`)
  console.log(`영상  ${r.width}x${r.height} · ${r.seconds.toFixed(1)}초 · ${r.frames}프레임 @ ${r.fps} fps (복제 ${r.duplicated}) · mode=${r.mode}`)
  console.log(`파일  moov ${file.hasMoov ? '있음' : '없음'} · ${file.samples}샘플 · ${file.seconds.toFixed(1)}초`)
  console.log(`끝    ${r.stopReason === 'stop' ? 'stop 으로 멈췄다' : r.stopReason}`)
  for (const n of verdict.notes) console.log(`주의  ${n}`)
  console.log(`판정  ${verdict.usable ? '쓸 수 있다' : '쓸 수 없다'}`)
  return verdict.usable ? 0 : 2
}

function recordStatus(): number {
  const state = readRecordingState()
  if (!state || !isAlive(state.pid)) {
    console.log('녹화 중이 아니다.')
    if (state && existsSync(state.result)) console.log(`끝난 녹화의 결과가 남아 있다 — 'zwprobe record stop' 으로 정리한다.`)
    return 1
  }
  const t = elapsedSeconds(state, new Date())
  console.log(`녹화 중 — pid=${state.pid} · ${t.elapsed.toFixed(0)}초 지남 · 상한까지 ${t.remaining.toFixed(0)}초`)
  console.log(`저장  ${state.out}`)
  return 0
}

async function main(): Promise<number> {
  const { verb, rest, flags } = parseArgs(process.argv.slice(2))
  switch (verb) {
    case 'windows':
      return cmdWindows(flags)
    case 'shot':
      return cmdShot(flags)
    case 'shortcuts':
      return cmdShortcuts(flags)
    case 'key':
      return await cmdKey(rest, flags)
    case 'log':
      return cmdLog(flags)
    case 'state':
      return cmdState(flags)
    case 'click':
      return cmdClick(rest, flags)
    case 'uia':
      return cmdUia(flags)
    case 'doc':
      return cmdDoc(flags)
    case 'run':
      return cmdRun(rest, flags)
    case 'baseline':
      return cmdBaseline(rest, flags)
    case 'diff':
      return cmdDiff(rest, flags)
    case 'agent':
      return await cmdAgent(flags)
    case 'mouse':
      return await cmdMouse(flags)
    case 'record':
      return await cmdRecord(rest, flags)
    default:
      console.error(
        '사용법:\n' +
          '  관찰\n' +
          '    zwprobe shot      [--process 이름] [--pid N] [--title 조각] [--out 경로] [--mode screen]\n' +
          '    zwprobe windows   [--process 이름] [--pid N] [--title 조각]\n' +
          '    zwprobe state     [--process 이름] [--pid N]   (0=idle 3=busy 1=못 찾음)\n' +
          '    zwprobe uia       [--name X] [--id X] [--class X] [--type X] [--depth N] [--max N]\n' +
          '    zwprobe doc       열린 파일명과 dirty (0=저장됨 3=변경있음 1=못 읽음)\n' +
          '    zwprobe log       [--min-severity WARNING] [--tail N] [--all]\n' +
          '  조작 — 포그라운드를 점유한다\n' +
          '    zwprobe key <기능이름> [--process 이름] [--method post]\n' +
          '    zwprobe shortcuts [--filter 조각]\n' +
          '    zwprobe click <x> <y> [--button right] [--double] [--slow] [--stay]   좌표는 shot 의 PNG 기준. --slow 는 눈으로 보이게, --stay 는 커서를 두고 온다(하위 메뉴)\n' +
          '    zwprobe click --name "Simulation"   UIA 로 찾아 한가운데를 누른다\n' +
          '  시나리오\n' +
          '    zwprobe run <파일.ts> [--out 폴더] [--keep-going]   (0=통과 2=실패 1=거부)\n' +
          '    zwprobe baseline [<이름>] [--force] [--dir 폴더]    이름 없으면 목록\n' +
          '    zwprobe diff <a> <b> [--tolerance N] [--max-changed 0.01]  (0=같다 2=다르다)\n' +
          '  에이전트 — 앱을 `-style zwagent` 로 띄운 뒤\n' +
          '    zwprobe agent     [--hello 경로] [--filter 조각] [--max N]\n' +
          '                      (0=로드+UI 확인 3=로드했으나 UI 못 봄 1=못 읽음)\n' +
          '    zwprobe mouse     --object 2dview (--at x,y | --from x,y --to x,y [--steps N] | --events <JSON>)\n' +
          '                      [--button middle] [--shift] [--ctrl] [--alt] [--world reset] [--hello 경로]\n' +
          '                      위젯 기준 px. --world reset 이면 월드 cm (선택 빈 Shift+F 직후 카메라)',
      )
      return 1
  }
}

try {
  process.exitCode = await main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
