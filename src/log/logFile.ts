// 로그 파일을 찾아 읽는다. 고르는 규칙은 순수 함수로 떼어 테스트한다.
//
//   %LOCALAPPDATA%/z-emotion/z-weave/log/z-weave_{버전}_{UTC시각}.log
//
// 단축키(%APPDATA%, Roaming)와 루트가 다르다 — 설계문서 §3.6.
// **실행마다 새 파일이 생긴다.** 고정 경로가 없으므로 매번 고르는 단계가 필요하다.

import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseLogEntries, parseLogFileName } from './parse.ts'
import type { LogEntry } from './parse.ts'

export const APP_VENDOR = 'z-emotion'
export const APP_NAME = 'z-weave'
export const LOG_SUBDIR = 'log'

/**
 * 로그 폴더. **macOS 는 `~/Library/Application Support/z-emotion/z-weave/log`** 다 (2026-10-12 실측) —
 * Qt 의 AppDataLocation 이고 단축키(shortcutFile.ts)와 루트가 같다. 파일 이름 규칙은 같다.
 */
export function logDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (platform === 'darwin') {
    const home = env.HOME
    return home === undefined || home === '' ? null : join(home, 'Library', 'Application Support', APP_VENDOR, APP_NAME, LOG_SUBDIR)
  }
  const local = env.LOCALAPPDATA
  if (local === undefined || local === '') return null
  return join(local, APP_VENDOR, APP_NAME, LOG_SUBDIR)
}

export type LogPick = {
  name: string
  /**
   * exact  — 실행 중인 앱 버전과 같은 버전의 로그
   * newest — 버전이 일치하는 로그가 없어 전체 최신을 골랐다
   */
  how: 'exact' | 'newest'
}

/**
 * 읽을 로그 파일을 고른다.
 *
 * 파일명에 박힌 시각으로 정렬한다. mtime 이 아니다 — mtime 은 마지막 쓰기 시각이라
 * 오래 전에 띄워 계속 로그를 쓰는 세션이 방금 띄운 세션보다 나중으로 보일 수 있다.
 * 시작 시각으로 정렬하면 "가장 최근에 시작된 세션"이 정확히 잡힌다.
 *
 * 버전을 알면 그 버전을 우선한다. 디스크에 여러 버전의 로그가 섞여 있다(실측).
 */
export function pickLogFile(names: readonly string[], appVersion?: string): LogPick | null {
  const parsed = names
    .map((name) => ({ name, info: parseLogFileName(name) }))
    .filter((x): x is { name: string; info: NonNullable<typeof x.info> } => x.info !== null)

  if (parsed.length === 0) return null

  const byTimeDesc = (a: (typeof parsed)[number], b: (typeof parsed)[number]) =>
    b.info.startedUtc.getTime() - a.info.startedUtc.getTime()

  if (appVersion !== undefined && appVersion !== '') {
    const matching = parsed.filter((x) => x.info.appVersion === appVersion).sort(byTimeDesc)
    if (matching.length > 0) return { name: matching[0]!.name, how: 'exact' }
  }

  const newest = [...parsed].sort(byTimeDesc)[0]!
  return { name: newest.name, how: 'newest' }
}

export type LocatedLog = LogPick & {
  path: string
  appVersion: string
  startedUtc: Date
  sizeBytes: number
}

export function locateLog(
  appVersion?: string,
  env: NodeJS.ProcessEnv = process.env,
): LocatedLog | null {
  const dir = logDir(env)
  if (dir === null || !existsSync(dir)) return null

  const pick = pickLogFile(readdirSync(dir), appVersion)
  if (pick === null) return null

  const path = join(dir, pick.name)
  const info = parseLogFileName(pick.name)!
  return {
    ...pick,
    path,
    appVersion: info.appVersion,
    startedUtc: info.startedUtc,
    sizeBytes: statSync(path).size,
  }
}

export function readEntries(path: string): LogEntry[] {
  return parseLogEntries(readFileSync(path, 'utf8'))
}

export type TailResult = {
  /** 읽어들인 본문. 마지막 개행까지만 담는다 */
  text: string
  /** 다음에 이어 읽을 바이트 위치 */
  offset: number
}

/**
 * `offset` 부터 파일 끝까지 읽는다. **마지막 개행 뒤의 조각은 남긴다** —
 * 앱이 항목을 쓰는 중일 수 있고, 잘린 줄을 파싱하면 앵커가 깨진다.
 * 남긴 조각은 다음 호출에서 이어 읽힌다.
 *
 * 파일이 offset 보다 작아졌으면(새 세션이 시작돼 다른 파일을 보고 있거나 잘렸으면)
 * 0 부터 다시 읽는다.
 */
export function tailFrom(path: string, offset: number): TailResult {
  const size = statSync(path).size
  const start = offset > size ? 0 : offset
  if (size === start) return { text: '', offset: start }

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    const read = readSync(fd, buf, 0, buf.length, start)
    const chunk = buf.subarray(0, read).toString('utf8')

    const lastNewline = chunk.lastIndexOf('\n')
    if (lastNewline < 0) return { text: '', offset: start } // 아직 완전한 줄이 없다

    return {
      text: chunk.slice(0, lastNewline + 1),
      offset: start + Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8'),
    }
  } finally {
    closeSync(fd)
  }
}
