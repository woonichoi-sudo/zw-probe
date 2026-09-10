// 1단 순수 단위 테스트 — 의존성 0. 실앱도 픽스처도 필요 없다.
//
//   node --test src/scenario/steps.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SLEEP_MS,
  describeStep,
  isAction,
  needsAgent,
  summarizeRun,
  validateScenario,
  wantsChange,
} from './steps.ts'
import type { Scenario, Step, StepResult } from './steps.ts'

function sc(steps: Step[], p: Partial<Scenario> = {}): Scenario {
  return { name: p.name ?? '테스트', what: p.what ?? '무언가를 확인한다', steps }
}

const SHORTCUTS = ['SimulationStart', 'MainUndo', 'CameraFit', 'SidePanel']

test('validateScenario — 온전한 시나리오는 문제가 없다', () => {
  const errors = validateScenario(
    sc([
      { do: 'waitIdle' },
      { do: 'shot', label: 'before' },
      { do: 'key', shortcut: 'SidePanel' },
      { do: 'expectDoc', dirty: false },
    ]),
    { shortcutNames: SHORTCUTS },
  )
  assert.deepEqual(errors, [])
})

test('validateScenario — 문제를 하나씩이 아니라 전부 모아 돌려준다', () => {
  // 하나씩 고치게 하면 오타 열 개를 잡는 데 열 번 실행해야 하고, 실행이 비싸다.
  const errors = validateScenario(
    sc([
      { do: 'key', shortcut: '없는기능' },
      { do: 'click', x: -1, y: 5 },
      { do: 'sleep', ms: 100, why: '' },
    ]),
    { shortcutNames: SHORTCUTS },
  )
  assert.equal(errors.length, 3)
  assert.deepEqual(
    errors.map((e) => e.stepIndex),
    [0, 1, 2],
  )
})

test('validateScenario — 없는 단축키 이름을 시작 전에 잡는다', () => {
  // 틀린 키는 무동작이 아니라 다른 명령 실행이다 (2026-09-09 실측).
  const errors = validateScenario(sc([{ do: 'key', shortcut: 'SimulatoinStart' }]), {
    shortcutNames: SHORTCUTS,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /SimulatoinStart/)
  assert.match(errors[0]!.message, /shortcuts --filter/)
})

test('validateScenario — 단축키 목록을 안 주면 이름 검사를 건너뛴다', () => {
  assert.deepEqual(validateScenario(sc([{ do: 'key', shortcut: '아무거나' }])), [])
})

test('validateScenario — 시나리오 자체의 문제는 stepIndex -1', () => {
  const errors = validateScenario({ name: '', what: '', steps: [] })
  assert.equal(errors.length, 3)
  assert.ok(errors.every((e) => e.stepIndex === -1))
  assert.ok(errors.some((e) => /name/.test(e.message)))
  assert.ok(errors.some((e) => /what/.test(e.message)))
  assert.ok(errors.some((e) => /단계가 없다/.test(e.message)))
})

test('validateScenario — sleep 은 why 를 요구한다', () => {
  // sleep 은 재현성을 깨뜨리므로 왜 waitIdle 로 안 되는지 적게 강제한다.
  assert.equal(validateScenario(sc([{ do: 'sleep', ms: 500, why: '' }])).length, 1)
  assert.deepEqual(
    validateScenario(sc([{ do: 'sleep', ms: 500, why: 'GPU 첫 프레임이 늦다' }])),
    [],
  )
})

test('validateScenario — sleep 상한을 넘으면 거부한다', () => {
  const errors = validateScenario(sc([{ do: 'sleep', ms: MAX_SLEEP_MS + 1, why: '오래 걸린다' }]))
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /waitIdle/)
})

test('validateScenario — 좌표는 정수이고 음수가 아니어야 한다', () => {
  assert.equal(validateScenario(sc([{ do: 'click', x: 1.5, y: 2 }])).length, 1)
  assert.equal(validateScenario(sc([{ do: 'click', x: 1, y: -2 }])).length, 1)
  assert.deepEqual(validateScenario(sc([{ do: 'click', x: 0, y: 0 }])), [])
})

