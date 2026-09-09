// 두 캡처를 비교하는 순수 판정. 의존성 0, I/O 0 (CLAUDE.md 절대 규칙 5).
//
// 두 곳에 쓰인다.
//   ① baseline 비교 — "정상 화면과 같은가"
//   ② 전후 비교 — "내 입력이 화면을 실제로 바꿨는가"
//
// ②가 중요하다. 단축키를 보냈는데 아무 일도 안 일어난 것과, 보낸 것이 통했는데
// 화면에 변화가 없는 것은 다르다. 후자는 드물고 전자는 흔하다 — 포그라운드를
// 놓쳤거나 앱이 그 상태에서 그 명령을 무시한 경우다. **전후가 픽셀 하나도 다르지
// 않으면 그 단계는 실패로 봐야 한다.**

import { bgraByteLength, isWellFormed } from './stats.ts'
import type { Bgra } from './stats.ts'

export type Rect = { x: number; y: number; width: number; height: number }

export type DiffOptions = {
  /**
   * 채널당 이 값 이하 차이는 같다고 본다. 기본 2 —
   * 캡처 경로에서 1~2 는 흔들린다(픽스처 테스트에서 tol 8 을 쓴 것과 같은 이유).
   */
  tolerance?: number
  /**
   * 비교에서 뺄 영역들. 늘 변하는 것(시계, 프레임 카운터, 커서)을 빼는 데 쓴다.
   * 여기를 안 빼면 baseline 이 매번 실패해서 아무도 안 쓰게 된다.
   */
  ignore?: readonly Rect[]
}

export type DiffResult =
  | { comparable: false; reason: string }
  | {
      comparable: true
      /** 실제로 비교한 픽셀 수 (ignore 제외) */
      compared: number
      /** tolerance 를 넘게 다른 픽셀 수 */
      changed: number
      /** changed / compared (0..1). compared 가 0 이면 0 */
      changedRatio: number
      /** 달라진 픽셀을 감싸는 최소 사각형. 하나도 안 다르면 null */
      bounds: Rect | null
      /** 가장 크게 어긋난 채널 차이 (0..255) */
      maxDelta: number
    }

/** 점이 사각형 안인가. 오른쪽·아래 경계는 포함하지 않는다. */
function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height
}

/**
 * 두 이미지를 픽셀 단위로 비교한다.
 *
 * 크기가 다르면 `comparable: false` 다. **"전부 다르다" 로 뭉개지 않는다** —
 * 창 크기가 바뀐 것과 내용이 바뀐 것은 원인이 다르고, 섞으면 baseline 실패를
 * 볼 때마다 창 크기를 먼저 의심해야 하는지 알 수 없다.
 */
