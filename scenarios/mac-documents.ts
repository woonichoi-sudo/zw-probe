import type { Scenario } from '../src/scenario/steps.ts'

/**
 * macOS — 문서 열기·다이얼로그·명령 확인·패널 baseline (2026-10-12).
 *
 * 패널 토글(mac-panel-toggle.ts)이 안 쓰는 단계를 실앱에서 돌린다: `expectAction`·`trigger`·저장 확인
 * 다이얼로그의 `clickName`·`openRecent`·`checkBaseline --panel`.
 *
 * **전제** — 앱을 `bash tools/launch-zweave.sh --open runs/zls/sample-copy.zls` 로 새로 띄웠다
 * (`runs/zls/sample-copy.zls` 는 `<Z-Weave>/Zest/testing/sdk/sample.zls` 의 복사본). 그러면 최근 목록에
 * `sample-copy.zls`·`sample.zls` 둘이 있다. 샘플은 **열자마자 dirty** 라서 다른 문서를 열 때마다 저장 확인
 * 창이 뜬다 — 그것도 시험한다. **아무것도 저장하지 않는다**("No").
 *
 * `openRecent` 는 문서 이름이 바뀔 때까지 기다리기만 하므로 저장 확인 창이 끼면 상한까지 막힌다. 그래서
 * New 로 깨끗한 Untitled 를 먼저 만들고 거기서 연다.
 */
const PANEL_BASELINE = 'mac-샘플-아바타패널'

const scenario: Scenario = {
  name: '문서 열기와 다이얼로그 (macOS)',
  what: '최근 파일·New·저장 확인 창을 다이얼로그 없이(또는 이름으로 눌러) 지나가고, 문서와 패널이 기대대로다',
  steps: [
    { do: 'waitIdle' },
    { do: 'expectDoc', fileName: 'sample-copy.zls', dirty: true },
    { do: 'expectAction', text: 'sample-copy.zls', path: 'File > Recent files' },
    { do: 'expectAction', text: 'sample.zls', path: 'File > Recent files' },
    { do: 'expectAction', text: '없는-파일.zls', path: 'File > Recent files', present: false },

    // 패널 baseline — 창 전체가 아니라 Avatar 패널만 본다(2D 봉제선 색에 흔들리지 않는다)
    { do: 'clickName', name: 'Avatar', id: 'dockWidgetTabLabel', expectChange: false },
    { do: 'expectPanel', dockId: 'avatar' },
    { do: 'checkBaseline', baseline: PANEL_BASELINE, panel: 'dock_avatar' },

    // New → 저장 확인 창 → No → 깨끗한 Untitled
    // 다이얼로그를 띄우는 trigger 는 메인 창 픽셀을 안 바꾼다(다이얼로그는 별도 창) — 다음 단계가 본다
    { do: 'trigger', text: 'New', path: 'File', expectChange: false },
    { do: 'sleep', ms: 1500, why: 'trigger 는 큐에 넣을 뿐이라 다이얼로그가 뜨기를 기다린다 — waitIdle 은 모달 앞에서 끝나지 않는다' },
    { do: 'expectElement', name: 'Do you want to save?' },
    // 누른 뒤 화면을 찍지 않는다 — 로딩 중에 3D 뷰를 그리면 대상 앱 zwQt3DView::Render 가 뮤텍스를 잠근 채
    // 빠져나가 다음 열기가 영원히 멈춘다(2026-10-12 실측, 열린 항목). 완료는 waitIdle·expectDoc 가 본다
    { do: 'clickName', name: 'No', expectChange: false },
    // waitIdle 은 여는 도중의 틈에 일찍 통과한다 — 문서 이름이 바뀔 때까지 기다린다
    { do: 'expectDoc', fileName: 'Untitled.zls', dirty: false, timeoutMs: 60000 },
    { do: 'waitIdle', timeoutMs: 60000 },
    { do: 'shot', label: '새문서' },

    // 깨끗한 문서에서 최근 파일 — 다이얼로그 없이 열려야 한다
    { do: 'openRecent', fileName: 'sample.zls' },
    { do: 'waitIdle', timeoutMs: 60000 },
    { do: 'expectDoc', fileName: 'sample.zls' },
    { do: 'shot', label: '샘플' },

    // dirty 에서 다른 최근 파일 — 저장 확인 창을 이름으로 지나간다
    { do: 'trigger', text: 'sample-copy.zls', path: 'File > Recent files', expectChange: false },
    { do: 'sleep', ms: 1500, why: 'trigger 는 큐에 넣을 뿐이라 다이얼로그가 뜨기를 기다린다 — waitIdle 은 모달 앞에서 끝나지 않는다' },
    { do: 'expectElement', name: 'Do you want to save?' },
    // 누른 뒤 화면을 찍지 않는다 — 로딩 중에 3D 뷰를 그리면 대상 앱 zwQt3DView::Render 가 뮤텍스를 잠근 채
    // 빠져나가 다음 열기가 영원히 멈춘다(2026-10-12 실측, 열린 항목). 완료는 waitIdle·expectDoc 가 본다
    { do: 'clickName', name: 'No', expectChange: false },
    { do: 'expectDoc', fileName: 'sample-copy.zls', timeoutMs: 60000 },
    { do: 'waitIdle', timeoutMs: 60000 },

    // 다시 연 뒤에도 Avatar 패널은 같아야 한다
    { do: 'clickName', name: 'Avatar', id: 'dockWidgetTabLabel', expectChange: false },
    { do: 'expectPanel', dockId: 'avatar' },
    { do: 'checkBaseline', baseline: PANEL_BASELINE, panel: 'dock_avatar' },
  ],
}

export default scenario