test('validateScenario — clickName 은 조건이 하나는 있어야 한다', () => {
  assert.equal(validateScenario(sc([{ do: 'clickName' }])).length, 1)
  assert.deepEqual(validateScenario(sc([{ do: 'clickName', id: 'tabCloseButton' }])), [])
})

test('validateScenario — shot label 은 파일 이름이 될 수 있어야 한다', () => {
  assert.equal(validateScenario(sc([{ do: 'shot', label: 'a/b' }])).length, 1)
  assert.equal(validateScenario(sc([{ do: 'shot', label: '' }])).length, 1)
  assert.deepEqual(validateScenario(sc([{ do: 'shot', label: '시뮬_후-1.차' }])), [])
})

test('validateScenario — 없는 baseline 참조를 시작 전에 잡는다', () => {
  const errors = validateScenario(sc([{ do: 'checkBaseline', baseline: '빈씬' }]), {
    baselineNames: ['다른것'],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /baseline --save 빈씬/)
})

test('validateScenario — maxChangedRatio 는 0..1', () => {
  assert.equal(
    validateScenario(sc([{ do: 'checkBaseline', baseline: 'x', maxChangedRatio: 1.5 }])).length,
    1,
  )
  assert.deepEqual(
    validateScenario(sc([{ do: 'checkBaseline', baseline: 'x', maxChangedRatio: 0.01 }])),
    [],
  )
})

test('validateScenario — ignore 사각형이 이상하면 잡는다', () => {
  const bad = [
    { x: 0, y: 0, width: 0, height: 5 },
    { x: -1, y: 0, width: 5, height: 5 },
    { x: 0, y: 0, width: 5.5, height: 5 },
  ]
  for (const r of bad) {
    assert.equal(
      validateScenario(sc([{ do: 'checkBaseline', baseline: 'x', ignore: [r] }])).length,
      1,
      `${JSON.stringify(r)} 는 거부해야 한다`,
    )
  }
})

test('validateScenario — expectDoc 은 확인할 것이 하나는 있어야 한다', () => {
  assert.equal(validateScenario(sc([{ do: 'expectDoc' }])).length, 1)
  assert.deepEqual(validateScenario(sc([{ do: 'expectDoc', fileName: 'Untitled.zls' }])), [])
})

test('validateScenario — 알 수 없는 단계를 조용히 넘기지 않는다', () => {
  // 넘기면 시나리오가 통과했다고 착각한다.
  const errors = validateScenario(sc([{ do: '없는동작' } as unknown as Step]))
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /알 수 없는 단계/)
})

test('isAction / wantsChange — 동작 단계의 기본은 "바뀌어야 한다"', () => {
  assert.equal(isAction({ do: 'key', shortcut: 'SidePanel' }), true)
  assert.equal(isAction({ do: 'shot', label: 'x' }), false)

  assert.equal(wantsChange({ do: 'key', shortcut: 'SidePanel' }), true)
  assert.equal(wantsChange({ do: 'key', shortcut: 'SidePanel', expectChange: false }), false)
  // 동작이 아닌 단계에는 전후 비교를 붙이지 않는다
  assert.equal(wantsChange({ do: 'waitIdle' }), false)
  assert.equal(wantsChange({ do: 'shot', label: 'x' }), false)
})

test('describeStep — 모든 단계가 한 줄로 설명된다', () => {
  const steps: Step[] = [
    { do: 'key', shortcut: 'CameraFit' },
    { do: 'click', x: 10, y: 20 },
    { do: 'click', x: 10, y: 20, button: 'right', double: true },
    { do: 'clickName', name: 'Simulation' },
    { do: 'clickName', id: 'tabCloseButton', class: 'QPushButton' },
    { do: 'waitIdle' },
    { do: 'waitIdle', timeoutMs: 12000 },
    { do: 'sleep', ms: 300, why: '첫 프레임' },
    { do: 'shot', label: 'after' },
    { do: 'checkBaseline', baseline: '빈씬' },
    { do: 'checkBaseline', baseline: '빈씬', ignore: [{ x: 0, y: 0, width: 2, height: 2 }] },
    { do: 'expectDoc', fileName: 'a.zls', dirty: true },
    { do: 'expectElement', name: 'Fabric' },
    { do: 'expectElement', id: 'x', present: false },
  ]
  for (const s of steps) {
    const d = describeStep(s)
    assert.ok(d.length > 0, `${s.do} 설명이 비었다`)
    assert.doesNotMatch(d, /undefined/, `${s.do} 설명에 undefined 가 새어나왔다: ${d}`)
  }
  assert.equal(describeStep({ do: 'key', shortcut: 'CameraFit' }), 'key CameraFit')
  assert.match(describeStep({ do: 'sleep', ms: 300, why: '첫 프레임' }), /첫 프레임/)
  assert.match(describeStep({ do: 'click', x: 10, y: 20, double: true }), /×2/)
  assert.match(describeStep({ do: 'waitIdle' }), /5000ms/)
})

