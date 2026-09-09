// 단축키 문자열 → 가상키코드. 순수 함수, 의존성 0.
//
// zwwin.exe 는 이미 해석된 vk 와 수식키 플래그만 받는다 — 문자열 해석은 판단이므로
// 여기 있다(CLAUDE.md 절대 규칙 5).
//
// **모르는 토큰은 던진다.** 조용히 넘기거나 추측하면 안 된다. 2026-09-09 실측에서
// 수식키가 빠진 `Shift+P` 가 평범한 `P` 로 전달됐고, `P` 는 실제로 존재하는 다른
// 명령(MainPin)이라 핀 도구가 켜지고 패널 탭까지 바뀌었다. 틀린 키는 "아무 일도
// 안 일어남" 이 아니라 "다른 명령 실행" 이다.

export type KeyStroke = {
  /** Windows 가상키코드 */
  vk: number
  ctrl: boolean
  alt: boolean
  shift: boolean
}

/** shortcut.ini 가 쓰는 이름 → 가상키코드 */
const NAMED_KEYS = new Map<string, number>([
  ['ESC', 0x1b],
  ['ESCAPE', 0x1b],
  ['SPACE', 0x20],
  ['DEL', 0x2e],
  ['DELETE', 0x2e],
  ['BACKSPACE', 0x08],
  ['ENTER', 0x0d],
  ['RETURN', 0x0d],
  ['TAB', 0x09],
  ['LEFT', 0x25],
  ['UP', 0x26],
  ['RIGHT', 0x27],
  ['DOWN', 0x28],
  ['PLUS', 0xbb], // VK_OEM_PLUS
  ['COMMA', 0xbc], // VK_OEM_COMMA
  ['-', 0xbd], // VK_OEM_MINUS
  ['MINUS', 0xbd],
])

for (let i = 1; i <= 12; i++) NAMED_KEYS.set(`F${i}`, 0x6f + i) // F1=0x70

const MODIFIERS = new Map<string, 'ctrl' | 'alt' | 'shift'>([
  ['CTRL', 'ctrl'],
  ['CONTROL', 'ctrl'],
  ['ALT', 'alt'],
  ['SHIFT', 'shift'],
])

/**
 * `"Ctrl+Shift+R"`, `"SPACE"`, `"P"`, `"2"`, `"-"` 같은 문자열을 해석한다.
 * 모르는 토큰이나 키가 없는 조합은 던진다.
 */
export function parseShortcut(spec: string): KeyStroke {
  const raw = spec.trim()
  if (raw === '') throw new Error('빈 단축키 문자열이다')

  // `-` 자체가 키다. `+` 로 쪼개기 전에 처리해야 `Shift+-` 도 살아난다.
  const parts = splitSpec(raw)

  let ctrl = false
  let alt = false
  let shift = false
  let vk: number | null = null

  for (const part of parts) {
    const token = part.trim()
    if (token === '') continue

    const upper = token.toUpperCase()
    const mod = MODIFIERS.get(upper)
    if (mod !== undefined) {
      if (mod === 'ctrl') ctrl = true
      else if (mod === 'alt') alt = true
      else shift = true
      continue
    }

    if (vk !== null) {
      throw new Error(`"${spec}" 에 키가 둘 이상 있다 ("${token}")`)
    }
    vk = toVirtualKey(upper, spec)
  }

  if (vk === null) throw new Error(`"${spec}" 에 수식키만 있고 키가 없다`)
  return { vk, ctrl, alt, shift }
}

/** `+` 로 쪼개되, 키 자체가 `+` 나 `-` 인 경우를 깨뜨리지 않는다. */
function splitSpec(raw: string): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    // 마지막 문자인 `+` 는 구분자가 아니라 키다 (`Shift++`)
    if (c === '+' && buf !== '' && i !== raw.length - 1) {
      out.push(buf)
      buf = ''
      continue
    }
    buf += c
  }
  if (buf !== '') out.push(buf)
  return out
}

function toVirtualKey(upper: string, spec: string): number {
  const named = NAMED_KEYS.get(upper)
  if (named !== undefined) return named

  if (upper.length === 1) {
    const c = upper.charCodeAt(0)
    // A-Z 와 0-9 는 가상키코드가 ASCII 대문자·숫자와 같다
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39)) return c
    if (upper === '+') return 0xbb
    if (upper === ',') return 0xbc
  }

  throw new Error(
    `"${spec}" 의 "${upper}" 를 가상키코드로 바꿀 수 없다. ` +
      '추측하지 않고 실패한다 — 틀린 키는 다른 명령을 실행한다.',
  )
}

export type ShortcutEntry = {
  /** shortcut.ini 의 기능 이름 (`SimulationStart`, `Divide Curve` 등) */
  name: string
  /** 원본 문자열 (`Ctrl+SPACE`) */
  spec: string
  section: string
  stroke: KeyStroke
}

export type ShortcutFile = {
  version: string
  entries: ShortcutEntry[]
  /** 해석에 실패한 줄. 파일 전체를 못 쓰게 만들지 않고 사실로 보고한다 */
  unparsed: Array<{ line: number; text: string; reason: string }>
}

/**
 * `shortcut.ini` 를 해석한다.
 *
 * 파일 하나가 못 읽히는 항목 때문에 전부 못 쓰게 되면 안 되므로, 실패한 줄은
 * 던지지 않고 `unparsed` 에 모은다. 반면 개별 단축키를 실제로 **쓸 때**는
 * parseShortcut 이 던진다 — 읽기는 관대하게, 실행은 엄격하게.
 */
export function parseShortcutIni(text: string): ShortcutFile {
  const entries: ShortcutEntry[] = []
  const unparsed: ShortcutFile['unparsed'] = []
  let version = ''
  let section = ''

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim()
      continue
    }

    const eq = line.indexOf('=')
    if (eq < 0) {
      unparsed.push({ line: i + 1, text: line, reason: '= 가 없다' })
      continue
    }

    const name = line.slice(0, eq).trim()
    const spec = line.slice(eq + 1).trim()

    if (name.toLowerCase() === 'version' && section === '') {
      version = spec
      continue
    }

    try {
      entries.push({ name, spec, section, stroke: parseShortcut(spec) })
    } catch (err) {
      unparsed.push({
        line: i + 1,
        text: line,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { version, entries, unparsed }
}

/** 기능 이름으로 찾는다. 같은 이름이 여러 섹션에 있으면 먼저 나온 것을 준다. */
export function findShortcut(file: ShortcutFile, name: string): ShortcutEntry | undefined {
  return file.entries.find((e) => e.name === name)
}

/** 같은 키 조합에 묶인 기능들. `ActivateSelected`/`DeactivateSelected` 처럼 겹치는 것이 실제로 있다. */
export function findConflicts(file: ShortcutFile): Array<{ spec: string; names: string[] }> {
  const bySpec = new Map<string, string[]>()
  for (const e of file.entries) {
    const key = `${e.section}|${strokeKey(e.stroke)}`
    const list = bySpec.get(key)
    if (list === undefined) bySpec.set(key, [e.name])
    else list.push(e.name)
  }

  const out: Array<{ spec: string; names: string[] }> = []
  for (const [key, names] of bySpec) {
    if (names.length > 1) {
      const entry = file.entries.find((e) => `${e.section}|${strokeKey(e.stroke)}` === key)!
      out.push({ spec: entry.spec, names })
    }
  }
  return out
}

function strokeKey(s: KeyStroke): string {
  return `${s.vk}:${s.ctrl ? 1 : 0}${s.alt ? 1 : 0}${s.shift ? 1 : 0}`
}
