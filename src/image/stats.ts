// 캡처된 원시 픽셀에 대한 순수 판정. 의존성 0, I/O 0.
//
// zwwin.exe 는 BGRA8 바이트만 뱉는다. "검은 화면인가", "캡처가 실패했나" 같은
// 판단은 전부 여기 있다 — CLAUDE.md 절대 규칙 5.

export type Bgra = {
  width: number
  height: number
  /** 위에서 아래로, 행당 width*4 바이트, B G R A 순서 */
  data: Uint8Array
}

export type ImageStats = {
  pixels: number
  /** r=g=b=0 인 픽셀의 비율 (0..1) */
  blackRatio: number
  /** ITU-R BT.709 휘도 평균 (0..255) */
  meanLuminance: number
  /** 샘플링해 센 고유 색상 수 */
  distinctColors: number
  /** 모든 픽셀이 같은 색이면 0xRRGGBB, 아니면 null */
  uniformColor: number | null
}

const SAMPLE_STRIDE = 37 // 소수라서 규칙적인 격자 무늬와 어긋난다

export function bgraByteLength(width: number, height: number): number {
  return width * height * 4
}

/** 버퍼 길이가 width×height×4 와 맞는지. 안 맞으면 캡처가 깨진 것이다. */
export function isWellFormed(img: Bgra): boolean {
  return (
    Number.isInteger(img.width) &&
    Number.isInteger(img.height) &&
    img.width > 0 &&
    img.height > 0 &&
    img.data.length === bgraByteLength(img.width, img.height)
  )
}

export function analyze(img: Bgra): ImageStats {
  if (!isWellFormed(img)) {
    throw new Error(
      `BGRA 버퍼가 크기와 맞지 않는다: ${img.width}x${img.height} 는 ` +
        `${bgraByteLength(img.width, img.height)} 바이트여야 하는데 ${img.data.length} 바이트다`,
    )
  }

  const pixels = img.width * img.height
  const colors = new Set<number>()
  let black = 0
  let luminanceSum = 0
  let first = -1
  let uniform = true

  for (let i = 0; i < pixels; i++) {
    const o = i * 4
    const b = img.data[o]!
    const g = img.data[o + 1]!
    const r = img.data[o + 2]!

    if (r === 0 && g === 0 && b === 0) black++
    luminanceSum += 0.2126 * r + 0.7152 * g + 0.0722 * b

    const rgb = (r << 16) | (g << 8) | b
    if (first < 0) first = rgb
    else if (uniform && rgb !== first) uniform = false

    if (i % SAMPLE_STRIDE === 0) colors.add(rgb)
  }

  return {
    pixels,
    blackRatio: black / pixels,
    meanLuminance: luminanceSum / pixels,
    distinctColors: colors.size,
    uniformColor: uniform ? first : null,
  }
}

export type BlankVerdict = {
  blank: boolean
  /** 사람이 읽는 근거. blank 가 false 면 빈 문자열 */
  reason: string
}

/**
 * 캡처가 사실상 아무것도 담고 있지 않은지 판정한다.
 *
 * PrintWindow 가 GPU 합성 콘텐츠를 못 잡으면 해당 영역이 통째로 단색(보통 검정)으로
 * 나온다. 그 실패를 "정상적으로 어두운 화면"과 구분해야 한다 — 다크 테마 UI 는
 * 평균 휘도가 낮지만 색이 다양하다. 그래서 휘도가 아니라 **다양성**으로 가른다.
 */
export function judgeBlank(stats: ImageStats): BlankVerdict {
  if (stats.uniformColor !== null) {
    const hex = stats.uniformColor.toString(16).padStart(6, '0')
    return { blank: true, reason: `전체가 단색 #${hex} 이다` }
  }
  if (stats.blackRatio >= 0.99) {
    return {
      blank: true,
      reason: `픽셀의 ${(stats.blackRatio * 100).toFixed(1)}% 가 완전한 검정이다`,
    }
  }
  if (stats.distinctColors <= 2) {
    return {
      blank: true,
      reason: `고유 색상이 ${stats.distinctColors} 개뿐이다`,
    }
  }
  return { blank: false, reason: '' }
}