function result(p: Partial<StepResult> & { stepIndex: number; outcome: StepResult['outcome'] }): StepResult {
  return {
    stepIndex: p.stepIndex,
    description: p.description ?? `단계${p.stepIndex}`,
    outcome: p.outcome,
    reason: p.reason ?? '이유',
    elapsedMs: p.elapsedMs ?? 10,
  }
}

test('summarizeRun — 개수를 센다', () => {
  const s = summarizeRun(sc([]), [
    result({ stepIndex: 0, outcome: 'pass' }),
    result({ stepIndex: 1, outcome: 'fail' }),
    result({ stepIndex: 2, outcome: 'skipped' }),
    result({ stepIndex: 3, outcome: 'skipped' }),
  ])
  assert.equal(s.passed, 1)
  assert.equal(s.failed, 1)
  assert.equal(s.skipped, 2)
})

test('summarizeRun — 첫 실패만 원인으로 취급한다', () => {
  // 두 번째 실패는 첫 실패가 남긴 상태의 결과일 가능성이 높다.
  const s = summarizeRun(sc([]), [
    result({ stepIndex: 0, outcome: 'fail', description: '첫째', reason: '진짜 원인' }),
    result({ stepIndex: 1, outcome: 'fail', description: '둘째', reason: '파생' }),
  ])
  assert.equal(s.firstFailure?.description, '첫째')
  assert.ok(s.lines.some((l) => /첫 실패/.test(l) && /진짜 원인/.test(l)))
  assert.ok(!s.lines.some((l) => /첫 실패/.test(l) && /파생/.test(l)))
})

test('summarizeRun — 전부 통과하면 첫 실패가 없다', () => {
  const s = summarizeRun(sc([]), [result({ stepIndex: 0, outcome: 'pass' })])
  assert.equal(s.firstFailure, null)
  assert.ok(!s.lines.some((l) => /첫 실패/.test(l)))
})

test('summarizeRun — 통과한 단계의 근거도 줄에 싣는다', () => {
  // 성공한 근거를 안 보여주면 "통과했다" 를 믿을 수 없다.
  const s = summarizeRun(sc([]), [
    result({ stepIndex: 0, outcome: 'pass', description: 'key SidePanel', reason: '화면이 달라졌다' }),
  ])
  assert.ok(s.lines.some((l) => /key SidePanel/.test(l) && /화면이 달라졌다/.test(l)))
})

test('summarizeRun — 머리에 시나리오 이름과 확인 내용을 싣는다', () => {
  const s = summarizeRun(sc([], { name: '패널 토글', what: 'Shift+P 로 오른쪽 패널이 사라진다' }), [])
  assert.match(s.lines[0]!, /패널 토글/)
  assert.match(s.lines[1]!, /오른쪽 패널이 사라진다/)
})

test('summarizeRun — 단계 번호는 1부터 보인다', () => {
  // 사람이 세는 방식과 맞춘다. 내부는 0부터다.
  const s = summarizeRun(sc([]), [result({ stepIndex: 0, outcome: 'fail', description: 'x' })])
  assert.ok(s.lines.some((l) => /첫 실패   1번째/.test(l)))
})

