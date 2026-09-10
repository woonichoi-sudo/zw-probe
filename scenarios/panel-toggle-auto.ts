// [panel-toggle.ts](./panel-toggle.ts) 와 같은 것을 확인하되 **사전 조건을 스스로 만든다.**
//
// 원본은 사람이 Avatar 탭을 켜고 `Untitled.zls` 를 열어둔 상태를 전제한다. 앱은 사람과
// 공유하므로 그 전제가 실행 사이사이에 깨진다 — 2026-09-09 에 실제로 겪었다.
// 여기서는 [prep-empty-avatar.ts](./prep-empty-avatar.ts) 가 그 상태를 만든다.
//
// **원본을 지우지 않은 이유.** 원본은 실앱에서 10/10 통과한 것이 확인돼 있고, 이쪽은
// 아직 아니다. 검증된 것을 검증 안 된 것으로 덮어쓰지 않는다.
//
// 처음 돌릴 때는 baseline 이 없어서 **거부된다. 그게 정상이다.** 순서:
//
//   bash tools/launch-zweave.sh && bash tools/wait-zweave.sh
//   node src/cli.ts run scenarios/prep-empty-avatar.ts        # 상태를 만든다
//   node src/cli.ts baseline 자동-빈씬-아바타탭                  # 그 상태를 정답으로 뜬다
//   node src/cli.ts run scenarios/panel-toggle-auto.ts        # 전체를 돌린다
//
// **baseline 은 레이아웃이 정착한 뒤에 뜬다.** 과도 상태를 담으면 그 뒤 모든 비교가
// 그걸 정답으로 삼는다 (잘린 탭 라벨이 469픽셀 오차를 낸 적이 있다).

import type { Scenario } from '../src/scenario/steps.ts'
import { prepSteps } from './prep-empty-avatar.ts'

/** 준비 단계와 본 시험이 같은 이름을 봐야 한다. */
const BASELINE = '자동-빈씬-아바타탭'

const scenario: Scenario = {
  name: '패널 토글 (자동 준비)',
  what: 'SidePanel(Shift+P)을 두 번 누르면 화면이 정확히 원래대로 돌아온다',
  steps: [
    // 사전 조건을 스스로 만든다. 사람이 앱을 준비해줄 필요가 없다.
    ...prepSteps,

    // 여기부터가 원본과 같다. 시작 상태가 정답과 같은지 먼저 본다 —
    // 여기가 틀리면 뒤의 판정은 의미가 없다.
    { do: 'checkBaseline', baseline: BASELINE },

    // 한 번 누른다. 패널이 사라지므로 화면이 크게 바뀌어야 한다.
    { do: 'key', shortcut: 'SidePanel' },
    { do: 'waitIdle' },
    { do: 'shot', label: '패널숨김' },

    // 다시 누른다. **마지막 단계가 진짜 시험이다** — 토글이 상태를 정확히
    // 복원하지 않으면 여기서 걸린다.
    { do: 'key', shortcut: 'SidePanel' },
    { do: 'waitIdle' },
    { do: 'checkBaseline', baseline: BASELINE },
  ],
}

export default scenario
