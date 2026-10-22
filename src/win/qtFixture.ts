// Qt 픽스처 앱을 띄우는 데 필요한 것들. 테스트와 손 실행이 같은 환경을 쓰게 한다.
//
// **왜 환경변수가 필요한가.** Qt 를 이 리포의 `bin/` 에 복사하지 않는다 — 디버그 Qt
// DLL 은 크고, **대상 앱의 Qt 를 그대로 쓰는 것이 ABI 를 맞추는 가장 확실한 방법**이다.
// 대신 실행할 때 가리킨다.
//   PATH           += <Qt>/bin      Qt5Cored.dll 등을 찾게
//   QT_PLUGIN_PATH  = <repo>/bin/plugins;<Qt>/plugins
//
// **QT_PLUGIN_PATH 에 이 리포를 먼저 둔다.** 스타일 플러그인을 Qt 의 `plugins/styles`
// 에 넣으려면 대상 앱 리포 안에 파일을 만들어야 하고 절대 규칙 2가 그것을 금지한다.
// 경로를 두 개 주면 그럴 필요가 없다.

import { existsSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { zweaveRoot } from './zweaveRoot.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

/** 대상 앱이 쓰는 Qt. 여기에 맞춰 빌드하고 여기서 실행한다. */
export const QT_DIR = resolve(zweaveRoot(), 'external/Qt-5.15.6-lts-lgpl-msvc2019_64')

export const QTAPP_EXE = resolve(ROOT, 'bin/zwqtfixture.exe')
export const QTAPP_TITLE = 'zwqtfixture'

/** 플러그인을 놓는 곳. Qt 는 `<이 경로>/styles/` 에서 스타일 플러그인을 찾는다. */
export const PLUGIN_DIR = resolve(ROOT, 'bin/plugins')
export const ZWAGENT_DLL = resolve(PLUGIN_DIR, 'styles/zwagent.dll')

/** Qt 픽스처를 띄울 환경변수. 현재 환경에 덧붙인 새 객체를 돌려준다. */
export function qtEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v
  }
  return {
    ...base,
    PATH: `${resolve(QT_DIR, 'bin')}${delimiter}${base.PATH ?? base.Path ?? ''}`,
    QT_PLUGIN_PATH: `${PLUGIN_DIR}${delimiter}${resolve(QT_DIR, 'plugins')}`,
    ...extra,
  }
}

/**
 * 그 픽스처 인스턴스의 창만 고르는 필터.
 *
 * **pid 로 좁혀야 한다.** `node --test` 는 테스트 **파일을 병렬로** 돌리므로, 제목만
 * 주면 다른 파일이 띄운 픽스처의 창이 섞인다 — 2026-09-09 에 실제로 겪었다
 * (파일별로는 통과하고 전체 스위트에서만 세 개가 실패했다).
 *
 * 제목도 함께 주는 이유: 콘솔 서브시스템으로 빌드했으므로 같은 pid 에 콘솔 창이
 * 딸릴 수 있다. `zwwin.exe` 의 필터는 AND 로 걸린다.
 */
export function qtFilter(pid: number): { pid: number; title: string } {
  return { pid, title: QTAPP_TITLE }
}

/** 픽스처를 실행할 수 있는가. 못 하면 이유를 돌려준다 — 테스트가 skip 사유로 쓴다. */
export function qtFixtureMissing(): string | false {
  if (!existsSync(QTAPP_EXE)) {
    return `${QTAPP_EXE} 가 없다. bash fixtures/qtapp/build.sh 를 먼저 실행한다.`
  }
  if (!existsSync(resolve(QT_DIR, 'bin/Qt5Cored.dll'))) {
    return `Qt 디버그 DLL 을 찾을 수 없다: ${QT_DIR}/bin/Qt5Cored.dll`
  }
  return false
}
