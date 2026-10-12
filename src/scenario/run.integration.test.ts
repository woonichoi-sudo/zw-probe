// 2단 픽스처 통합 테스트 — 시나리오 러너를 **Z-Weave 없이** 돌린다.
//
// **여기까지 없었다.** 러너는 지금까지 실앱으로만 확인했는데, 실앱 왕복은 재시작
// 90초라 반복할 수 없다. M5 로 붙은 단계(`trigger`·`grabPanel`·`expectAction`)는
// 전부 I/O 이므로 순수 테스트로는 못 잡는다 — 픽스처가 그 사이를 메운다.
//
//   node --test src/scenario/run.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QTAPP_EXE, ZWAGENT_DLL, qtEnv, qtFilter, qtFixtureMissing, windowsOnly } from '../win/qtFixture.ts'
import { listWindows } from '../win/zwwin.ts'
import { parseAgentHello } from '../agent/hello.ts'
import { runScenario } from './run.ts'
import type { Scenario } from './steps.ts'

const skip =
  qtFixtureMissing() ||
  (existsSync(ZWAGENT_DLL)
    ? false
    : `${ZWAGENT_DLL} 가 없다. bash tools/zwagent/build.sh 를 먼저 실행한다.`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Fixture = {
  pid: number
  dir: string
  kill: () => void
}

/** 픽스처를 띄우고 창과 (플러그인을 얹었으면) hello 가 나올 때까지 기다린다. */
async function startFixture(withAgent: boolean): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-runner-'))
  const hello = join(dir, 'hello.json')
  const child = spawn(QTAPP_EXE, withAgent ? ['-style', 'zwagent'] : [], {
    detached: false,
    stdio: 'ignore',
    env: qtEnv({ ZWAGENT_HELLO: hello }),
  })
  assert.ok(child.pid !== undefined, '픽스처 프로세스를 띄우지 못했다')
  const pid = child.pid!
  const kill = () => {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }

  const deadline = Date.now() + 20000
  let windowUp = false
  while (Date.now() < deadline) {
    if (!windowUp && listWindows(qtFilter(pid)).some((w) => w.width > 0)) windowUp = true
    if (windowUp && !withAgent) return { pid, dir, kill }
    if (windowUp && existsSync(hello)) {
      try {
        // 파이프가 열렸다고 보고할 때까지 기다린다 — 그 전에 시나리오를 돌리면
        // 러너가 정당하게 거부하고, 그건 이 테스트가 보려는 것이 아니다.
        const p = parseAgentHello(JSON.parse(readFileSync(hello, 'utf8')))
        if (p.ok && p.hello.pipeListening) return { pid, dir, kill }
      } catch {
        /* 쓰는 중 */
      }
    }
    await sleep(200)
  }
  kill()
  throw new Error(`픽스처가 20초 안에 준비되지 않았다 (agent=${withAgent})`)
}

function scenario(steps: Scenario['steps'], name = '러너 통합'): Scenario {
  return { name, what: '명령 채널 단계가 실제로 도는지 확인한다', steps }
}

test('시나리오가 trigger 로 화면을 바꾸고 grabPanel 로 패널을 남긴다', { skip }, async () => {
  const fx = await startFixture(true)
  const out = mkdtempSync(join(tmpdir(), 'zwprobe-out-'))
  try {
    const r = await runScenario(
      scenario([
        // 부르기 전 상태를 사실로 확인한다 — 픽셀이 아니라 액션 상태로 본다
        { do: 'expectAction', text: 'Mark', path: 'Fixture', enabled: true },
        { do: 'expectAction', text: 'Disabled', path: 'Other', enabled: false },
        { do: 'grabPanel', objectName: 'centralArea', label: '전' },
        // **여기가 본론이다.** trigger 는 큐에 들어가므로 러너가 화면이 바뀔 때까지
        // 기다려야 한다. 안 기다리면 "안 바뀌었다" 로 거짓 실패한다.
        { do: 'trigger', text: 'Mark', path: 'Fixture' },
        { do: 'grabPanel', objectName: 'centralArea', label: '후' },
      ]),
      { filter: qtFilter(fx.pid), outDir: out, baselineDir: join(fx.dir, 'baselines') },
    )

    assert.equal(r.rejected, null, `거부됐다: ${JSON.stringify(r.rejected)}`)
    assert.equal(r.summary.failed, 0, r.summary.lines.join('\n'))
    assert.equal(r.summary.passed, 5, r.summary.lines.join('\n'))

    // 패널 캡처가 실제로 남았고 전후가 다르다
    const before = join(out, '03-전.png')
    const after = join(out, '05-후.png')
    assert.ok(existsSync(before), `${before} 가 없다`)
    assert.ok(existsSync(after), `${after} 가 없다`)
  } finally {
    fx.kill()
    rmSync(out, { recursive: true, force: true })
  }
})

