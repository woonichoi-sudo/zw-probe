// shortcut.ini 를 찾아 읽는다. 경로 선택 규칙은 순수 함수로 떼어 테스트한다.
//
// 대상 앱은 버전별 디렉토리에 설정을 둔다:
//   %APPDATA%/z-emotion/z-weave/{버전}/shortcut.ini
// 로그(%LOCALAPPDATA%)와 루트가 다르다 — 설계문서 §3.6.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseShortcutIni } from './shortcut.ts'
import type { ShortcutFile } from './shortcut.ts'

export const APP_VENDOR = 'z-emotion'
export const APP_NAME = 'z-weave'

/** 버전 문자열을 마디 배열로. 뒤쪽 0 은 잘라서 `5.0.34` 와 `5.0.34.0` 이 같아지게 한다. */
function normalizeVersion(v: string): number[] {
  const parts = v.split('.').map(Number)
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop()
  return parts
}

function sameVersion(a: string, b: string): boolean {
  const x = normalizeVersion(a)
  const y = normalizeVersion(b)
  return x.length === y.length && x.every((n, i) => n === y[i])
}

export type VersionPick = {
  version: string
  /**
   * exact       — 실행 중인 앱 버전과 정확히 일치
   * normalized  — 뒤쪽 0 만 다름 (`5.0.34` vs `5.0.34.0`)
   * newest      — 일치하는 것이 없어 최신을 골랐다. **다른 버전의 단축키일 수 있다**
   */
  how: 'exact' | 'normalized' | 'newest'
}

/**
 * 읽을 버전 디렉토리를 고른다.
 *
 * 최신을 고르는 것이 기본값이면 안 된다. 2026-09-09 실측에서 디렉토리에 `5.0.34` 와
 * `5.1.0` 이 함께 있었고 실행 중인 앱은 `5.0.34` 였다. 최신을 골라 `5.1.0` 의 단축키를
 * 읽으면 버전 간에 매핑이 바뀐 항목에서 **다른 명령을 실행한다.** 그래서 실행 중인
 * 앱 버전을 우선하고, 못 맞추면 그 사실을 `how` 로 알린다.
 */
export function pickVersionDir(names: readonly string[], appVersion?: string): VersionPick | null {
  if (appVersion !== undefined && appVersion !== '') {
    const exact = names.find((n) => n === appVersion)
    if (exact !== undefined) return { version: exact, how: 'exact' }

    const normalized = names.find((n) => /^\d+(\.\d+)*$/.test(n) && sameVersion(n, appVersion))
    if (normalized !== undefined) return { version: normalized, how: 'normalized' }
  }

  const newest = pickNewestVersion(names)
  return newest === null ? null : { version: newest, how: 'newest' }
}

/**
 * 버전 디렉토리 이름들 중 가장 높은 것. `5.1.0` 이 `5.0.34` 보다 높다.
 *
 * 문자열 비교로는 안 된다 — `"5.0.34" > "5.1.0"` 이 참이기 때문이다.
 * 마디를 숫자로 비교한다. 숫자가 아닌 이름은 후보에서 뺀다.
 */
export function pickNewestVersion(names: readonly string[]): string | null {
  const parsed = names
    .filter((n) => /^\d+(\.\d+)*$/.test(n))
    .map((n) => ({ name: n, parts: n.split('.').map(Number) }))

  if (parsed.length === 0) return null

  parsed.sort((a, b) => {
    const len = Math.max(a.parts.length, b.parts.length)
    for (let i = 0; i < len; i++) {
      const d = (b.parts[i] ?? 0) - (a.parts[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })
  return parsed[0]!.name
}

/**
 * 버전 폴더들의 루트. **macOS 는 `~/Library/Application Support/z-emotion/z-weave`** (Qt AppDataLocation).
 * 앱이 버전 폴더를 안 만들고 shortcut.ini 를 써서 macOS 에서는 파일이 없을 수 있다 —
 * `tools/launch-zweave.sh` 가 폴더를 먼저 만든다(2026-10-12, zwShortcutManager::WriteToDisk).
 */
export function appDataRoot(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  if (platform === 'darwin') {
    const home = env.HOME
    return home === undefined || home === '' ? null : join(home, 'Library', 'Application Support', APP_VENDOR, APP_NAME)
  }
  const appData = env.APPDATA
  if (appData === undefined || appData === '') return null
  return join(appData, APP_VENDOR, APP_NAME)
}

export type LocatedShortcutFile = {
  path: string
  /** 설정 디렉토리 이름 = 앱 버전. ini 안의 `Version=`(스키마 버전)과 다른 값이다 */
  appVersion: string
  /** 그 디렉토리를 어떻게 골랐는가 */
  how: VersionPick['how']
}

/** 대상 앱 버전에 맞는 shortcut.ini 를 찾는다. 없으면 null. */
export function locateShortcutIni(
  appVersion?: string,
  env: NodeJS.ProcessEnv = process.env,
): LocatedShortcutFile | null {
  const root = appDataRoot(env)
  if (root === null || !existsSync(root)) return null

  const pick = pickVersionDir(readdirSync(root), appVersion)
  if (pick === null) return null

  const path = join(root, pick.version, 'shortcut.ini')
  return existsSync(path) ? { path, appVersion: pick.version, how: pick.how } : null
}

/**
 * `version` 은 ini 안의 스키마 버전(`1.6`), `appVersion` 은 디렉토리 = 앱 버전(`5.0.34`).
 * 이 둘을 같은 이름으로 두면 스프레드에서 조용히 덮인다 — 실제로 그 버그를 냈다.
 */
export type LoadedShortcuts = ShortcutFile & LocatedShortcutFile

export function loadShortcuts(
  appVersion?: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedShortcuts {
  const found = locateShortcutIni(appVersion, env)
  if (found === null) {
    throw new Error(
      `shortcut.ini 를 찾지 못했다. ${appDataRoot(env) ?? '%APPDATA%'} 아래 ` +
        '버전 디렉토리를 확인한다. 대상 앱을 한 번도 실행하지 않았으면 없을 수 있다.',
    )
  }
  return { ...parseShortcutIni(readFileSync(found.path, 'utf8')), ...found }
}
