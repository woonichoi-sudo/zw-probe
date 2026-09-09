// zwprobe — Z-Weave 를 외부에서 조작·관찰·판정하는 CLI.
//
//   node src/cli.ts shot [--process z-weave] [--pid N] [--title 조각] [--out 경로]
//   node src/cli.ts windows [--process z-weave]

import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { listWindows, shot } from './win/zwwin.ts'
import { analyze, judgeBlank } from './image/stats.ts'
import type { WindowFilter } from './win/zwwin.ts'

function parseArgs(argv: string[]): { verb: string; flags: Map<string, string> } {
  const verb = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : ''
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    flags.set(a.slice(2), next !== undefined && !next.startsWith('--') ? (i++, next) : '')
  }
  return { verb, flags }
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
  const verdict = judgeBlank(stats)

  console.log(
    `픽셀  검정 ${(stats.blackRatio * 100).toFixed(1)}% · ` +
      `평균 휘도 ${stats.meanLuminance.toFixed(1)} · 색상 ${stats.distinctColors}`,
  )

  if (verdict.blank) {
    console.log(`판정  빈 캡처다 — ${verdict.reason}`)
    console.log(
      mode === 'printwindow'
        ? '      PrintWindow 가 내용을 못 잡았을 수 있다. --mode screen 으로 다시 시도한다.'
        : '      화면 캡처로도 비어 있다. 창이 가려졌거나 최소화됐는지 확인한다.',
    )
    return 2
  }

  console.log('판정  정상')
  return 0
}

function main(): number {
  const { verb, flags } = parseArgs(process.argv.slice(2))
  switch (verb) {
    case 'windows':
      return cmdWindows(flags)
    case 'shot':
      return cmdShot(flags)
    default:
      console.error('사용법: zwprobe <shot|windows> [--process 이름] [--pid N] [--title 조각] [--out 경로]')
      return 1
  }
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
}
