// 시나리오의 절차 기술과 순수 판정 (CLAUDE.md 절대 규칙 5). I/O 는 run.ts 에 있다.
//
// **단계는 클로저가 아니라 데이터다.** 함수로 쓰면 짧게 쓸 수 있지만 세 가지를 잃는다.
//   ① 앱을 건드리기 전에 시나리오 전체를 검증할 수 없다. 오타 난 단축키 이름을
//      절차 중간에서 발견하면 앱은 이미 반쯤 조작된 상태다 — 되돌릴 수 없다
//   ② 무엇을 하려 했는지 보고서에 적을 수 없다. 실패 보고에 "3번째 단계" 만 남는다
//   ③ 순서와 판정을 실앱 없이 테스트할 수 없다
//
// ①이 결정적이다. 이 도구는 되돌리기 어려운 조작을 하므로 **틀린 절차는 시작하기
// 전에 거부해야 한다.**

import type { Rect } from '../image/diff.ts'

/** 마우스 버튼. zwwin.exe 가 받는 것과 같은 집합. */
export type Button = 'left' | 'right' | 'middle'

export type Step =
  /** `shortcut.ini` 의 기능 이름으로 단축키를 보낸다 */
  | {
      do: 'key'
      shortcut: string
      /**
       * 전후 화면이 달라져야 하는가. 기본 true —
       * 단축키를 보냈는데 화면이 그대로면 통하지 않은 것이다(포그라운드를 놓쳤거나
       * 앱이 그 상태에서 무시했다). 화면을 바꾸지 않는 명령이면 false 로 끈다.
       */
      expectChange?: boolean
    }
  /** 창 기준 좌표를 누른다. `shot` 의 PNG 좌표와 같다 */
  | { do: 'click'; x: number; y: number; button?: Button; double?: boolean; expectChange?: boolean }
  /** UIA 로 요소를 찾아 한가운데를 누른다. 여럿 맞으면 실패한다 */
  | {
      do: 'clickName'
      name?: string
      id?: string
      class?: string
      type?: string
      button?: Button
      double?: boolean
      expectChange?: boolean
    }
  /** 창 구조가 idle 이 될 때까지 기다린다. sleep 추측을 대체하는 것이 이것이다 */
  | { do: 'waitIdle'; timeoutMs?: number }
  /**
   * 그냥 기다린다. **`why` 가 필수다** — sleep 은 재현성을 깨뜨리는 도구이므로
   * 왜 `waitIdle` 로 안 되는지 적게 강제한다. 보고서에도 그 이유가 실린다.
   */
  | { do: 'sleep'; ms: number; why: string }
  /** 찍어서 남긴다. 판정은 하지 않는다 — 사람이(또는 내가) 보기 위한 것 */
  | { do: 'shot'; label: string }
  /** 지금 화면을 baseline 과 비교한다 */
  | {
      do: 'checkBaseline'
      /** `baselines/` 안의 이름. 확장자는 붙이지 않는다 */
      baseline: string
      maxChangedRatio?: number
      /** 늘 변하는 영역을 뺀다 */
      ignore?: Rect[]
      /**
       * 창 전체가 아니라 이 위젯만 비교한다 (`zwagent` 의 `QWidget::grab()`).
       *
       * **관계없는 곳의 변화를 애초에 안 담는 것이 `ignore` 보다 낫다** — `ignore`
       * 는 무엇이 변할지 미리 알아야 하고 좌표가 레이아웃에 묶인다. 패널 하나만
       * 찍으면 그 문제가 사라진다.
       */
      panel?: string
    }
  /**
   * 열린 파일명과 dirty 를 확인한다.
   *
   * `timeoutMs` 를 주면 **파일명이 그렇게 될 때까지 기다린다** (`fileName` 필수). 다이얼로그를 거쳐 문서를
   * 열 때 쓴다 — 여는 동안 진행 창 사이에 잠깐 idle 로 보이는 틈이 있어 `waitIdle` 이 너무 일찍 통과한다
   * (2026-10-12 실측: 통과했는데 제목이 아직 옛 파일명이었다). `openRecent` 가 안에서 하는 것과 같다.
   */
  | { do: 'expectDoc'; fileName?: string; dirty?: boolean; timeoutMs?: number }
  /** 요소가 있는가 / 없는가 */
  | { do: 'expectElement'; name?: string; id?: string; class?: string; type?: string; present?: boolean }
  /**
   * 오른쪽 패널에서 어느 탭이 활성인가.
   *
   * **`expectElement` 로는 이걸 확인할 수 없다** — 탭 라벨 여섯 개가 어느 탭이
   * 활성이든 늘 다 있다. 2026-09-09 에 시나리오 사전 조건을
   * `expectElement name="Simulation"` 으로 썼더니 통과했는데 실제로는 Avatar 탭이
   * 활성이었다. **거짓 확신을 주는 검사였다.**
   *
   * `dockId` 가 튼튼하다(현지화·잘림 없음). `tabName` 은 사람이 읽기 좋지만 잘릴 수 있다.
   */
  | { do: 'expectPanel'; dockId?: string; tabName?: string }
  /**
   * 메뉴 명령을 이름으로 부른다 (`zwagent` 의 `QAction::trigger()`).
   *
   * **이것이 시나리오가 자기 사전 조건을 만들 수 있게 한다.** 지금까지는
   * "사람이 Simulation 탭을 켜둔 상태" 를 전제하고 아니면 거부했는데,
   * `Window > UI panels > Simulation` 을 불러 **만들면** 된다.
   *
   * `path` 는 이름이 겹칠 때 필요하다 — 실앱의 Import 와 Export 밑에 똑같이
   * `OBJ` 가 있다. 겹치는데 안 주면 플러그인이 부르지 않고 거부한다.
   *
   * **`trigger` 는 큐에 들어간다.** 응답이 와도 아직 실행 전일 수 있으므로,
   * 러너가 화면이 바뀔 때까지 기다렸다가 판정한다. 근거는 run.ts 의 주석.
   */
  | { do: 'trigger'; text: string; path?: string; expectChange?: boolean }
  /**
   * 최근 파일에서 프로젝트를 연다.
   *
   * **파일 다이얼로그를 거치지 않는다** (2026-09-10 실측). `trigger` 로도 같은 일을
   * 할 수 있지만 이 단계가 따로 있는 이유는 **완료를 기다리는 방법이 다르기**
   * 때문이다 — 여는 동안 진행 다이얼로그가 8초쯤 떠 있고, 그 사이 `doc` 은 아직
   * **옛 파일명**을 보고한다. 그래서 "문서가 이 이름이 될 때까지" 를 기다린다.
   * 화면 변화나 idle 로 판정하면 너무 일찍 통과한다.
   */
  | { do: 'openRecent'; fileName: string; timeoutMs?: number }
  /**
   * 위젯 하나만 찍어 남긴다 (`zwagent` 의 `QWidget::grab()`).
   *
   * **창 전체 비교는 관계없는 곳이 바뀌어도 실패한다** — 탭 라벨이 잘려 469픽셀
   * 오차를 낸 적이 있다. 패널 단위면 그 소음이 사라진다. 가려져 있어도 찍힌다.
   */
  | { do: 'grabPanel'; objectName: string; label: string }
  /**
   * 켜고 끄는 명령을 **원하는 상태로 맞춘다.** 이미 그 상태면 아무것도 하지 않는다.
   *
   * **`trigger` 로는 사전 조건을 만들 수 없다.** `Window > UI panels > Avatar` 같은
   * 토글을 무턱대고 부르면 **이미 켜져 있을 때 꺼진다.** 단계가 데이터라 조건 분기를
   * 쓸 수 없으므로, "맞춘다" 를 단계 자체가 해야 한다.
   *
   * 이것이 "시나리오가 자기 사전 조건을 만든다" 의 실체다 — 지금까지는 사람이
   * 탭을 켜둔 상태를 전제하고 아니면 거부했다.
   */
  | { do: 'setAction'; text: string; path?: string; checked: boolean; timeoutMs?: number }
  /**
   * 명령의 상태를 확인한다. **픽셀이 아니라 사실로 본다.**
   *
   * `Window > UI panels` 항목이 켜짐 상태를 주므로 "패널이 켜져 있나" 를
   * 화면 비교 없이 확인할 수 있다. `enabled` 는 "지금 부를 수 있나" 다.
   */
  | {
      do: 'expectAction'
      text: string
      path?: string
      enabled?: boolean
      checked?: boolean
      /** 그 이름의 명령이 있어야 하는가. 기본 true */
      present?: boolean
    }

