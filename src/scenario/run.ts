// 시나리오를 실제로 실행하는 I/O 가장자리. 판정은 전부 순수 함수에 위임한다
// (CLAUDE.md 절대 규칙 5).
//
// 이 파일이 하는 일은 셋뿐이다 — 순서대로 부르고, 전후를 찍고, 결과를 파일로 남긴다.
// "통과인가" 를 정하는 코드는 여기 없다. `judgeSame`·`judgeChanged`·`judgeClick`·
// `judgeActivity`·`findOne`·`readDocumentState` 가 답하고 이 파일은 옮긴다.
//
// **실패하면 멈춘다.** 앱 상태는 단계마다 누적되므로, 3번째가 실패한 뒤 4번째를
// 실행하면 전제가 깨진 상태에서 조작하는 것이 된다. 뒤 단계는 'skipped' 로 남긴다.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { capturePaths, readCapture, writeCaptureMeta } from '../image/captureFile.ts'
import { checkBaseline } from '../image/captureMeta.ts'
import type { CaptureMeta } from '../image/captureMeta.ts'
import { diff, judgeChanged, judgeSame } from '../image/diff.ts'
import { judgeClick } from '../input/click.ts'
import { findShortcut } from '../input/shortcut.ts'
import { loadShortcuts } from '../input/shortcutFile.ts'
import type { LoadedShortcuts } from '../input/shortcutFile.ts'
import { activePanel, findOne, readDocumentState } from '../uia/tree.ts'
import { classifyWindows, judgeActivity } from '../win/windowState.ts'
import { call } from '../agent/pipe.ts'
import { callableActions, parseActions, parseCandidates } from '../agent/protocol.ts'
import type { AgentAction } from '../agent/protocol.ts'
import { TARGET_PROCESS, click, listWindows, sendKey, shot, uiaTree } from '../win/zwwin.ts'
import type { WindowFilter } from '../win/zwwin.ts'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  describeStep,
  needsAgent,
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

/**
 * 위젯 하나를 찍어 픽셀과 메타를 돌려준다 (`zwagent` 의 `QWidget::grab()`).
 *
 * `capture` 와 같은 모양을 돌려주므로 **비교 코드가 창이든 패널이든 구분하지 않는다.**
 * 사이드카의 `mode` 만 `grab` 으로 달라진다 — 나중에 "이게 창이었나 패널이었나" 를
 * 따질 근거다. baseline 이 창인데 실제가 패널이면 `checkBaseline` 이 크기에서 걸러낸다.
 */