export function diff(a: Bgra, b: Bgra, opts: DiffOptions = {}): DiffResult {
  if (!isWellFormed(a)) {
    return {
      comparable: false,
      reason: `첫 이미지가 깨졌다: ${a.width}x${a.height} 인데 ${a.data.length} 바이트 (${bgraByteLength(a.width, a.height)} 이어야 한다)`,
    }
  }
  if (!isWellFormed(b)) {
    return {
      comparable: false,
      reason: `둘째 이미지가 깨졌다: ${b.width}x${b.height} 인데 ${b.data.length} 바이트 (${bgraByteLength(b.width, b.height)} 이어야 한다)`,
    }
  }
  if (a.width !== b.width || a.height !== b.height) {
    return {
      comparable: false,
      reason: `크기가 다르다: ${a.width}x${a.height} vs ${b.width}x${b.height}. 창 크기가 바뀌었다.`,
    }
  }

  const tolerance = opts.tolerance ?? 2
  const ignore = opts.ignore ?? []

  let compared = 0
  let changed = 0
  let maxDelta = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      // ignore 는 보통 0~2 개다. 픽셀마다 도는 비용이 사각형 수에 비례하므로
      // 많이 주면 느려진다 — 그럴 일이 생기면 행 단위로 미리 걸러야 한다.
      let skip = false
      for (const r of ignore) {
        if (inRect(r, x, y)) {
          skip = true
          break
        }
      }
      if (skip) continue

      compared++
      const o = (y * a.width + x) * 4
      // 알파는 보지 않는다. PrintWindow 가 알파를 채우지 않는 경우가 있어
      // 색이 같은데 알파만 달라 전부 "변경" 으로 잡히는 일이 생긴다.
      const db = Math.abs(a.data[o]! - b.data[o]!)
      const dg = Math.abs(a.data[o + 1]! - b.data[o + 1]!)
      const dr = Math.abs(a.data[o + 2]! - b.data[o + 2]!)
      const d = db > dg ? (db > dr ? db : dr) : dg > dr ? dg : dr
      if (d > maxDelta) maxDelta = d

      if (d > tolerance) {
        changed++
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  return {
    comparable: true,
    compared,
    changed,
    changedRatio: compared === 0 ? 0 : changed / compared,
    bounds:
      changed === 0
        ? null
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    maxDelta,
  }
}

export type SameVerdict = {
  /** 같다고 볼 수 있는가. 비교 자체가 불가능하면 false */
  same: boolean
  reason: string
}

/**
 * baseline 과 같은가.
 *
 * `maxChangedRatio` 기본값은 0 이다 — **기본은 "픽셀 하나도 다르면 실패"** 다.
 * 흔들리는 영역이 있으면 `ignore` 로 빼는 것이 임계값을 올리는 것보다 낫다.
 * 임계값을 올리면 어디가 달라졌는지와 무관하게 통과하므로, 작은 진짜 회귀
 * (아이콘 하나가 사라짐)를 놓친다.
 */
export function judgeSame(result: DiffResult, maxChangedRatio = 0): SameVerdict {
  if (!result.comparable) {
    return { same: false, reason: result.reason }
  }
  if (result.changed === 0) {
    return { same: true, reason: `${result.compared}개 픽셀이 모두 같다.` }
  }
  const pct = (result.changedRatio * 100).toFixed(3)
  const b = result.bounds!
  const where = `달라진 영역 (${b.x},${b.y}) ${b.width}x${b.height}`
  if (result.changedRatio <= maxChangedRatio) {
    return {
      same: true,
      reason: `${result.changed}개(${pct}%)가 다르지만 임계값 ${(maxChangedRatio * 100).toFixed(3)}% 안이다. ${where}`,
    }
  }
  return {
    same: false,
    reason: `${result.changed}개(${pct}%)가 다르다. 최대 채널 차이 ${result.maxDelta}. ${where}`,
  }
}

export type ChangedVerdict = {
  /** 화면이 실제로 바뀌었는가 */
  changed: boolean
  reason: string
}

/**
 * 입력이 화면을 바꿨는가. `judgeSame` 의 반대 질문이고 **기본 기대가 반대다.**
 *
 * 단축키나 클릭을 보낸 뒤 이것으로 확인한다. 전후가 같으면 그 단계는 통하지
 * 않은 것이다 — 포그라운드를 놓쳤거나 앱이 그 상태에서 명령을 무시했다.
 * `minChangedRatio` 는 잡음만큼 바뀐 것을 "바뀌었다" 로 세지 않기 위한 하한이다.
 */
export function judgeChanged(result: DiffResult, minChangedRatio = 0): ChangedVerdict {
  if (!result.comparable) {
    // 크기가 바뀐 것도 변화이긴 하지만, 비교 없이 단정하면 창이 리사이즈된 것을
    // "명령이 통했다" 로 읽는다. 모른다고 답하는 쪽이 낫다.
    return { changed: false, reason: `비교할 수 없다 — ${result.reason}` }
  }
  if (result.changed === 0) {
    return {
      changed: false,
      reason: `${result.compared}개 픽셀이 모두 같다. 입력이 화면을 바꾸지 못했다.`,
    }
  }
  const pct = (result.changedRatio * 100).toFixed(3)
  const b = result.bounds!
  if (result.changedRatio <= minChangedRatio) {
    return {
      changed: false,
      reason: `${result.changed}개(${pct}%)만 달라 하한 ${(minChangedRatio * 100).toFixed(3)}% 아래다. 잡음일 수 있다.`,
    }
  }
  return {
    changed: true,
    reason: `${result.changed}개(${pct}%)가 달라졌다. 영역 (${b.x},${b.y}) ${b.width}x${b.height}`,
  }
}
