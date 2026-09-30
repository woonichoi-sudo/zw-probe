// 녹화의 판단 — 옵션 검증, 진행 중 상태 해석, 결과 판정. I/O 는 하지 않는다.
//
// 녹화는 다른 조작(click·key·trigger)과 **동시에** 돌아야 하므로 zwwin.exe record 를 백그라운드로
// 띄운다. 그래서 CLI 한 번의 호출로 끝나지 않고 start → (조작) → stop 세 걸음이 된다.
// 그 사이를 잇는 것이 상태 파일(runs/recording.json)이고, 멈추는 신호는 정지 파일이다 —
// 프로세스를 죽이면 MP4 의 moov 가 안 써져서 재생되지 않는 파일이 남는다.

import type { WindowInfo } from '../win/zwwin.ts'

export type RecordMode = 'screen' | 'printwindow'

export type RecordOptions = {
  out: string
  fps: number
  maxSeconds: number
  mode: RecordMode
  cursor: boolean
}

export const RECORD_DEFAULTS = { fps: 10, maxSeconds: 600, mode: 'screen' as RecordMode, cursor: true }

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string }

/** 사람이 준 문자열 옵션을 검증한다. 모르는 값을 조용히 기본값으로 바꾸지 않는다. */
export function validateRecordOptions(input: {
  out: string
  fps?: string
  maxSeconds?: string
  mode?: string
  noCursor?: boolean
}): Validated<RecordOptions> {
  if (!/\.mp4$/i.test(input.out)) return { ok: false, reason: `--out 은 .mp4 여야 한다: ${input.out}` }

  let fps = RECORD_DEFAULTS.fps
  if (input.fps !== undefined) {
    fps = Number(input.fps)
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) return { ok: false, reason: `--fps 는 1~60 의 정수다: ${input.fps}` }
  }

  let maxSeconds = RECORD_DEFAULTS.maxSeconds
  if (input.maxSeconds !== undefined) {
    maxSeconds = Number(input.maxSeconds)
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 3600)
      return { ok: false, reason: `--max-seconds 는 0 초과 3600 이하다: ${input.maxSeconds}` }
  }

  let mode = RECORD_DEFAULTS.mode
  if (input.mode !== undefined) {
    if (input.mode !== 'screen' && input.mode !== 'printwindow')
      return { ok: false, reason: `--mode 는 screen 또는 printwindow 다: ${input.mode}` }
    mode = input.mode
  }

  return { ok: true, value: { out: input.out, fps, maxSeconds, mode, cursor: input.noCursor !== true } }
}

/** 진행 중인 녹화 하나. start 가 쓰고 status·stop 이 읽는다. */
export type RecordingState = {
  pid: number
  out: string
  result: string
  stop: string
  startedAt: string
  fps: number
  maxSeconds: number
  mode: RecordMode
}

export function parseRecordingState(text: string): Validated<RecordingState> {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, reason: '상태 파일이 JSON 이 아니다' }
  }
  const o = j as Record<string, unknown>
  for (const k of ['out', 'result', 'stop', 'startedAt', 'mode'] as const) {
    if (typeof o[k] !== 'string') return { ok: false, reason: `상태 파일에 ${k} 가 없다` }
  }
  for (const k of ['pid', 'fps', 'maxSeconds'] as const) {
    if (typeof o[k] !== 'number') return { ok: false, reason: `상태 파일에 ${k} 가 없다` }
  }
  return { ok: true, value: o as unknown as RecordingState }
}

/** 녹화가 시작한 지 몇 초인가, 상한까지 몇 초 남았나. */
export function elapsedSeconds(state: RecordingState, now: Date): { elapsed: number; remaining: number } {
  const elapsed = Math.max(0, (now.getTime() - Date.parse(state.startedAt)) / 1000)
  return { elapsed, remaining: Math.max(0, state.maxSeconds - elapsed) }
}

export type RecordResult = {
  ok: true
  out: string
  bytes: number
  /** 영상에 들어간 프레임 수 (복제 포함) */
  frames: number
  /** 캡처 자체가 실패한 횟수. 그 프레임은 직전 화면으로 남는다 */
  captureFailures: number
  /** 캡처가 fps 를 못 따라가 직전 화면을 복제해 채운 프레임 수 */
  duplicated: number
  seconds: number
  fps: number
  width: number
  height: number
  mode: string
  stopReason: 'stop' | 'max-seconds' | 'window-gone'
  window: WindowInfo
}

export type RecordFailure = { ok: false; error: string }