test('validateScenario — expectPanel 은 확인할 것이 하나는 있어야 한다', () => {
  assert.equal(validateScenario(sc([{ do: 'expectPanel' }])).length, 1)
  assert.deepEqual(validateScenario(sc([{ do: 'expectPanel', dockId: 'avatar' }])), [])
  assert.deepEqual(validateScenario(sc([{ do: 'expectPanel', tabName: 'Avatar' }])), [])
})

test('describeStep — expectPanel', () => {
  assert.equal(describeStep({ do: 'expectPanel', dockId: 'avatar' }), 'expectPanel dock=avatar')
  assert.equal(
    describeStep({ do: 'expectPanel', dockId: 'avatar', tabName: 'Avatar' }),
    'expectPanel dock=avatar 탭="Avatar"',
  )
  assert.doesNotMatch(describeStep({ do: 'expectPanel', tabName: 'Avatar' }), /undefined/)
})

test('expectPanel 은 동작 단계가 아니다 — 전후 비교를 붙이지 않는다', () => {
  assert.equal(isAction({ do: 'expectPanel', dockId: 'avatar' }), false)
  assert.equal(wantsChange({ do: 'expectPanel', dockId: 'avatar' }), false)
})

// ── 명령 채널 단계 (M5) ────────────────────────────────────────────────────

/** 실앱에서 실제로 나온 이름들. Import 와 Export 밑에 같은 이름이 있다. */
const ACTIONS = [
  'Simulation',
  'Grading',
  'Reset layout',
  'W_PK shirt & Long skirt.zls',
  'sample.zls',
  'OBJ',
]

test('needsAgent — 파이프가 있어야 도는 단계를 가려낸다', () => {
  // 시작 전에 알아야 한다. 절차 중간에서 파이프가 없는 것을 알면 앱은 이미
  // 반쯤 조작된 상태다.
  assert.equal(needsAgent({ do: 'trigger', text: 'X' }), true)
  assert.equal(needsAgent({ do: 'openRecent', fileName: 'a.zls' }), true)
  assert.equal(needsAgent({ do: 'grabPanel', objectName: 'p', label: 'l' }), true)
  assert.equal(needsAgent({ do: 'expectAction', text: 'X' }), true)
  assert.equal(needsAgent({ do: 'key', shortcut: 'MainUndo' }), false)
  assert.equal(needsAgent({ do: 'shot', label: 'x' }), false)
})

test('needsAgent — checkBaseline 은 panel 을 줄 때만 파이프가 필요하다', () => {
  assert.equal(needsAgent({ do: 'checkBaseline', baseline: 'b' }), false)
  assert.equal(needsAgent({ do: 'checkBaseline', baseline: 'b', panel: 'dock_x' }), true)
})

test('isAction — trigger 는 화면을 바꾸는 단계다', () => {
  // 전후 비교가 붙어야 "불렀는데 아무 일도 안 일어났다" 를 잡는다.
  assert.equal(isAction({ do: 'trigger', text: 'X' }), true)
  assert.equal(wantsChange({ do: 'trigger', text: 'X' }), true)
  assert.equal(wantsChange({ do: 'trigger', text: 'X', expectChange: false }), false)
  // openRecent 는 자기 완료 신호(문서 이름)가 따로 있으므로 전후 비교를 안 붙인다
  assert.equal(isAction({ do: 'openRecent', fileName: 'a.zls' }), false)
})

