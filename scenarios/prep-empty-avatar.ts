// 사전 조건을 **시나리오가 스스로 만든다.** 빈 씬을 열고 Avatar 패널을 켠다.
//
// **왜 따로 있는가.** 지금까지 시나리오는 "사람이 Avatar 탭을 켜두고 Untitled.zls 를
// 열어둔 상태" 를 전제하고 아니면 거부했다. 앱은 사람과 공유하므로 그 전제가
// 실행 사이사이에 깨졌다 — 2026-09-09 에 실제로 탭이 바뀌어 baseline 이 무효가 됐다.
// M5 의 명령 채널로 이제 **만들 수 있다.**
//
// 이 파일은 두 가지로 쓰인다.
//   ① 단독 실행 — 준비가 되는지만 확인한다. baseline 이 없어도 돈다
//   ② [panel-toggle-auto.ts](./panel-toggle-auto.ts) 가 앞부분으로 가져다 쓴다
//
// ②가 이 파일이 존재하는 이유다. 준비 절차를 두 벌로 두면 한쪽만 고치게 된다.
//
//   node src/cli.ts run scenarios/prep-empty-avatar.ts
//
// **앱을 `-style zwagent` 로 띄워야 한다** — `bash tools/launch-zweave.sh`.
// 채널 단계가 있으므로 파이프가 없으면 러너가 시작 전에 거부한다.

import type { Step } from '../src/scenario/steps.ts'

/**
 * 빈 씬 + Avatar 패널. 뒤에 오는 시나리오가 이 상태를 전제할 수 있다.
 *
 * **이름과 경로는 실앱에서 확인한 것이다** (2026-09-10). `Avatar` 는 세 군데에 있어서
 * (`File > Import`, `Window > UI panels`, `Development > SimulationDetail`) **경로가
 * 필수다** — 안 주면 플러그인이 부르지 않고 후보를 돌려준다.
 */
export const prepSteps: Step[] = [
  { do: 'waitIdle' },

  // 문서를 스스로 연다. **파일 다이얼로그를 거치지 않는다** — 최근 파일이라 가능하다.
  // 완료는 화면이 아니라 문서 이름으로 판정한다(진행 다이얼로그가 여러 개 이어서 뜨고
  // 그 사이 doc 은 아직 옛 파일명을 보고한다).
  { do: 'openRecent', fileName: 'empty-scene.zls' },
  // **dirty 는 기대하지 않는다.** 여는 것만으로 `*` 가 붙는 것을 봤다 (2026-09-10,
  // 자동 시뮬레이션으로 보인다). 확인할 수 있는 것만 확인한다.
  { do: 'expectDoc', fileName: 'empty-scene.zls' },

  // 패널을 **맞춘다.** `trigger` 를 쓰면 이미 켜져 있을 때 꺼진다 — 사전 조건을
  // 만들려는 단계가 사전 조건을 깨뜨린다.
  { do: 'setAction', text: 'Avatar', path: 'Window > UI panels', checked: true },

  // **만들어졌는지 확인한다.** 여기가 이 시나리오에서 유일하게 결과를 모르는 곳이다 —
  // `setAction` 이 dock 을 **열기만** 하는지 **앞 탭으로 세우기까지** 하는지 확인되지
  // 않았다. 실패하면 탭을 앞으로 세우는 별도 수단이 필요하다는 뜻이고, 그 답이
  // 다음 작업의 입력이다.
  { do: 'expectPanel', dockId: 'avatar', tabName: 'Avatar' },
]

const scenario = {
  name: '사전 조건 만들기',
  what: '빈 씬을 열고 Avatar 패널을 켜는 것을 시나리오가 스스로 한다',
  steps: prepSteps,
}

export default scenario