test('checkBaseline 이 창 대신 패널만 비교한다', { skip }, async () => {
  const fx = await startFixture(true)
  const out = mkdtempSync(join(tmpdir(), 'zwprobe-out-'))
  const baselines = join(fx.dir, 'baselines')
  mkdirSync(baselines, { recursive: true })
  try {
    // ① 지금 패널을 baseline 으로 뜬다 (사람이 `zwprobe baseline` 으로 하는 일)
    const first = await runScenario(
      scenario([{ do: 'grabPanel', objectName: 'centralArea', label: 'panel' }], 'baseline 뜨기'),
      { filter: qtFilter(fx.pid), outDir: out, baselineDir: baselines },
    )
    assert.equal(first.rejected, null, `거부됐다: ${JSON.stringify(first.rejected)}`)
    assert.equal(first.summary.failed, 0, first.summary.lines.join('\n'))
    for (const ext of ['png', 'bgra', 'json']) {
      copyFileSync(join(out, `01-panel.${ext}`), join(baselines, `panel.${ext}`))
    }

    // ② 아무것도 안 바꿨으니 같아야 한다
    const same = await runScenario(
      scenario([{ do: 'checkBaseline', baseline: 'panel', panel: 'centralArea' }], '같은지'),
      { filter: qtFilter(fx.pid), outDir: join(out, 'same'), baselineDir: baselines },
    )
    assert.equal(same.rejected, null, `거부됐다: ${JSON.stringify(same.rejected)}`)
    assert.equal(same.summary.failed, 0, same.summary.lines.join('\n'))

    // ③ 패널을 바꾸면 다르다고 해야 한다. **안 그러면 이 검사는 늘 통과하는 검사다.**
    const changed = await runScenario(
      scenario(
        [
          { do: 'trigger', text: 'Mark', path: 'Fixture' },
          { do: 'checkBaseline', baseline: 'panel', panel: 'centralArea' },
        ],
        '달라졌는지',
      ),
      { filter: qtFilter(fx.pid), outDir: join(out, 'diff'), baselineDir: baselines },
    )
    assert.equal(changed.rejected, null, `거부됐다: ${JSON.stringify(changed.rejected)}`)
    assert.equal(changed.summary.failed, 1, changed.summary.lines.join('\n'))
    assert.equal(changed.summary.firstFailure?.stepIndex, 1)
  } finally {
    fx.kill()
    rmSync(out, { recursive: true, force: true })
  }
})

test('명령 이름 오타를 앱을 건드리기 전에 거부한다', { skip }, async () => {
  // **이것이 단계를 데이터로 둔 이유다** (steps.ts 머리말 ①). 절차 중간에서
  // 오타를 발견하면 앱은 이미 반쯤 조작된 상태이고 되돌릴 수 없다.
  const fx = await startFixture(true)
  const out = mkdtempSync(join(tmpdir(), 'zwprobe-out-'))
  try {
    const r = await runScenario(
      scenario([
        { do: 'trigger', text: 'Mark', path: 'Fixture' },
        { do: 'trigger', text: 'Marrk', path: 'Fixture' },
      ]),
      { filter: qtFilter(fx.pid), outDir: out, baselineDir: join(fx.dir, 'baselines') },
    )
    assert.notEqual(r.rejected, null, '오타를 거부해야 한다')
    assert.equal(r.results.length, 0, '거부됐으면 아무 단계도 실행하지 않아야 한다')
    assert.ok(
      r.rejected!.some((m) => m.includes('Marrk')),
      `거부 이유에 오타 이름이 있어야 한다: ${JSON.stringify(r.rejected)}`,
    )
    // 앞 단계(정상인 Mark)도 실행되지 않았어야 한다 — 화면이 안 바뀐 것으로 확인한다
    assert.ok(!existsSync(join(out, '01-before.png')), '거부됐는데 캡처가 남았다')
  } finally {
    fx.kill()
    rmSync(out, { recursive: true, force: true })
  }
})

