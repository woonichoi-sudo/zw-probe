// 대상 앱(Z-Weave) 리포가 어디 있는가.
//
// `ZWEAVE_ROOT` 가 있으면 그것, 없으면 이 리포 옆의 `../Z-Weave`. 두 리포를 같은 폴더에
// 나란히 두는 배치(d:/z-emotion/, agent-workbench 의 _clones/)를 그대로 따른다.
// 셸 스크립트는 같은 규칙을 tools/zweave-root.sh 로 쓴다.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function zweaveRoot(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.ZWEAVE_ROOT
  return fromEnv ? resolve(fromEnv) : resolve(ROOT, '..', 'Z-Weave')
}