async function grabWidget(
  base: string,
  pid: number,
  objectName: string,
): Promise<{ img: Bgra; meta: CaptureMeta; png: string }> {
  const png = `${base}.png`
  const raw = `${base}.bgra`
  mkdirSync(resolve(png, '..'), { recursive: true })
  const res = await call(pid, { id: 1, op: 'grab', objectName, pngPath: png, rawPath: raw })
  if (!res.ok) throw new Error(res.error)
  const width = Number(res.body.width)
  const height = Number(res.body.height)
  const meta: CaptureMeta = {
    format: 'bgra8',
    width,
    height,
    takenAt: new Date().toISOString(),
    mode: 'grab',
    window: {
      title: objectName,
      class: String(res.body.class ?? ''),
      pid,
      fileVersion: '',
      width,
      height,
    },
  }
  writeCaptureMeta(base, meta)
  const loaded = readCapture(base)
  return { img: loaded.img, meta: loaded.meta, png }
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
 * 통과한 동작 단계의 **생 픽셀만** 지운다. PNG 는 남긴다.
 *
 * **왜 필요한가.** 캡처 하나가 1920x1040 이면 `.bgra` 가 8MB 다. 동작 단계마다
 * 전후를 찍으므로 10단계 시나리오 한 번이 55MB 를 남겼다(2026-09-09 실측: `runs/`
 * 가 117MB). 그대로 두면 무한히 자란다.
 *
 * **전후 캡처는 즉시 비교하고 나면 쓸 데가 없다.** 반면 `shot`·`checkBaseline` 이
 * 남긴 것은 나중에 `zwprobe diff` 로 다시 볼 수 있어야 하므로 건드리지 않는다.
 * 실패한 단계도 전부 남긴다 — 실패 지점을 파는 것이 이 도구의 목적이다.
 *
 * PNG 를 남기는 이유: 사람이(그리고 내가) 눈으로 보는 것은 PNG 다. 작고, 판정에는
 * 안 쓰이므로 지울 이유가 없다.
 */
function pruneRaw(bases: readonly string[]): void {
  for (const base of bases) {
    const p = capturePaths(base)
    // 지우기 실패는 무시한다 — 디스크를 아끼려는 것이고, 못 지워도 결과는 옳다.
    rmSync(p.bgra, { force: true })
    rmSync(p.meta, { force: true })
  }
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
 * 최근 파일 항목이 사는 메뉴 경로. **여기 있는 것이 이 상수의 존재 이유다** —
 * 시나리오마다 손으로 적으면 오타가 나고, 오타는 "명령이 없다" 로만 보인다.
 */
const RECENT_FILES_PATH = 'File > Recent files'

/** 프로젝트 열기 상한. 실측 8초쯤 걸리므로 넉넉히 둔다. */
const OPEN_TIMEOUT_MS = 60_000

/**
 * `trigger` 뒤에 화면이 바뀌기를 기다리는 상한.
 *
 * **`trigger` 는 큐에 들어간다** — 응답이 와도 아직 실행 전이다. 바로 찍으면
 * "안 바뀌었다" 로 거짓 실패한다. 오래 걸리는 명령(프로젝트 열기 등)은
 * `openRecent` 처럼 자기 완료 신호가 있는 단계를 쓴다.
 */
const TRIGGER_SETTLE_MS = 5000

/**
 * 문서 이름이 기대한 것이 될 때까지 기다린다.
 *
 * **이것이 "열렸다" 의 신호다.** 진행 다이얼로그가 사라지는 것으로 판정하면 안 된다 —
 * 여러 개가 이어서 뜨고, 그 사이에 잠깐 idle 로 보이는 구간이 있다 (2026-09-10 실측:
 * `"Loading..."` 과 `"Loading.."` 이 차례로 떴다). 문서 교체가 마지막에 일어난다.
 */
async function waitForDocument(
  filter: WindowFilter,
  fileName: string,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs
  let last = '(못 읽음)'
  while (Date.now() < deadline) {
    try {
      const s = readDocumentState(uiaTree({ ...filter, depth: 3 }), { fromTitle: process.platform === 'darwin' })
      last = s.fileName
      if (s.fileName === fileName) {
        return { ok: true, reason: `"${fileName}" 이 열렸다 (${Math.round(timeoutMs)}ms 안에).` }
      }
    } catch {
      /* 여는 동안 UIA 가 잠깐 실패할 수 있다. 상한까지 다시 본다 */
    }
    await sleep(300)
  }
  return {
    ok: false,
    reason: `${timeoutMs}ms 안에 문서가 "${fileName}" 이 되지 않았다. 지금은 "${last}" 다.`,
  }
}

/**
 * 이름(과 경로)으로 명령 하나를 특정한다.
 *
 * **여럿이면 실패로 돌려준다.** 조용히 첫 번째를 고르면 다른 명령의 상태를 보거나
 * 다른 명령을 부르게 된다 — 실앱의 Import 와 Export 밑에 똑같이 `OBJ` 가 있다.
 */
async function findOneAction(
  pid: number,
  text: string,
  path?: string,
): Promise<{ ok: true; action: AgentAction } | { ok: false; reason: string }> {
  const res = await call(pid, { id: 0, op: 'actions' })
  if (!res.ok) return { ok: false, reason: res.error }
  const hits = parseActions(res.body).filter(
    (a) => a.text === text && (path === undefined || a.path === path),
  )
  if (hits.length === 0) return { ok: false, reason: `"${text}" 인 명령이 없다.` }
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `"${text}" 이 ${hits.length}개다. path 로 좁힌다: ${hits.map((h) => `"${h.path}"`).join(', ')}`,
    }
  }
  return { ok: true, action: hits[0]! }
}

