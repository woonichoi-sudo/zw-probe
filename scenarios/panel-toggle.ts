// 오른쪽 패널 토글이 정확히 되돌아오는가.
//
// M2 에서 손으로 확인한 절차를 그대로 옮긴 것이다 — 찍고, `Shift+P` 를 누르고,
// 다시 찍어 비교하고, 한 번 더 눌러 돌아오는지 본다. 안전한 시나리오다: 문서를
// 건드리지 않고, 되돌릴 수 있고, 형상을 만들지 않는다.
//
// **마지막 단계가 진짜 시험이다.** 두 번 눌러 원래 상태로 돌아왔을 때 픽셀이
// baseline 과 **완전히** 같은가. 토글이 상태를 정확히 복원하지 않으면 여기서 걸린다.
//
//   node src/cli.ts run scenarios/panel-toggle.ts

import type { Scenario } from '../src/scenario/steps.ts'

const scenario: Scenario = {
  name: '패널 토글',
  what: 'SidePanel(Shift+P)을 두 번 누르면 화면이 정확히 원래대로 돌아온다',
  // 아바타 탭이 활성인 상태를 전제로 한다. baseline 이 그 상태에서 떠 있다.
  steps: [
    // 시작 상태를 확인한다. 여기가 틀리면 뒤의 판정은 의미가 없다.
    { do: 'waitIdle' },
    { do: 'expectDoc', fileName: 'Untitled.zls', dirty: false },
    // **탭 라벨의 존재로는 활성 탭을 확인할 수 없다.** 여섯 개가 늘 다 있다.
    // 처음 이 자리에 expectElement name="Simulation" 을 썼더니 통과했는데 실제로는
    // Avatar 탭이 활성이었다 (2026-09-09). expectPanel 이 그것을 잡는다.
    { do: 'expectPanel', dockId: 'avatar', tabName: 'Avatar' },
    { do: 'checkBaseline', baseline: '빈씬-아바타탭' },

    // 한 번 누른다. 패널이 사라지므로 화면이 크게 바뀌어야 한다.
    { do: 'key', shortcut: 'SidePanel' },
    { do: 'waitIdle' },
    { do: 'shot', label: '패널숨김' },

    // 다시 누른다. 돌아와야 한다.
    { do: 'key', shortcut: 'SidePanel' },
    { do: 'waitIdle' },
    { do: 'checkBaseline', baseline: '빈씬-아바타탭' },
  ],
}

export default scenario
