// 캡처 묶음(.png / .bgra / .json)을 읽고 쓰는 I/O 가장자리. 판단은 하지 않는다.
//
// 한 캡처는 파일 셋으로 이뤄진다. 같은 기본 이름을 공유한다.
//   foo.png   사람이 보는 것 (내가 Read 도구로 직접 본다)
//   foo.bgra  판정용 생 픽셀 — 크기 정보가 없다
//   foo.json  사이드카 메타 — 크기와 어느 창이었는지
//
// `.bgra` 만으로는 이미지를 해석할 수 없어서 셋이 함께 다녀야 한다. 근거는
// captureMeta.ts 머리말.

import { readFileSync, writeFileSync } from 'node:fs'

import { bufferMatchesMeta, parseCaptureMeta } from './captureMeta.ts'
import type { CaptureMeta } from './captureMeta.ts'
import type { Bgra } from './stats.ts'

/** 기본 이름에서 세 경로를 만든다. `.png` 로 주든 확장자 없이 주든 같은 답. */
export function capturePaths(base: string): { png: string; bgra: string; meta: string } {
  const stem = base.replace(/\.(png|bgra|json)$/i, '')
  return { png: `${stem}.png`, bgra: `${stem}.bgra`, meta: `${stem}.json` }
}

export function writeCaptureMeta(base: string, meta: CaptureMeta): string {
  const path = capturePaths(base).meta
  writeFileSync(path, JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return path
}

export type LoadedCapture = { img: Bgra; meta: CaptureMeta }

class CaptureFileError extends Error {}

/**
 * 캡처 묶음을 읽는다. 못 읽으면 **무엇이 없는지 말하는** 예외를 던진다.
 *
 * 사이드카가 없는 것은 흔한 경우다 — 사이드카를 쓰기 전에 뜬 baseline 이거나
 * 사람이 `.bgra` 만 복사한 것이다. 그래서 이유를 구체적으로 적는다.
 */
export function readCapture(base: string): LoadedCapture {
  const p = capturePaths(base)

  let rawMeta: unknown
  try {
    rawMeta = JSON.parse(readFileSync(p.meta, 'utf8'))
  } catch (err) {
    throw new CaptureFileError(
      `사이드카를 읽지 못했다: ${p.meta}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n` +
        '  .bgra 는 자기 크기를 모르므로 사이드카 없이는 해석할 수 없다.',
    )
  }

  const parsed = parseCaptureMeta(rawMeta)
  if (!parsed.ok) {
    throw new CaptureFileError(`사이드카가 쓸 수 없다: ${p.meta}\n  ${parsed.reason}`)
  }

  let data: Uint8Array
  try {
    data = new Uint8Array(readFileSync(p.bgra))
  } catch (err) {
    throw new CaptureFileError(
      `생 픽셀을 읽지 못했다: ${p.bgra}\n  ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!bufferMatchesMeta(parsed.meta, data.length)) {
    throw new CaptureFileError(
      `사이드카와 픽셀 크기가 안 맞는다: ${p.meta} 는 ${parsed.meta.width}x${parsed.meta.height} 라는데 ` +
        `${p.bgra} 는 ${data.length} 바이트다. 둘 중 하나가 다른 캡처의 것이다.`,
    )
  }

  return {
    img: { width: parsed.meta.width, height: parsed.meta.height, data },
    meta: parsed.meta,
  }
}