/** 켬/끔 상태가 원하는 값이 될 때까지 기다린다. `trigger` 가 큐에 들어가기 때문이다. */
async function waitForChecked(
  pid: number,
  text: string,
  path: string | undefined,
  want: boolean,
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const deadline = Date.now() + timeoutMs
  let last: boolean | undefined
  while (Date.now() < deadline) {
    const f = await findOneAction(pid, text, path)
    if (!f.ok) return { ok: false, reason: f.reason }
    last = f.action.checked
    if (last === want) {
      return { ok: true, reason: `"${text}" 을 ${want ? '켰다' : '껐다'}.` }
    }
    await sleep(200)
  }
  return {
    ok: false,
    reason: `${timeoutMs}ms 안에 "${text}" 이 ${want ? '켬' : '끔'} 이 되지 않았다 (지금 ${last}).`,
  }
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

  // 명령 채널이 필요한 단계가 있으면 **시작 전에** 연결을 확인한다. 절차 중간에서
  // 파이프가 없는 것을 알면 앱은 이미 반쯤 조작된 상태이고, 그건 되돌릴 수 없다
  // (steps.ts 머리말 ①). 확인하는 김에 명령 목록을 받아 이름 오타도 함께 잡는다.
  const agentSteps = sc.steps.filter(needsAgent)
  let pid = 0
  let actionTexts: string[] | undefined
  const agentProblems: string[] = []
  if (agentSteps.length > 0) {
    const main = classifyWindows(listWindows(filter)).main
    if (main === null) {
      agentProblems.push(
        `명령 채널이 필요한 단계가 ${agentSteps.length}개인데 대상 창을 찾지 못했다.`,
      )
    } else {
      pid = main.pid
      const res = await call(pid, { id: 0, op: 'actions' }, { timeoutMs: 10000 })
      if (!res.ok) {
        agentProblems.push(
          `명령 채널이 필요한 단계가 ${agentSteps.length}개인데 파이프가 안 열린다.\n` +
            `    ${res.error}\n` +
            '    앱을 `-style zwagent` 로 띄웠는지 확인한다 — `zwprobe agent` 의 "채널" 줄이 말해준다.',
        )
      } else {
        // 목록에는 구분선과 서브메뉴 항목도 들어 있다. **부를 수 있는 것만** 이름
        // 검사에 넘긴다 — 서브메뉴 이름으로 trigger 하면 메뉴만 열리고 명령이 아니다.
        actionTexts = callableActions(parseActions(res.body)).map((a) => a.text)
      }
    }
  }

  const errors = validateScenario(sc, {
    ...(shortcutNames !== undefined ? { shortcutNames } : {}),
    baselineNames: listBaselines(baselineDir),
    ...(actionTexts !== undefined ? { actionTexts } : {}),
  })
  if (errors.length > 0 || agentProblems.length > 0) {
    const rejected = [
      ...agentProblems,
      ...errors.map((e) =>
        e.stepIndex < 0 ? `시나리오: ${e.message}` : `${e.stepIndex + 1}번째 단계: ${e.message}`,
      ),
    ]
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
    // 통과하면 지울 캡처의 기본 이름들. 근거는 pruneRaw 주석.
    const transient: string[] = []

    // 동작 단계는 전후를 비교한다. 찍는 비용(약 100ms)이 있으므로 필요할 때만 찍는다.
    let before: { img: Bgra; meta: CaptureMeta } | null = null
    if (wantsChange(step)) {
      try {
        const base = join(outDir, `${String(i + 1).padStart(2, '0')}-before`)
        const c = capture(base, filter)
        before = { img: c.img, meta: c.meta }
        artifacts.push(c.png)
        transient.push(base)
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
          const actualBase = join(outDir, `${String(i + 1).padStart(2, '0')}-actual`)
          // `panel` 을 주면 창이 아니라 그 위젯만 찍는다. 나머지 비교 로직은 같다 —
          // 두 벌로 나누면 baseline 호환 검사와 무시 영역 처리가 갈라진다.
          const c =
            step.panel !== undefined
              ? await grabWidget(actualBase, pid, step.panel)
              : capture(actualBase, filter)
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
          const s = readDocumentState(uiaTree({ ...filter, depth: 3 }), { fromTitle: process.platform === 'darwin' })
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
        case 'trigger': {
          const res = await call(pid, {
            id: i + 1,
            op: 'trigger',
            text: step.text,
            ...(step.path !== undefined ? { path: step.path } : {}),
          })
          if (!res.ok) {
            outcome = 'fail'
            // 이름이 겹쳐 거부됐으면 **무엇으로 좁혀야 하는지**가 답이다.
            const cands = res.body ? parseCandidates(res.body) : []
            reason =
              res.error +
              (cands.length > 0
                ? ` 후보: ${cands.map((c) => `path:"${c.path}"`).join(', ')}`
                : '')
            break
          }
          reason = `"${step.text}" 을 큐에 넣었다.`
          break
        }
        case 'openRecent': {
          const res = await call(pid, {
            id: i + 1,
            op: 'trigger',
            text: step.fileName,
            path: RECENT_FILES_PATH,
          })
          if (!res.ok) {
            outcome = 'fail'
            reason = res.error
            break
          }
          // **문서 이름이 바뀔 때까지 기다린다.** 여는 동안 진행 다이얼로그가 8초쯤
          // 떠 있고 그 사이 `doc` 은 아직 옛 파일명을 보고한다 (2026-09-10 실측).
          // 화면 변화나 idle 로 판정하면 너무 일찍 통과한다.
          const w = await waitForDocument(filter, step.fileName, step.timeoutMs ?? OPEN_TIMEOUT_MS)
          outcome = w.ok ? 'pass' : 'fail'
          reason = w.reason
          break
        }
        case 'grabPanel': {
          const c = await grabWidget(
            join(outDir, `${String(i + 1).padStart(2, '0')}-${slug(step.label)}`),
            pid,
            step.objectName,
          )
          artifacts.push(c.png)
          reason = `${step.objectName} ${c.meta.width}x${c.meta.height} 를 ${c.png} 에 남겼다.`
          break
        }
        case 'setAction': {
          const found = await findOneAction(pid, step.text, step.path)
          if (!found.ok) {
            outcome = 'fail'
            reason = found.reason
            break
          }
          if (!found.action.checkable) {
            outcome = 'fail'
            reason = `"${step.text}" 은 켜고 끄는 명령이 아니다. 부르려면 trigger 를 쓴다.`
            break
          }
          if (found.action.checked === step.checked) {
            // **아무것도 하지 않는다.** 토글을 무턱대고 부르면 원하는 상태에서
            // 벗어난다 — 사전 조건을 만들려는 단계가 사전 조건을 깨뜨리게 된다.
            reason = `이미 ${step.checked ? '켬' : '끔'} 이다. 부르지 않았다.`
            break
          }
          const fired = await call(pid, {
            id: i + 1,
            op: 'trigger',
            text: step.text,
            ...(step.path !== undefined ? { path: step.path } : {}),
          })
          if (!fired.ok) {
            outcome = 'fail'
            reason = fired.error
            break
          }
          // trigger 는 큐에 들어가므로 상태가 바뀔 때까지 다시 물어본다.
          const w = await waitForChecked(
            pid,
            step.text,
            step.path,
            step.checked,
            step.timeoutMs ?? TRIGGER_SETTLE_MS,
          )
          outcome = w.ok ? 'pass' : 'fail'
          reason = w.reason
          break
        }
        case 'expectAction': {
          const res = await call(pid, { id: i + 1, op: 'actions' })
          if (!res.ok) {
            outcome = 'fail'
            reason = res.error
            break
          }
          const all = parseActions(res.body)
          const hits = all.filter(
            (a) => a.text === step.text && (step.path === undefined || a.path === step.path),
          )
          if (step.present === false) {
            outcome = hits.length === 0 ? 'pass' : 'fail'
            reason =
              hits.length === 0
                ? `"${step.text}" 이 없다 — 기대한 대로다.`
                : `"${step.text}" 이 ${hits.length}개 있다. 없어야 한다.`
            break
          }
          if (hits.length === 0) {
            outcome = 'fail'
            reason = `"${step.text}" 인 명령이 없다.`
            break
          }
          if (hits.length > 1) {
            // 여럿이면 어느 것의 상태를 본 것인지 알 수 없다. **조용히 첫 번째를
            // 고르면 다른 명령의 상태로 통과한다.**
            outcome = 'fail'
            reason =
              `"${step.text}" 이 ${hits.length}개다. path 로 좁힌다: ` +
              hits.map((h) => `"${h.path}"`).join(', ')
            break
          }
          const a = hits[0]!
          const bad: string[] = []
          if (step.enabled !== undefined && a.enabled !== step.enabled) {
            bad.push(`enabled 가 ${a.enabled} 인데 ${step.enabled} 를 기대했다`)
          }
          if (step.checked !== undefined) {
            if (!a.checkable) {
              bad.push('checkable 이 아닌 명령의 checked 를 기대했다')
            } else if (a.checked !== step.checked) {
              bad.push(`checked 가 ${a.checked} 인데 ${step.checked} 를 기대했다`)
            }
          }
          outcome = bad.length === 0 ? 'pass' : 'fail'
          reason =
            bad.length === 0
              ? `"${a.text}"${a.path ? ` (경로 "${a.path}")` : ''} enabled=${a.enabled}` +
                `${a.checkable ? ` checked=${a.checked}` : ''}`
              : bad.join(', ')
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
        const afterBase = join(outDir, `${String(i + 1).padStart(2, '0')}-after`)
        // **`trigger` 는 큐에 들어간다.** 응답이 와도 아직 실행 전일 수 있으므로
        // 바로 찍으면 "안 바뀌었다" 로 거짓 실패한다. 바뀔 때까지 상한을 두고 다시
        // 찍는다. `key`·`click` 은 동기적으로 전달되므로 이 대기가 필요 없다 —
        // 실앱 10단계 시나리오가 즉시 캡처로 10/10 통과했다(2026-09-09).
        const settleMs = step.do === 'trigger' ? TRIGGER_SETTLE_MS : 0
        const deadline = Date.now() + settleMs
        let after = capture(afterBase, filter)
        let v = judgeChanged(diff(before.img, after.img))
        while (!v.changed && Date.now() < deadline) {
          await sleep(200)
          after = capture(afterBase, filter)
          v = judgeChanged(diff(before.img, after.img))
        }
        artifacts.push(after.png)
        transient.push(afterBase)
        if (!v.changed) {
          outcome = 'fail'
          reason = `${reason} 그런데 ${settleMs > 0 ? `${settleMs}ms 를 기다려도 ` : ''}${v.reason}`
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
    } else {
      pruneRaw(transient)
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
