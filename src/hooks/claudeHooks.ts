// Claude Code 훅 설치·제거 — zw-probe 가 스스로 그 PC 의 사용자 설정에 넣고 뺀다 (2026-11-17).
//
// 훅은 tools/claude-hooks/frame-busy.mjs 를 부른다: 요청을 보내면 busy, 답을 마치거나 세션이 끝나면 idle.
// 가상 커서 프레임이 그 표시를 보고 "Claude Code 가 일하는 동안" 사람 클릭을 막는다. 훅이 없어도 zw-probe 는
// 그대로 돈다(마지막 가상 입력 뒤 10초만 막는다) — 훅은 Claude Code 를 쓸 때 붙는 선택 기능이고, 다른 리포에
// 기대지 않게 경로는 이 사본의 위치로 적는다.
//
// 설정 파일: ZWPROBE_CLAUDE_SETTINGS (시험용) > $CLAUDE_CONFIG_DIR/settings.json > ~/.claude/settings.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOOK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/claude-hooks/frame-busy.mjs').replace(/\\/g, '/')

/** 우리 훅인지 — 명령에 이 스크립트 이름이 있으면 */
const OURS = 'frame-busy.mjs'

const EVENTS: Array<[string, 'busy' | 'idle']> = [
  ['UserPromptSubmit', 'busy'],
  ['Stop', 'idle'],
  ['SessionEnd', 'idle'],
]

type Hook = { type?: string; command?: string; [k: string]: unknown }
type Entry = { matcher?: string; hooks?: Hook[]; [k: string]: unknown }
type Settings = Record<string, unknown> & { hooks?: Record<string, Entry[]> }

export type InstallOptions = { node: string; script: string }

const commandFor = (o: InstallOptions, action: string) => `"${o.node}" "${o.script}" ${action}`

/** 우리 훅을 뺀다. 비게 된 항목·이벤트·hooks 는 지운다. 다른 것은 그대로 */
export function uninstallHooks(settings: Settings): Settings {
  const hooks = settings.hooks
  if (hooks === undefined) return settings
  for (const ev of Object.keys(hooks)) {
    const kept: Entry[] = []
    for (const entry of hooks[ev] ?? []) {
      const list = (entry.hooks ?? []).filter((h) => !(typeof h.command === 'string' && h.command.includes(OURS)))
      if (list.length > 0) kept.push({ ...entry, hooks: list })
      else if ((entry.hooks ?? []).length === 0) kept.push(entry) // 원래 빈 항목은 건드리지 않는다
    }
    if (kept.length > 0) hooks[ev] = kept
    else delete hooks[ev]
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks
  return settings
}

/** 우리 훅 3 개를 넣는다. 먼저 빼고 넣으므로 두 번 해도 하나씩이고, 경로가 바뀌면 새 경로가 된다 */
export function installHooks(settings: Settings, o: InstallOptions): Settings {
  uninstallHooks(settings)
  const hooks = (settings.hooks ??= {})
  for (const [ev, action] of EVENTS) {
    ;(hooks[ev] ??= []).push({ hooks: [{ type: 'command', command: commandFor(o, action), timeout: 5 }] })
  }
  return settings
}

/** 설치 뒤 알릴 것. 가상 커서 프레임은 지금 Windows(zwwin.exe)에만 있다 */
export function platformNote(platform: string): string | undefined {
  if (platform === 'darwin') return 'Mac 에는 아직 가상 커서 프레임이 없어 지금은 효과가 없다 (훅은 작업 표시 파일만 쓰고 지운다).'
  return undefined
}

export function settingsPath(): string {
  if (process.env.ZWPROBE_CLAUDE_SETTINGS) return process.env.ZWPROBE_CLAUDE_SETTINGS
  if (process.env.CLAUDE_CONFIG_DIR) return join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
  return join(homedir(), '.claude', 'settings.json')
}

/** CLI: install-hooks · uninstall-hooks. 깨진 JSON 이면 아무것도 쓰지 않고 1 */
export function cmdHooks(verb: 'install-hooks' | 'uninstall-hooks'): number {
  const file = settingsPath()
  let settings: Settings = {}
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8')
    try {
      settings = text.trim() === '' ? {} : (JSON.parse(text) as Settings)
    } catch (err) {
      console.error(`설정 파일이 올바른 JSON 이 아니라 건드리지 않았다: ${file}\n${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }
  if (verb === 'install-hooks') {
    installHooks(settings, { node: process.execPath.replace(/\\/g, '/'), script: HOOK_SCRIPT })
  } else {
    uninstallHooks(settings)
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  if (verb === 'install-hooks') {
    console.log(`훅  ${file} 에 넣었다 — UserPromptSubmit(busy) · Stop · SessionEnd(idle) → ${HOOK_SCRIPT}`)
    console.log('    Claude Code 가 일하는 동안 가상 커서 프레임이 사람 클릭을 막는다. 보기·끄기: Claude Code 의 /hooks, 빼기: zwprobe uninstall-hooks')
    const note = platformNote(process.platform)
    if (note !== undefined) console.log(`주의  ${note}`)
  } else {
    console.log(`훅  ${file} 에서 zw-probe 훅을 뺐다 (다른 설정은 그대로)`)
  }
  return 0
}
