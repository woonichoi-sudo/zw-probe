// 시나리오를 실제로 실행하는 I/O 가장자리. 판정은 전부 순수 함수에 위임한다
// (CLAUDE.md 절대 규칙 5).
//
// 이 파일이 하는 일은 셋뿐이다 — 순서대로 부르고, 전후를 찍고, 결과를 파일로 남긴다.
// "통과인가" 를 정하는 코드는 여기 없다. `judgeSame`·`judgeChanged`·`judgeClick`·
// `judgeActivity`·`findOne`·`readDocumentState` 가 답하고 이 파일은 옮긴다.
//
// **실패하면 멈춘다.** 앱 상태는 단계마다 누적되므로, 3번째가 실패한 뒤 4번째를
// 실행하면 전제가 깨진 상태에서 조작하는 것이 된다. 뒤 단계는 'skipped' 로 남긴다.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readCapture, writeCaptureMeta } from '../image/captureFile.ts'
import { checkBaseline } from '../image/captureMeta.ts'
import type { CaptureMeta } from '../image/captureMeta.ts'
import { diff, judgeChanged, judgeSame } from '../image/diff.ts'
import { judgeClick } from '../input/click.ts'
import { findShortcut } from '../input/shortcut.ts'
import { loadShortcuts } from '../input/shortcutFile.ts'
import type { LoadedShortcuts } from '../input/shortcutFile.ts'
import { activePanel, findOne, readDocumentState } from '../uia/tree.ts'
import { judgeActivity } from '../win/windowState.ts'
import { TARGET_PROCESS, click, listWindows, sendKey, shot, uiaTree } from '../win/zwwin.ts'
import type { WindowFilter } from '../win/zwwin.ts'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  describeStep,
  summarizeRun,
  validateScenario,
  wantsChange,
} from './steps.ts'
import type { Bgra } from '../image/stats.ts'
import type { RunSummary, Scenario, Step, StepResult } from './steps.ts'

/** baseline 은 커밋한다. 실행 산출물은 커밋하지 않는다 (.gitignore). */
export const BASELINE_DIR = 'baselines'
export const RUNS_DIR = 'runs'

export type RunOptions = {
  filter?: WindowFilter
  /** 산출물을 남길 폴더. 기본 `runs/<시각>-<시나리오이름>` */
  outDir?: string
  /** baseline 폴더. 기본 `baselines` */
  baselineDir?: string
  /** 실패해도 계속할지. 기본 false — 앱 상태가 누적되므로 멈추는 것이 옳다 */
  keepGoing?: boolean
  /** 진행 상황을 한 줄씩 흘려보낼 곳. 없으면 조용히 돈다 */
  onProgress?: (line: string) => void
}

export type RunResult = {
  outDir: string
  results: StepResult[]
  summary: RunSummary
  /** 실행 전 검증에서 걸렸으면 여기에 이유가 있고 results 는 비어 있다 */
  rejected: string[] | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 파일 이름으로 쓸 수 없는 문자를 없앤다. 시나리오 이름은 자유 문자열이다. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._가-힣-]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario'
}

/** `baselines/` 에 있는 이름들. 검증에 넘겨 없는 baseline 참조를 미리 잡는다. */
export function listBaselines(dir = BASELINE_DIR): string[] {
  const d = resolve(dir)
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort()
}

/** 창을 찍어 픽셀과 메타를 돌려준다. 사이드카도 함께 쓴다. */
function capture(base: string, filter: WindowFilter): { img: Bgra; meta: CaptureMeta; png: string } {
  const png = `${base}.png`
  const raw = `${base}.bgra`
  mkdirSync(resolve(png, '..'), { recursive: true })
  const info = shot({ ...filter, png, raw })
  const w = info.window
  const meta: CaptureMeta = {
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
  }
  writeCaptureMeta(base, meta)
  const loaded = readCapture(base)
  return { img: loaded.img, meta: loaded.meta, png }
}

/**
 * 창 구조가 idle 이 될 때까지 기다린다.
 *
 * **sleep 추측을 대체하는 것이 이것이다.** 다만 `state` 는 진행 다이얼로그와 입력
 * 대기 다이얼로그를 구분하지 못하므로(CLAUDE.md) 상한이 반드시 필요하다 — 입력을
 * 요구하는 다이얼로그가 떠 있으면 영원히 idle 이 안 된다.
 */