test('validateScenario — 명령 이름 오타를 시작 전에 잡는다', () => {
  // 틀린 이름은 무동작이 아니라 거부다. 절차 중간에서 거부되면 앱은 이미
  // 반쯤 조작된 상태이고 되돌릴 수 없다.
  const errors = validateScenario(sc([{ do: 'trigger', text: 'Simulaton' }]), {
    actionTexts: ACTIONS,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /Simulaton/)
  assert.match(errors[0]!.message, /agent --actions/)
})

test('validateScenario — 목록을 못 받았으면 이름 검사를 건너뛴다', () => {
  // 파이프가 없으면 목록이 없다. 그때 전부 오타로 거부하면 시나리오를 못 쓴다.
  assert.deepEqual(validateScenario(sc([{ do: 'trigger', text: '아무거나' }])), [])
})

test('validateScenario — openRecent 의 파일명도 목록으로 검증한다', () => {
  // 최근 파일은 앱이 관리하므로 목록에 없으면 열 수 없다.
  const ok = validateScenario(sc([{ do: 'openRecent', fileName: 'sample.zls' }]), {
    actionTexts: ACTIONS,
  })
  assert.deepEqual(ok, [])
  const bad = validateScenario(sc([{ do: 'openRecent', fileName: 'sampl.zls' }]), {
    actionTexts: ACTIONS,
  })
  assert.equal(bad.length, 1)
})

test('validateScenario — expectAction present:false 는 이름을 검증하지 않는다', () => {
  // 없어야 하는 이름이 목록에 없는 것은 정상이다. 그걸 오타로 거부하면
  // 이 단계를 아예 쓸 수 없다.
  const errors = validateScenario(
    sc([{ do: 'expectAction', text: '있으면안되는명령', present: false }]),
    { actionTexts: ACTIONS },
  )
  assert.deepEqual(errors, [])
})

test('validateScenario — present:false 와 상태 기대를 함께 주면 거부한다', () => {
  const errors = validateScenario(
    sc([{ do: 'expectAction', text: 'X', present: false, checked: true }]),
    {},
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /함께 줄 수 없다/)
})

test('validateScenario — 빈 이름을 거부한다', () => {
  const errors = validateScenario(
    sc([
      { do: 'trigger', text: '  ' },
      { do: 'openRecent', fileName: '' },
      { do: 'grabPanel', objectName: '', label: '' },
      { do: 'expectAction', text: '' },
    ]),
    {},
  )
  assert.equal(errors.length, 5, `실제: ${JSON.stringify(errors)}`)
})

test('validateScenario — grabPanel label 은 파일 이름이 된다', () => {
  const errors = validateScenario(
    sc([{ do: 'grabPanel', objectName: 'dock_x', label: 'a/b:c' }]),
    {},
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /파일 이름으로 쓸 수 없는/)
})

test('describeStep — 새 단계도 한 줄로 읽힌다', () => {
  assert.equal(describeStep({ do: 'trigger', text: 'Grading' }), 'trigger "Grading"')
  assert.equal(
    describeStep({ do: 'trigger', text: 'OBJ', path: 'File > Import' }),
    'trigger "OBJ" (경로 "File > Import")',
  )
  assert.equal(describeStep({ do: 'openRecent', fileName: 'sample.zls' }), 'openRecent "sample.zls"')
  assert.equal(
    describeStep({ do: 'grabPanel', objectName: 'dock_simulation', label: '패널' }),
    'grabPanel dock_simulation → "패널"',
  )
  assert.equal(
    describeStep({ do: 'expectAction', text: 'Grading', checked: true }),
    'expectAction "Grading" checked=true',
  )
  assert.equal(
    describeStep({ do: 'checkBaseline', baseline: 'b', panel: 'dock_x' }),
    'checkBaseline b (패널 dock_x)',
  )
})

test('needsAgent — setAction 도 파이프가 필요하다', () => {
  assert.equal(needsAgent({ do: 'setAction', text: 'X', checked: true }), true)
})

test('isAction — setAction 은 전후 비교를 붙이지 않는다', () => {
  // **이미 그 상태면 아무것도 안 한다.** 화면이 안 바뀌는 것이 정상이므로
  // 전후 비교를 붙이면 멱등한 실행이 실패로 나온다.
  assert.equal(isAction({ do: 'setAction', text: 'X', checked: true }), false)
  assert.equal(wantsChange({ do: 'setAction', text: 'X', checked: true }), false)
})

test('validateScenario — setAction 도 이름을 검증한다', () => {
  const errors = validateScenario(sc([{ do: 'setAction', text: 'Gradingg', checked: true }]), {
    actionTexts: ACTIONS,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /Gradingg/)
})

test('describeStep — setAction 은 목표 상태를 보여준다', () => {
  assert.equal(
    describeStep({ do: 'setAction', text: 'Grading', path: 'Window > UI panels', checked: true }),
    'setAction "Grading" (경로 "Window > UI panels") → 켬',
  )
  assert.equal(describeStep({ do: 'setAction', text: 'X', checked: false }), 'setAction "X" → 끔')
})
