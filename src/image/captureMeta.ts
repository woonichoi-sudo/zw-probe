// 캡처 사이드카 메타데이터의 순수 처리 (CLAUDE.md 절대 규칙 5).
//
// **왜 사이드카가 필요한가.** `.bgra` 는 생 픽셀 바이트라 **자기 크기를 모른다.**
// 찍은 직후에는 `shot` 이 크기를 알려주므로 문제가 없지만, baseline 은 며칠 뒤에
// 읽는다. 크기를 모르면 버퍼를 이미지로 해석할 수 없다.
//
// PNG 를 디코딩하는 길도 있지만 Node 에 PNG 디코더가 없고, 의존성을 넣지 않는 것이
// 이 프로젝트의 전제다. 사이드카 JSON 이 가장 싸다.
//
// 크기 말고도 실을 것이 있다. **baseline 을 어느 앱 버전에서 떴는지**가 특히 중요하다 —
// 버전이 다르면 픽셀이 달라도 회귀가 아닐 수 있고, 그걸 모르면 실패를 볼 때마다
// 사람이 기억을 더듬어야 한다.

import { bgraByteLength } from './stats.ts'

export type CaptureMeta = {
  /** 항상 'bgra8'. 형식이 바뀌면 여기서 갈린다 */
  format: string
  width: number
  height: number
  /** ISO 8601 UTC */
  takenAt: string
  /** printwindow 또는 screen */
  mode: string
  /** 어느 창을 찍었는지. 나중에 "이게 그 창이었나" 를 따질 근거 */
  window: {
    title: string
    class: string
    pid: number
    /** 대상 앱 버전. baseline 을 비교할 때 이것이 다르면 알려야 한다 */
    fileVersion: string
    width: number
    height: number
  }
}

export type ParsedMeta = { ok: true; meta: CaptureMeta } | { ok: false; reason: string }

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/**
 * 사이드카 JSON 을 검증한다. **던지지 않고 이유를 돌려준다** — 오래된 baseline 을
 * 읽다가 스택 트레이스를 보는 것보다 "이 파일이 왜 못 쓰는지" 를 보는 것이 낫다.
 */
export function parseCaptureMeta(raw: unknown): ParsedMeta {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: '메타가 객체가 아니다.' }
  }
  const m = raw as Record<string, unknown>

  if (m.format !== 'bgra8') {
    return { ok: false, reason: `format 이 'bgra8' 이 아니다: ${JSON.stringify(m.format)}` }
  }
  if (!isPosInt(m.width) || !isPosInt(m.height)) {
    return {
      ok: false,
      reason: `width/height 가 양의 정수가 아니다: ${JSON.stringify(m.width)}x${JSON.stringify(m.height)}`,
    }
  }
  if (typeof m.takenAt !== 'string' || m.takenAt === '') {
    return { ok: false, reason: 'takenAt 이 없다.' }
  }

  // window 는 있으면 좋지만 없어도 이미지 자체는 쓸 수 있다. 비어 있는 기본값으로
  // 채워서 "메타가 부실한 baseline" 도 비교는 되게 한다 — 못 쓰게 만들면 사람이
  // 사이드카를 손으로 고치게 되고, 그러면 더 틀린다.
  const w = (typeof m.window === 'object' && m.window !== null ? m.window : {}) as Record<string, unknown>

  return {
    ok: true,
    meta: {
      format: 'bgra8',
      width: m.width,
      height: m.height,
      takenAt: m.takenAt,
      mode: typeof m.mode === 'string' ? m.mode : '',
      window: {
        title: typeof w.title === 'string' ? w.title : '',
        class: typeof w.class === 'string' ? w.class : '',
        pid: typeof w.pid === 'number' ? w.pid : 0,
        fileVersion: typeof w.fileVersion === 'string' ? w.fileVersion : '',
        width: typeof w.width === 'number' ? w.width : m.width,
        height: typeof w.height === 'number' ? w.height : m.height,
      },
    },
  }
}

/** 버퍼 길이가 메타의 크기와 맞는가. 안 맞으면 둘 중 하나가 잘못된 파일이다. */
export function bufferMatchesMeta(meta: CaptureMeta, byteLength: number): boolean {
  return byteLength === bgraByteLength(meta.width, meta.height)
}

export type BaselineCheck = {
  /** 비교를 진행해도 되는가 */
  usable: boolean
  /** 진행은 되지만 사람이 알아야 하는 것들 */
  warnings: string[]
  reason: string
}

/**
 * baseline 과 지금 캡처를 비교해도 되는가.
 *
 * 크기가 다르면 진행할 수 없다. **버전이 다르면 진행하되 경고한다** — 픽셀 차이가
 * 회귀인지 버전 차이인지 사람이 판단해야 하고, 여기서 막아버리면 버전을 올린 날
 * baseline 전체가 못 쓰게 된다.
 */
export function checkBaseline(baseline: CaptureMeta, current: CaptureMeta): BaselineCheck {
  const warnings: string[] = []

  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      usable: false,
      warnings,
      reason:
        `baseline 은 ${baseline.width}x${baseline.height} 인데 지금은 ${current.width}x${current.height} 다. ` +
        '창 크기를 맞추거나 baseline 을 다시 떠야 한다.',
    }
  }

  if (
    baseline.window.fileVersion !== '' &&
    current.window.fileVersion !== '' &&
    baseline.window.fileVersion !== current.window.fileVersion
  ) {
    warnings.push(
      `baseline 은 앱 ${baseline.window.fileVersion} 에서 떴는데 지금은 ${current.window.fileVersion} 다. ` +
        '픽셀 차이가 회귀가 아니라 버전 차이일 수 있다.',
    )
  }

  if (baseline.mode !== '' && current.mode !== '' && baseline.mode !== current.mode) {
    // printwindow 와 screen 은 3D 영역에서 같게 나오는 것으로 확인됐지만(M1),
    // 가려진 창에서는 screen 이 다른 창을 담는다. 섞어 쓰면 원인을 못 짚는다.
    warnings.push(`캡처 모드가 다르다: baseline=${baseline.mode}, 지금=${current.mode}.`)
  }

  return {
    usable: true,
    warnings,
    reason: `${current.width}x${current.height}, 비교 가능.`,
  }
}