async function waitIdle(
  filter: WindowFilter,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string; waitedMs: number }> {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < timeoutMs) {
    const a = judgeActivity(listWindows(filter))
    last = a.reason
    if (a.state === 'idle') {
      return { ok: true, reason: `${Date.now() - started}ms 만에 idle. ${a.reason}`, waitedMs: Date.now() - started }
    }
    if (a.state === 'unknown') {
      // 창이 사라졌다. 기다려도 안 돌아온다 — 앱이 죽었거나 필터가 틀렸다.
      return { ok: false, reason: `창을 찾지 못했다. ${a.reason}`, waitedMs: Date.now() - started }
    }
    await sleep(150)
  }
  return {
    ok: false,
    reason: `${timeoutMs}ms 안에 idle 이 되지 않았다. 마지막 상태: ${last}`,
    waitedMs: Date.now() - started,
  }
}

/** 단축키 하나를 이름으로 보낸다. 이름을 못 찾으면 던지지 않고 이유를 돌려준다. */
function pressShortcut(
  file: LoadedShortcuts,
  name: string,
  filter: WindowFilter,
): { ok: boolean; reason: string } {
  const entry = findShortcut(file, name)
  if (entry === undefined) {
    return { ok: false, reason: `단축키 "${name}" 을 ${file.path} 에서 찾지 못했다.` }
  }
  const r = sendKey({ ...filter, stroke: entry.stroke, method: 'send' })
  if (!r.activated) {
    // 포그라운드를 못 잡으면 키가 다른 창으로 갔다. 통했는지 알 수 없는 것이
    // 아니라 **다른 앱이 그 키를 받았다** 는 뜻이다.
    return { ok: false, reason: `${entry.spec} 를 보냈지만 창을 포그라운드로 올리지 못했다.` }
  }
  return { ok: true, reason: `${entry.name} = ${entry.spec} 를 보냈다.` }
}

/**
 * 시나리오를 실행한다.
 *
 * 순서: 검증 → (실패하면 아무것도 실행하지 않고 반환) → 단계별 실행 → 보고서 저장.
 */
