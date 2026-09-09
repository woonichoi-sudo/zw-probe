// 클릭이 의도한 창에 닿았는가. 순수 판정 — I/O 없음 (CLAUDE.md 절대 규칙 5).
//
// **왜 판정이 필요한가.** 단축키는 틀리면 다른 명령이 실행되지만(2026-09-09 실측),
// 클릭은 틀리면 **다른 창이 맞는다.** 대상 창이 다른 창에 가려져 있으면 좌표는 맞는데
// 입력은 남의 것이 된다. 그리고 그 사실이 화면에도 로그에도 남지 않는다.
//
// 그래서 `zwwin.exe` 가 누르기 직전에 `WindowFromPoint` 로 그 자리의 창을 읽어 사실로
// 싣고, 여기서 대상과 대조한다.

import type { ClickResult } from '../win/zwwin.ts'

export type ClickVerdict = {
  /** 의도한 창에 닿았는가 */
  onTarget: boolean
  /** 왜 그렇게 판정했는지 */
  reason: string
}

export function judgeClick(r: ClickResult): ClickVerdict {
  if (!r.moved) {
    return { onTarget: false, reason: 'SetCursorPos 가 실패했다. 커서를 옮기지 못했으니 누른 자리를 알 수 없다.' }
  }
  if (r.hwndAtPoint === 0) {
    return { onTarget: false, reason: `(${r.screenX},${r.screenY}) 에 창이 없다. 화면 밖 좌표일 수 있다.` }
  }
  if (r.rootAtPoint !== r.window.hwnd) {
    return {
      onTarget: false,
      reason:
        `누른 자리의 최상위 창이 hwnd=${r.rootAtPoint} 인데 대상은 hwnd=${r.window.hwnd} 다. ` +
        '대상 창이 가려져 있다 — 캡처는 가려진 창도 잡지만 클릭은 못 뚫는다.',
    }
  }
  if (!r.activated) {
    // 좌표는 맞았다. 다만 포그라운드를 못 잡았으므로 앱이 클릭을 활성화용으로만
    // 소비했을 수 있다 — 첫 클릭이 창을 깨우고 위젯에는 닿지 않는 흔한 패턴이다.
    return {
      onTarget: false,
      reason: '좌표는 대상 창이지만 포그라운드를 잡지 못했다. 첫 클릭이 창 활성화로만 소비될 수 있다.',
    }
  }
  return { onTarget: true, reason: `대상 창의 (${r.x},${r.y}) 를 눌렀다.` }
}