export function parseRecordResult(text: string): RecordResult | RecordFailure {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return { ok: false, error: `결과 파일이 JSON 이 아니다: ${text.slice(0, 200)}` }
  }
  const o = j as { ok?: unknown; error?: unknown; frames?: unknown }
  if (o.ok !== true) return { ok: false, error: typeof o.error === 'string' ? o.error : '원인 없이 실패했다' }
  if (typeof o.frames !== 'number') return { ok: false, error: '결과에 frames 가 없다' }
  return j as RecordResult
}

export type RecordVerdict = { usable: boolean; notes: string[] }

/**
 * 영상을 쓸 수 있는가. 판단 기준은 셋이다:
 *  - 프레임이 하나도 없으면 쓸 수 없다
 *  - 캡처 실패가 절반을 넘으면 쓸 수 없다 (그 프레임은 직전 화면이나 빈 화면이다)
 *  - 복제가 많으면 쓸 수는 있지만 끊겨 보인다 — 알린다
 * 창이 사라져서 멈췄으면 사람이 기대한 끝이 아닐 수 있으므로 알린다.
 * file 을 주면 파일 자체도 본다 — moov 가 없으면 쓸 수 없고, 샘플 수가 다르면 알린다.
 */
export function judgeRecording(r: RecordResult, file?: Mp4Summary): RecordVerdict {
  const notes: string[] = []
  if (r.frames === 0) return { usable: false, notes: ['프레임이 하나도 없다'] }
  if (file !== undefined) {
    if (!file.hasMoov) return { usable: false, notes: ['MP4 에 moov 가 없다 — 마무리되지 않아 재생되지 않는다'] }
    if (file.samples !== r.frames) {
      notes.push(`zwwin 은 ${r.frames} 프레임을 넣었다고 했는데 파일에는 ${file.samples} 개가 있다 — 인코더가 버렸다`)
    }
  }

  const captured = r.frames - r.duplicated
  if (r.captureFailures > captured / 2) {
    return { usable: false, notes: [`캡처 ${captured} 번 중 ${r.captureFailures} 번 실패했다`] }
  }
  if (r.captureFailures > 0) notes.push(`캡처 실패 ${r.captureFailures} 번 — 그 프레임은 직전 화면으로 남았다`)

  const dupRatio = r.duplicated / r.frames
  if (dupRatio > 0.3) {
    notes.push(
      `프레임의 ${(dupRatio * 100).toFixed(0)}% 가 복제다 — 캡처가 ${r.fps} fps 를 못 따라갔다. 끊겨 보이면 fps 를 낮춘다`,
    )
  }

  if (r.stopReason === 'window-gone') notes.push('대상 창이 사라져서 멈췄다 (앱이 닫혔다)')
  if (r.stopReason === 'max-seconds') notes.push('최대 시간에 닿아 멈췄다')
  return { usable: true, notes }
}

export type Mp4Summary = {
  /** moov 가 있는가. 없으면 마무리(Finalize)가 안 된 파일이라 재생되지 않는다 */
  hasMoov: boolean
  /** 첫 비디오 트랙의 샘플(프레임) 수. stsz 를 못 찾으면 0 */
  samples: number
  /** mvhd 의 길이(초). 못 읽으면 0 */
  seconds: number
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

/**
 * MP4 의 박스를 훑어 재생 가능한 모양인지 본다. 디코딩은 하지 않는다 —
 * zwwin.exe 가 "썼다" 고 보고한 것과 **파일에 실제로 들어간 것**을 맞춰 보려는 것이다
 * (2026-09-30 실측: 하드웨어 인코더가 50 프레임을 받고 43 개만 썼다).
 */
export function readMp4Summary(buf: Uint8Array): Mp4Summary {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const out: Mp4Summary = { hasMoov: false, samples: 0, seconds: 0 }

  const walk = (start: number, end: number): void => {
    let off = start
    while (off + 8 <= end) {
      let size = view.getUint32(off)
      const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!)
      let header = 8
      if (size === 1) {
        if (off + 16 > end) return
        size = Number(view.getBigUint64(off + 8))
        header = 16
      } else if (size === 0) {
        size = end - off
      }
      if (size < header || off + size > end) return
      const body = off + header

      if (type === 'moov') out.hasMoov = true
      if (CONTAINERS.has(type)) walk(body, off + size)
      else if (type === 'mvhd' && body + 20 <= end) {
        const version = buf[body]!
        const timescale = version === 1 ? view.getUint32(body + 20) : view.getUint32(body + 12)
        const duration = version === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16)
        if (timescale > 0) out.seconds = duration / timescale
      } else if (type === 'stsz' && out.samples === 0 && body + 12 <= end) {
        out.samples = view.getUint32(body + 8)
      }
      off += size
    }
  }
  walk(0, buf.byteLength)
  return out
}