export type Scenario = {
  name: string
  /** 이 시나리오가 무엇을 확인하는지. 실패 보고 머리에 실린다 */
  what: string
  steps: Step[]
}

/** 화면을 바꾸는 단계인가. 전후 비교를 붙일 대상이다. */
export function isAction(step: Step): boolean {
  return (
    step.do === 'key' || step.do === 'click' || step.do === 'clickName' || step.do === 'trigger'
  )
}

/**
 * 명령 채널(파이프)이 있어야 도는 단계인가.
 *
 * **미리 알아야 한다.** 파이프가 없는데 시작하면 절차 중간에서 멈추고, 그때 앱은
 * 이미 반쯤 조작된 상태다. 러너가 시작 전에 이 목록을 보고 거부한다.
 */
export function needsAgent(step: Step): boolean {
  if (step.do === 'checkBaseline') return step.panel !== undefined
  return (
    step.do === 'trigger' ||
    step.do === 'openRecent' ||
    step.do === 'grabPanel' ||
    step.do === 'setAction' ||
    step.do === 'expectAction'
  )
}

/** `expectChange` 의 실효값. 동작 단계의 기본은 "바뀌어야 한다" 다. */
export function wantsChange(step: Step): boolean {
  if (!isAction(step)) return false
  const s = step as { expectChange?: boolean }
  return s.expectChange ?? true
}