test('파이프가 없으면 시작 전에 거부하고 이유를 말한다', { skip: skip || windowsOnly('플러그인 없이 띄운 창은 macOS 에서 관찰할 수 없다') }, async () => {
  // 플러그인 없이 띄운 픽스처. 절차 중간에서 알면 앱은 이미 반쯤 조작된 상태다.
  const fx = await startFixture(false)
  const out = mkdtempSync(join(tmpdir(), 'zwprobe-out-'))
  try {
    const r = await runScenario(
      scenario([{ do: 'trigger', text: 'Mark', path: 'Fixture' }]),
      { filter: qtFilter(fx.pid), outDir: out, baselineDir: join(fx.dir, 'baselines') },
    )
    assert.notEqual(r.rejected, null, '파이프가 없으면 거부해야 한다')
    assert.equal(r.results.length, 0)
    assert.ok(
      r.rejected!.some((m) => m.includes('파이프')),
      `무엇이 없는지 말해야 한다: ${JSON.stringify(r.rejected)}`,
    )
    assert.ok(
      r.rejected!.some((m) => m.includes('-style zwagent')),
      `무엇을 해야 하는지 말해야 한다: ${JSON.stringify(r.rejected)}`,
    )
  } finally {
    fx.kill()
    rmSync(out, { recursive: true, force: true })
  }
})

test('setAction 이 토글을 원하는 상태로 맞추고, 이미 그 상태면 건드리지 않는다', { skip }, async () => {
  // **`trigger` 로는 사전 조건을 만들 수 없다.** 토글을 무턱대고 부르면 이미 켜져
  // 있을 때 꺼진다 — 사전 조건을 만들려는 단계가 사전 조건을 깨뜨린다.
  const fx = await startFixture(true)
  const out = mkdtempSync(join(tmpdir(), 'zwprobe-out-'))
  try {
    const r = await runScenario(
      scenario([
        // 처음엔 꺼져 있다
        { do: 'expectAction', text: 'Highlight', path: 'Fixture', checked: false },
        // 켠다 — 왼쪽 위가 노랗게 바뀐다
        { do: 'setAction', text: 'Highlight', path: 'Fixture', checked: true },
        { do: 'expectAction', text: 'Highlight', path: 'Fixture', checked: true },
        // **여기가 본론이다.** 이미 켜져 있으므로 부르면 안 된다.
        { do: 'setAction', text: 'Highlight', path: 'Fixture', checked: true },
        { do: 'expectAction', text: 'Highlight', path: 'Fixture', checked: true },
        // 끄는 것도 된다
        { do: 'setAction', text: 'Highlight', path: 'Fixture', checked: false },
        { do: 'expectAction', text: 'Highlight', path: 'Fixture', checked: false },
      ]),
      { filter: qtFilter(fx.pid), outDir: out, baselineDir: join(fx.dir, 'baselines') },
    )
    assert.equal(r.rejected, null, `거부됐다: ${JSON.stringify(r.rejected)}`)
    assert.equal(r.summary.failed, 0, r.summary.lines.join('\n'))
    // 네 번째 단계가 "부르지 않았다" 여야 한다 — 이것이 멱등의 증거다
    assert.match(r.results[3]!.reason, /부르지 않았다/, r.results[3]!.reason)
    assert.match(r.results[1]!.reason, /켰다/, r.results[1]!.reason)
    assert.match(r.results[5]!.reason, /껐다/, r.results[5]!.reason)
  } finally {
    fx.kill()
    rmSync(out, { recursive: true, force: true })
  }
})

test('setAction 은 토글이 아닌 명령을 거부한다', { skip }, async () => {
  // 토글이 아닌 것에 checked 를 기대하면 무엇을 하려는지 모호하다.
  const fx = await startFixture(true)
  const out = mkdtempSync(join(tmpdir(), 'zwprobe-out-'))
  try {
    const r = await runScenario(
      scenario([{ do: 'setAction', text: 'Mark', path: 'Fixture', checked: true }]),
      { filter: qtFilter(fx.pid), outDir: out, baselineDir: join(fx.dir, 'baselines') },
    )
    assert.equal(r.rejected, null, `거부됐다: ${JSON.stringify(r.rejected)}`)
    assert.equal(r.summary.failed, 1, r.summary.lines.join('\n'))
    assert.match(r.summary.firstFailure!.reason, /켜고 끄는 명령이 아니다/)
  } finally {
    fx.kill()
    rmSync(out, { recursive: true, force: true })
  }
})