export async function runScenario(sc: Scenario, opts: RunOptions = {}): Promise<RunResult> {
  const filter: WindowFilter = { ...(opts.filter ?? {}) }
  if (filter.process === undefined && filter.pid === undefined && filter.title === undefined) {
    filter.process = TARGET_PROCESS
  }
  const baselineDir = opts.baselineDir ?? BASELINE_DIR
  const outDir = resolve(opts.outDir ?? join(RUNS_DIR, `${stamp()}-${slug(sc.name)}`))
  const say = opts.onProgress ?? (() => {})

  // 단축키 목록은 검증에도 실행에도 쓰인다. 못 읽으면 이름 검사를 건너뛰되
  // 실행 자체는 막는다 — 이름을 못 찾으면 키를 보낼 수 없다.
  let shortcutFile: LoadedShortcuts | null = null
  let shortcutNames: string[] | undefined
  try {
    const running = listWindows(filter).find((w) => w.fileVersion !== '')?.fileVersion
    shortcutFile = loadShortcuts(running)
    shortcutNames = shortcutFile.entries.map((e) => e.name)
  } catch {
    shortcutFile = null
  }

  const errors = validateScenario(sc, {
    ...(shortcutNames !== undefined ? { shortcutNames } : {}),
    baselineNames: listBaselines(baselineDir),
  })
  if (errors.length > 0) {
    const rejected = errors.map((e) =>
      e.stepIndex < 0 ? `시나리오: ${e.message}` : `${e.stepIndex + 1}번째 단계: ${e.message}`,
    )
    return { outDir, results: [], summary: summarizeRun(sc, []), rejected }
  }

  mkdirSync(outDir, { recursive: true })
  const results: StepResult[] = []
  let stopped = false

  for (let i = 0; i < sc.steps.length; i++) {
    const step = sc.steps[i]!
    const description = describeStep(step)

    if (stopped) {
      results.push({
        stepIndex: i,
        description,
        outcome: 'skipped',
        reason: '앞 단계가 실패해 실행하지 않았다.',
        elapsedMs: 0,
      })
      continue
    }

    say(`${String(i + 1).padStart(2)} ${description}`)
    const started = Date.now()
    const artifacts: string[] = []

    // 동작 단계는 전후를 비교한다. 찍는 비용(약 100ms)이 있으므로 필요할 때만 찍는다.
    let before: { img: Bgra; meta: CaptureMeta } | null = null
    if (wantsChange(step)) {
      try {
        const c = capture(join(outDir, `${String(i + 1).padStart(2, '0')}-before`), filter)
        before = { img: c.img, meta: c.meta }
        artifacts.push(c.png)
      } catch (err) {
        // 전후 비교를 못 하는 것이 단계 실패는 아니다. 비교를 건너뛰고 진행한다.
        say(`   (전 캡처 실패 — 전후 비교를 건너뛴다: ${err instanceof Error ? err.message : String(err)})`)
      }
    }

    let outcome: StepResult['outcome'] = 'pass'
    let reason = ''

    try {
      switch (step.do) {
        case 'key': {
          if (shortcutFile === null) {
            outcome = 'fail'
            reason = 'shortcut.ini 를 읽지 못해 단축키를 보낼 수 없다.'
            break
          }
          const r = pressShortcut(shortcutFile, step.shortcut, filter)
          outcome = r.ok ? 'pass' : 'fail'
          reason = r.reason
          break
        }
        case 'click': {
          const r = click({
            ...filter,
            x: step.x,
            y: step.y,
            ...(step.button !== undefined ? { button: step.button } : {}),
            ...(step.double !== undefined ? { double: step.double } : {}),
          })
          const v = judgeClick(r)
          outcome = v.onTarget ? 'pass' : 'fail'
          reason = v.reason
          break
        }
        case 'clickName': {
          const dump = uiaTree(filter)
          const hit = findOne(dump, {
            ...(step.name !== undefined ? { name: step.name } : {}),
            ...(step.id !== undefined ? { automationId: step.id } : {}),
            ...(step.class !== undefined ? { class: step.class } : {}),
            ...(step.type !== undefined ? { controlType: step.type } : {}),
            clickableOnly: true,
          })
          if (!hit.found) {
            outcome = 'fail'
            reason = hit.reason
            break
          }
          const r = click({
            ...filter,
            x: hit.node.wx + Math.floor(hit.node.width / 2),
            y: hit.node.wy + Math.floor(hit.node.height / 2),
            ...(step.button !== undefined ? { button: step.button } : {}),
            ...(step.double !== undefined ? { double: step.double } : {}),
          })
          const v = judgeClick(r)
          outcome = v.onTarget ? 'pass' : 'fail'
          reason = `[${hit.node.controlType}] "${hit.node.name}" — ${v.reason}`
          break
        }
        case 'waitIdle': {
          const r = await waitIdle(filter, step.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
          outcome = r.ok ? 'pass' : 'fail'
          reason = r.reason
          break
        }
        case 'sleep': {
          await sleep(step.ms)
          reason = `${step.ms}ms 기다렸다 (${step.why}).`
          break
        }
        case 'shot': {
          const c = capture(join(outDir, `${String(i + 1).padStart(2, '0')}-${slug(step.label)}`), filter)
          artifacts.push(c.png)
          reason = `${c.meta.width}x${c.meta.height} 를 ${c.png} 에 남겼다.`
          break
        }
        case 'checkBaseline': {
          const c = capture(join(outDir, `${String(i + 1).padStart(2, '0')}-actual`), filter)
          artifacts.push(c.png)
          const base = readCapture(join(baselineDir, step.baseline))
          const compat = checkBaseline(base.meta, c.meta)
          for (const w of compat.warnings) say(`   주의 ${w}`)
          if (!compat.usable) {
            outcome = 'fail'
            reason = compat.reason
            break
          }
          const d = diff(base.img, c.img, {
            ...(step.ignore !== undefined ? { ignore: step.ignore } : {}),
          })
          const v = judgeSame(d, step.maxChangedRatio ?? 0)
          outcome = v.same ? 'pass' : 'fail'
          reason =
            v.reason + (compat.warnings.length > 0 ? ` (경고 ${compat.warnings.length}개)` : '')
          break
        }
        case 'expectDoc': {
          const s = readDocumentState(uiaTree({ ...filter, depth: 3 }))
          const bad: string[] = []
          if (step.fileName !== undefined && s.fileName !== step.fileName) {
            bad.push(`파일명이 "${s.fileName}" 인데 "${step.fileName}" 를 기대했다`)
          }
          if (step.dirty !== undefined && s.dirty !== step.dirty) {
            bad.push(`dirty 가 ${s.dirty} 인데 ${step.dirty} 를 기대했다`)
          }
          outcome = bad.length === 0 ? 'pass' : 'fail'
          reason = bad.length === 0 ? s.reason : `${bad.join(', ')}. ${s.reason}`
          break
        }
        case 'expectPanel': {
          const p = activePanel(uiaTree(filter))
          const bad: string[] = []
          if (step.dockId !== undefined && p.dockId !== step.dockId) {
            bad.push(`dock 이 ${p.dockId ?? '(모름)'} 인데 ${step.dockId} 를 기대했다`)
          }
          if (step.tabName !== undefined && p.tabName !== step.tabName) {
            bad.push(`탭이 "${p.tabName ?? '(모름)'}" 인데 "${step.tabName}" 를 기대했다`)
          }
          outcome = bad.length === 0 ? 'pass' : 'fail'
          reason = bad.length === 0 ? p.reason : `${bad.join(', ')}. ${p.reason}`
          break
        }
        case 'expectElement': {
          const dump = uiaTree(filter)
          const hit = findOne(dump, {
            ...(step.name !== undefined ? { name: step.name } : {}),
            ...(step.id !== undefined ? { automationId: step.id } : {}),
            ...(step.class !== undefined ? { class: step.class } : {}),
            ...(step.type !== undefined ? { controlType: step.type } : {}),
          })
          const shouldExist = step.present !== false
          if (shouldExist) {
            // 여럿 맞은 것은 "있다" 로 본다 — 존재 확인이지 특정이 아니다.
            const any = hit.found || (hit.found === false && hit.candidates.length > 0)
            outcome = any ? 'pass' : 'fail'
            reason = hit.found ? hit.reason : any ? `여러 개 있다. ${hit.reason}` : hit.reason
          } else {
            const none = hit.found === false && hit.candidates.length === 0
            outcome = none ? 'pass' : 'fail'
            reason = none ? '없다 — 기대한 대로다.' : `있어서는 안 되는데 있다. ${hit.reason}`
          }
          break
        }
      }
    } catch (err) {
      // I/O 실패(zwwin.exe 가 창을 못 찾음 등)는 단계 실패다. 던져서 러너를
      // 끊으면 보고서가 안 남는다 — 실패 지점을 남기는 것이 이 도구의 목적이다.
      outcome = 'fail'
      reason = `실행 중 예외: ${err instanceof Error ? err.message : String(err)}`
    }

    // 전후 비교. 동작이 통했는지는 판정과 별개다 — 클릭이 대상에 닿았어도
    // 앱이 그 상태에서 무시했으면 화면은 그대로다.
    if (outcome === 'pass' && before !== null) {
      try {
        const after = capture(join(outDir, `${String(i + 1).padStart(2, '0')}-after`), filter)
        artifacts.push(after.png)
        const v = judgeChanged(diff(before.img, after.img))
        if (!v.changed) {
          outcome = 'fail'
          reason = `${reason} 그런데 ${v.reason}`
        } else {
          reason = `${reason} ${v.reason}`
        }
      } catch (err) {
        say(`   (후 캡처 실패 — 전후 비교를 건너뛴다: ${err instanceof Error ? err.message : String(err)})`)
      }
    }

    const r: StepResult = {
      stepIndex: i,
      description,
      outcome,
      reason,
      elapsedMs: Date.now() - started,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    }
    results.push(r)
    say(`   ${outcome === 'pass' ? '✔' : '✖'} ${reason}`)

    if (outcome === 'fail') {
      // 실패 지점의 스냅샷을 한 번에 뜬다. 셋이 **같은 시각**이어야 원인을 짚을
      // 수 있다 — 나중에 따로 찍으면 앱이 이미 다른 상태다.
      try {
        const c = capture(join(outDir, `${String(i + 1).padStart(2, '0')}-FAIL`), filter)
        r.artifacts = [...(r.artifacts ?? []), c.png]
      } catch {
        /* 캡처마저 실패하면 남길 것이 없다. 보고서는 그대로 쓴다 */
      }
      try {
        const tree = uiaTree(filter)
        const p = join(outDir, `${String(i + 1).padStart(2, '0')}-FAIL-uia.json`)
        writeFileSync(p, JSON.stringify(tree, null, 2) + '\n', 'utf8')
        r.artifacts = [...(r.artifacts ?? []), p]
      } catch {
        /* UIA 를 못 읽는 것 자체가 정보이지만 보고서에 예외를 싣지는 않는다 */
      }

      if (opts.keepGoing !== true) stopped = true
    }
  }

  const summary = summarizeRun(sc, results)
  const report = join(outDir, 'report.txt')
  writeFileSync(report, summary.lines.join('\n') + '\n', 'utf8')
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify({ scenario: sc, results, ranAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  )

  return { outDir, results, summary, rejected: null }
}