/** 단계를 한 줄로. 보고서와 진행 출력에 같은 문장을 쓴다. */
export function describeStep(step: Step): string {
  switch (step.do) {
    case 'key':
      return `key ${step.shortcut}`
    case 'click':
      return `click (${step.x},${step.y})${step.button && step.button !== 'left' ? ` ${step.button}` : ''}${step.double === true ? ' ×2' : ''}`
    case 'clickName': {
      const by = [
        step.name !== undefined ? `name="${step.name}"` : '',
        step.id !== undefined ? `id="${step.id}"` : '',
        step.class !== undefined ? `class=${step.class}` : '',
        step.type !== undefined ? `type=${step.type}` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      return `click ${by}`
    }
    case 'waitIdle':
      return `waitIdle ${step.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS}ms 까지`
    case 'sleep':
      return `sleep ${step.ms}ms (${step.why})`
    case 'shot':
      return `shot "${step.label}"`
    case 'checkBaseline':
      return (
        `checkBaseline ${step.baseline}` +
        `${step.panel !== undefined ? ` (패널 ${step.panel})` : ''}` +
        `${step.ignore !== undefined && step.ignore.length > 0 ? ` (무시 ${step.ignore.length}개 영역)` : ''}`
      )
    case 'expectDoc': {
      const parts = [
        step.fileName !== undefined ? `파일명="${step.fileName}"` : '',
        step.dirty !== undefined ? `dirty=${step.dirty}` : '',
        step.timeoutMs !== undefined ? `${step.timeoutMs}ms 까지 기다림` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      return `expectDoc ${parts}`
    }
    case 'expectPanel': {
      const parts = [
        step.dockId !== undefined ? `dock=${step.dockId}` : '',
        step.tabName !== undefined ? `탭="${step.tabName}"` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      return `expectPanel ${parts}`
    }
    case 'expectElement': {
      const by = [
        step.name !== undefined ? `name="${step.name}"` : '',
        step.id !== undefined ? `id="${step.id}"` : '',
        step.class !== undefined ? `class=${step.class}` : '',
        step.type !== undefined ? `type=${step.type}` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      return `expectElement ${by} ${step.present === false ? '없어야 한다' : '있어야 한다'}`
    }
    case 'trigger':
      return `trigger "${step.text}"${step.path !== undefined ? ` (경로 "${step.path}")` : ''}`
    case 'openRecent':
      return `openRecent "${step.fileName}"`
    case 'setAction':
      return (
        `setAction "${step.text}"` +
        `${step.path !== undefined ? ` (경로 "${step.path}")` : ''} → ${step.checked ? '켬' : '끔'}`
      )
    case 'grabPanel':
      return `grabPanel ${step.objectName} → "${step.label}"`
    case 'expectAction': {
      const want = [
        step.present === false ? '없어야 한다' : '',
        step.enabled !== undefined ? `enabled=${step.enabled}` : '',
        step.checked !== undefined ? `checked=${step.checked}` : '',
      ]
        .filter((s) => s !== '')
        .join(' ')
      const where = step.path !== undefined ? ` (경로 "${step.path}")` : ''
      return `expectAction "${step.text}"${where} ${want || '있어야 한다'}`
    }
  }
}

/** `waitIdle` 의 기본 상한. 무한 대기를 만들지 않는다. */
export const DEFAULT_IDLE_TIMEOUT_MS = 5000

/** `sleep` 이 넘으면 안 되는 값. 이보다 오래 기다려야 하면 설계가 틀렸다. */
export const MAX_SLEEP_MS = 60_000

export type ValidationError = {
  /** 0부터. 시나리오 자체의 문제면 -1 */
  stepIndex: number
  message: string
}

export type ValidationContext = {
  /**
   * `shortcut.ini` 에 있는 기능 이름 전부. 주면 오타를 시작 전에 잡는다.
   * 주지 않으면 단축키 이름 검사를 건너뛴다.
   */
  shortcutNames?: readonly string[]
  /** 있는 baseline 이름 전부. 주면 없는 baseline 참조를 시작 전에 잡는다 */
  baselineNames?: readonly string[]
  /**
   * 지금 부를 수 있는 명령 이름 전부 (`agent --actions`). 주면 오타를 시작 전에 잡는다.
   *
   * **단축키 이름 검사와 같은 이유다** — 틀린 이름은 무동작이 아니라 거부이고,
   * 절차 중간에서 거부되면 앱은 이미 반쯤 조작된 상태다. 파이프가 없으면 주지 않고
   * 검사를 건너뛴다.
   */
  actionTexts?: readonly string[]
}

/**
 * 명령 이름이 실제로 있는가. **틀린 이름은 무동작이 아니라 거부다** — 절차 중간에서
 * 거부되면 앱은 이미 반쯤 조작된 상태다. 목록을 못 받았으면 검사를 건너뛴다.
 */
function checkActionName(push: (m: string) => void, ctx: ValidationContext, text: string): void {
  if (ctx.actionTexts === undefined) return
  if (ctx.actionTexts.includes(text)) return
  push(
    `명령 "${text}" 이 지금 부를 수 있는 목록에 없다. ` +
      'zwprobe agent --actions <조각> 으로 확인한다.',
  )
}

function describeQueryFields(s: {
  name?: string
  id?: string
  class?: string
  type?: string
}): boolean {
  return s.name !== undefined || s.id !== undefined || s.class !== undefined || s.type !== undefined
}

/**
 * 시나리오를 실행 전에 검증한다. **문제를 전부 모아 돌려준다** — 하나씩 고치게
 * 하면 오타 열 개를 잡는 데 열 번 실행해야 하고, 이 도구는 실행이 비싸다.
 *
 * 여기서 잡는 것은 **실행하지 않고 알 수 있는 것뿐**이다. "그 버튼이 화면에
 * 있는가" 는 실행해야 알고, 그건 `expectElement` 가 할 일이다.
 */
export function validateScenario(sc: Scenario, ctx: ValidationContext = {}): ValidationError[] {
  const errors: ValidationError[] = []

  if (sc.name.trim() === '') {
    errors.push({ stepIndex: -1, message: '시나리오에 name 이 없다.' })
  }
  if (sc.what.trim() === '') {
    errors.push({
      stepIndex: -1,
      message: 'what 이 없다 — 이 시나리오가 무엇을 확인하는지 적어야 실패 보고가 읽힌다.',
    })
  }
  if (sc.steps.length === 0) {
    errors.push({ stepIndex: -1, message: '단계가 없다.' })
  }

  sc.steps.forEach((step, i) => {
    const push = (message: string) => errors.push({ stepIndex: i, message })

    switch (step.do) {
      case 'key': {
        if (step.shortcut.trim() === '') {
          push('key 에 shortcut 이름이 없다.')
          break
        }
        if (ctx.shortcutNames !== undefined && !ctx.shortcutNames.includes(step.shortcut)) {
          // 틀린 이름을 관대하게 넘기면 안 된다 — 틀린 키는 무동작이 아니라
          // **다른 명령 실행**이다 (2026-09-09 실측).
          push(
            `단축키 "${step.shortcut}" 이 shortcut.ini 에 없다. ` +
              '`zwprobe shortcuts --filter <조각>` 으로 확인한다.',
          )
        }
        break
      }
      case 'click': {
        if (!Number.isInteger(step.x) || !Number.isInteger(step.y)) {
          push(`좌표가 정수가 아니다: (${step.x},${step.y})`)
        } else if (step.x < 0 || step.y < 0) {
          push(`좌표가 음수다: (${step.x},${step.y}). 창 왼쪽 위가 (0,0) 이다.`)
        }
        break
      }
      case 'clickName': {
        if (!describeQueryFields(step)) {
          push('clickName 에 name·id·class·type 중 하나는 있어야 한다.')
        }
        break
      }
      case 'waitIdle': {
        if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
          push(`timeoutMs 가 양수가 아니다: ${step.timeoutMs}`)
        }
        break
      }
      case 'sleep': {
        if (!Number.isFinite(step.ms) || step.ms <= 0) {
          push(`sleep ms 가 양수가 아니다: ${step.ms}`)
        } else if (step.ms > MAX_SLEEP_MS) {
          push(`sleep ${step.ms}ms 는 상한 ${MAX_SLEEP_MS}ms 를 넘는다. waitIdle 을 써야 한다.`)
        }
        if (step.why.trim() === '') {
          push('sleep 에 why 가 없다 — 왜 waitIdle 로 안 되는지 적어야 한다.')
        }
        break
      }
      case 'shot': {
        if (step.label.trim() === '') {
          push('shot 에 label 이 없다. 파일 이름이 된다.')
        } else if (!/^[A-Za-z0-9._가-힣-]+$/.test(step.label)) {
          push(`shot label 에 파일 이름으로 쓸 수 없는 문자가 있다: "${step.label}"`)
        }
        break
      }
      case 'checkBaseline': {
        if (step.baseline.trim() === '') {
          push('checkBaseline 에 baseline 이름이 없다.')
          break
        }
        if (ctx.baselineNames !== undefined && !ctx.baselineNames.includes(step.baseline)) {
          push(
            `baseline "${step.baseline}" 이 없다. \`zwprobe baseline --save ${step.baseline}\` 로 먼저 뜬다.`,
          )
        }
        if (
          step.maxChangedRatio !== undefined &&
          (!Number.isFinite(step.maxChangedRatio) || step.maxChangedRatio < 0 || step.maxChangedRatio > 1)
        ) {
          push(`maxChangedRatio 는 0..1 이어야 한다: ${step.maxChangedRatio}`)
        }
        for (const r of step.ignore ?? []) {
          if (
            !Number.isInteger(r.x) ||
            !Number.isInteger(r.y) ||
            !Number.isInteger(r.width) ||
            !Number.isInteger(r.height) ||
            r.width <= 0 ||
            r.height <= 0 ||
            r.x < 0 ||
            r.y < 0
          ) {
            push(`ignore 사각형이 이상하다: ${JSON.stringify(r)}`)
          }
        }
        break
      }
      case 'expectDoc': {
        if (step.fileName === undefined && step.dirty === undefined) {
          push('expectDoc 에 fileName 이나 dirty 중 하나는 있어야 한다.')
        }
        if (step.timeoutMs !== undefined && step.fileName === undefined) {
          push('expectDoc 의 timeoutMs 는 fileName 을 기다리는 것이다 — fileName 이 필요하다.')
        }
        if (step.timeoutMs !== undefined && !(step.timeoutMs > 0)) {
          push('expectDoc 의 timeoutMs 는 양수여야 한다.')
        }
        break
      }
      case 'expectElement': {
        if (!describeQueryFields(step)) {
          push('expectElement 에 name·id·class·type 중 하나는 있어야 한다.')
        }
        break
      }
      case 'expectPanel': {
        if (step.dockId === undefined && step.tabName === undefined) {
          push('expectPanel 에 dockId 나 tabName 중 하나는 있어야 한다.')
        }
        break
      }
      case 'trigger': {
        if (step.text.trim() === '') {
          push('trigger 에 명령 이름(text)이 없다.')
          break
        }
        checkActionName(push, ctx, step.text)
        break
      }
      case 'openRecent': {
        if (step.fileName.trim() === '') {
          push('openRecent 에 파일명이 없다.')
          break
        }
        // 최근 파일 목록은 앱이 관리하므로 **이름이 목록에 없으면 열 수 없다.**
        // 파일명을 옮겨 적다 틀리는 것이 흔하고, 그건 시작 전에 잡힌다.
        checkActionName(push, ctx, step.fileName)
        if (
          step.timeoutMs !== undefined &&
          (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)
        ) {
          push(`timeoutMs 가 양수가 아니다: ${step.timeoutMs}`)
        }
        break
      }
      case 'grabPanel': {
        if (step.objectName.trim() === '') push('grabPanel 에 objectName 이 없다.')
        if (step.label.trim() === '') {
          push('grabPanel 에 label 이 없다. 파일 이름이 된다.')
        } else if (!/^[A-Za-z0-9._가-힣-]+$/.test(step.label)) {
          push(`grabPanel label 에 파일 이름으로 쓸 수 없는 문자가 있다: "${step.label}"`)
        }
        break
      }
      case 'setAction': {
        if (step.text.trim() === '') {
          push('setAction 에 명령 이름(text)이 없다.')
          break
        }
        checkActionName(push, ctx, step.text)
        if (
          step.timeoutMs !== undefined &&
          (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)
        ) {
          push(`timeoutMs 가 양수가 아니다: ${step.timeoutMs}`)
        }
        break
      }
      case 'expectAction': {
        if (step.text.trim() === '') {
          push('expectAction 에 명령 이름(text)이 없다.')
          break
        }
        if (step.present === false) {
          if (step.enabled !== undefined || step.checked !== undefined) {
            // 없어야 하는 것의 상태를 함께 기대하면 무엇을 확인하려는지 모호하다.
            push('expectAction 에 present:false 와 enabled/checked 를 함께 줄 수 없다.')
          }
          break
        }
        // **있어야 하는 경우에만** 이름을 검증한다 — 없어야 하는 이름이 목록에
        // 없는 것은 정상이고, 그것을 오타로 거부하면 이 단계를 쓸 수 없다.
        checkActionName(push, ctx, step.text)
        break
      }
      default: {
        // 알 수 없는 단계를 조용히 건너뛰면 시나리오가 통과했다고 착각한다.
        const unknown = step as { do?: unknown }
        push(`알 수 없는 단계다: ${JSON.stringify(unknown.do)}`)
      }
    }
  })

  return errors
}

export type StepOutcome = 'pass' | 'fail' | 'skipped'

export type StepResult = {
  stepIndex: number
  description: string
  outcome: StepOutcome
  /** 왜 그렇게 됐는지. 통과한 단계도 적는다 — 성공한 근거도 봐야 한다 */
  reason: string
  elapsedMs: number
  /** 이 단계에서 남긴 파일들 (캡처 등) */
  artifacts?: string[]
}

export type RunSummary = {
  passed: number
  failed: number
  skipped: number
  /** 첫 실패. 없으면 null. 뒤 단계는 앞 실패의 결과일 수 있어 첫 번째가 원인이다 */
  firstFailure: StepResult | null
  /** 사람이 읽는 줄들 */
  lines: string[]
}

/**
 * 결과를 모아 요약한다.
 *
 * **첫 실패만 원인으로 취급한다.** 러너는 실패하면 멈추지만, 멈추지 않는 모드를
 * 쓰더라도 두 번째 실패는 첫 실패가 남긴 상태의 결과일 가능성이 높다.
 */
export function summarizeRun(sc: Scenario, results: readonly StepResult[]): RunSummary {
  const passed = results.filter((r) => r.outcome === 'pass').length
  const failed = results.filter((r) => r.outcome === 'fail').length
  const skipped = results.filter((r) => r.outcome === 'skipped').length
  const firstFailure = results.find((r) => r.outcome === 'fail') ?? null

  const mark = (o: StepOutcome) => (o === 'pass' ? '✔' : o === 'fail' ? '✖' : '·')
  const lines = [
    `시나리오  ${sc.name}`,
    `확인      ${sc.what}`,
    '',
    ...results.map(
      (r) => `${mark(r.outcome)} ${String(r.stepIndex + 1).padStart(2)} ${r.description}  — ${r.reason}`,
    ),
    '',
    `결과      통과 ${passed} · 실패 ${failed} · 건너뜀 ${skipped}`,
  ]
  if (firstFailure !== null) {
    lines.push(
      `첫 실패   ${firstFailure.stepIndex + 1}번째 "${firstFailure.description}" — ${firstFailure.reason}`,
    )
  }

  return { passed, failed, skipped, firstFailure, lines }
}
