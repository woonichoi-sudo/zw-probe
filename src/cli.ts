// zwprobe — Z-Weave 를 외부에서 조작·관찰·판정하는 CLI.
//
//   node src/cli.ts shot [--process z-weave] [--pid N] [--title 조각] [--out 경로]
//   node src/cli.ts windows [--process z-weave]

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { TARGET_PROCESS, click, listWindows, sendKey, shot, uiaTree } from './win/zwwin.ts'
import { analyze, judgeCapture } from './image/stats.ts'
import type { WindowFilter } from './win/zwwin.ts'
import { findConflicts, findShortcut } from './input/shortcut.ts'
import { loadShortcuts } from './input/shortcutFile.ts'
import { locateLog, logDir, readEntries } from './log/logFile.ts'
import { summarize, toSeverity } from './log/parse.ts'
import { judgeActivity, styleNames } from './win/windowState.ts'
import { judgeClick } from './input/click.ts'
import { clickPoint, findNodes, findOne, readDocumentState } from './uia/tree.ts'
import type { NodeQuery } from './uia/tree.ts'

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

function cmdKey(rest: string[], flags: Map<string, string>): number {
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

  const method = flags.get('method') === 'post' ? 'post' : 'send'
  const r = sendKey({ ...filterFrom(flags), stroke: entry.stroke, method })

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
    ...(flags.has('hold') ? { holdMs: Number(flags.get('hold')) } : {}),
  })

  console.log(`클릭  ${r.button}${r.double ? ' ×2' : ''} 창 기준 (${r.x},${r.y}) → 화면 (${r.screenX},${r.screenY})`)
  console.log(`대상  ${r.window.width}x${r.window.height} hwnd=${r.window.hwnd} pid=${r.window.pid} "${r.window.title}"`)

  const v = judgeClick(r)
  console.log(`판정  ${v.onTarget ? '정상' : '의심'} — ${v.reason}`)
  if (!r.cursorRestored) {
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

function main(): number {
  const { verb, rest, flags } = parseArgs(process.argv.slice(2))
  switch (verb) {
    case 'windows':
      return cmdWindows(flags)
    case 'shot':
      return cmdShot(flags)
    case 'shortcuts':
      return cmdShortcuts(flags)
    case 'key':
      return cmdKey(rest, flags)
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
    default:
      console.error(
        '사용법:\n' +
          '  zwprobe shot      [--process 이름] [--pid N] [--title 조각] [--out 경로] [--mode screen]\n' +
          '  zwprobe windows   [--process 이름] [--pid N] [--title 조각]\n' +
          '  zwprobe shortcuts [--filter 조각]\n' +
          '  zwprobe key <기능이름> [--process 이름] [--method post]\n' +
          '  zwprobe log       [--min-severity WARNING] [--tail N] [--all]\n' +
          '  zwprobe state     [--process 이름] [--pid N]   (0=idle 3=busy 1=못 찾음)\n' +
          '  zwprobe click <x> <y> [--button right] [--double]   좌표는 shot 의 PNG 기준\n' +
          '  zwprobe click --name "Simulation"   UIA 로 찾아 한가운데를 누른다\n' +
          '  zwprobe uia       [--name X] [--id X] [--class X] [--type X] [--depth N] [--max N]\n' +
          '  zwprobe doc       열린 파일명과 dirty (0=저장됨 3=변경있음 1=못 읽음)',
      )
      return 1
  }
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
