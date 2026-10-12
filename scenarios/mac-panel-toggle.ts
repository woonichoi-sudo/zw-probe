import type { Scenario } from '../src/scenario/steps.ts'

/**
 * macOS 판 패널 토글 (2026-10-12). Windows 판(panel-toggle-auto.ts)과 같은 시험을 Mac 실앱에서 한다.
 *
 * **출발점이 다르다.** Mac 에는 `empty-scene.zls` 가 없고 최근 파일도 비어 있었다 — 그래서 앱을
 * `bash tools/launch-zweave.sh --open <Z-Weave>/Zest/testing/sdk/sample.zls` 로 띄운 상태를 전제한다.
 * 이 샘플은 **열자마자 dirty 다**(History 에 `Avatar UI changed`·`Apply draping item` 이 열 때 생긴다)
 * — 저장하지 않는다.
 *
 * baseline 은 플랫폼마다 따로다(글꼴·창 크기·HiDPI 가 다르다). 이름에 `mac-` 을 붙인다.
 *
 * **앱을 새로 띄워 연 직후여야 baseline 이 맞는다.** 같은 프로세스에서 최근 파일로 다시 열면 2D 봉제선
 * 쌍의 색이 매번 달라져 0.5% 가량 어긋난다(2026-10-12 실측, WORKLOG). 다시 띄워서 돌린다.
 */
const BASELINE = 'mac-샘플-아바타탭'

const scenario: Scenario = {
  name: '패널 토글 (macOS)',
  what: 'SidePanel(Shift+P)을 두 번 누르면 화면이 정확히 원래대로 돌아온다 — Mac 실앱, 사전 조건은 스스로',
  steps: [
    { do: 'waitIdle' },
    { do: 'expectDoc', fileName: 'sample.zls' },

    // 사전 조건 — 패널이 켜져 있고 Avatar 탭이 앞에 있다
    { do: 'setAction', text: 'Avatar', path: 'Window > UI panels', checked: true },
    { do: 'clickName', name: 'Avatar', id: 'dockWidgetTabLabel', expectChange: false },
    { do: 'expectPanel', dockId: 'avatar' },
    { do: 'grabPanel', objectName: 'dock_avatar', label: '아바타패널' },

    { do: 'checkBaseline', baseline: BASELINE },

    { do: 'key', shortcut: 'SidePanel' },
    { do: 'waitIdle' },
    { do: 'expectElement', id: 'dock_avatar', present: false },
    { do: 'shot', label: '패널숨김' },

    { do: 'key', shortcut: 'SidePanel' },
    { do: 'waitIdle' },
    { do: 'expectPanel', dockId: 'avatar' },
    { do: 'checkBaseline', baseline: BASELINE },
  ],
}

export default scenario
