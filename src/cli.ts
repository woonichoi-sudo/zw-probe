// zwprobe — Z-Weave 를 외부에서 조작·관찰·판정하는 CLI.
//
//   node src/cli.ts shot [--process z-weave] [--pid N] [--title 조각] [--out 경로]
//   node src/cli.ts windows [--process z-weave]

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { TARGET_PROCESS, listWindows, sendKey, shot } from './win/zwwin.ts'
import { analyze, judgeCapture } from './image/stats.ts'
import type { WindowFilter } from './win/zwwin.ts'
import { findConflicts, findShortcut } from './input/shortcut.ts'
import { loadShortcuts } from './input/shortcutFile.ts'
import { locateLog, logDir, readEntries } from './log/logFile.ts'
import { summarize, toSeverity } from './log/parse.ts'
import { judgeActivity, styleNames } from './win/windowState.ts'

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
  const info = shot({ ...filterFrom(flags), png: out, raw, mode })
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
    default:
      console.error(
        '사용법:\n' +
          '  zwprobe shot      [--process 이름] [--pid N] [--title 조각] [--out 경로] [--mode screen]\n' +
          '  zwprobe windows   [--process 이름] [--pid N] [--title 조각]\n' +
          '  zwprobe shortcuts [--filter 조각]\n' +
          '  zwprobe key <기능이름> [--process 이름] [--method post]\n' +
          '  zwprobe log       [--min-severity WARNING] [--tail N] [--all]\n' +
          '  zwprobe state     [--process 이름] [--pid N]   (0=idle 3=busy 1=못 찾음)',
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
