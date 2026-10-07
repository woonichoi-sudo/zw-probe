/**
 * 열린 팝업 메뉴(문맥 메뉴) — 플러그인 `popup` 응답을 읽고, 고를 항목의 경로를 정한다.
 *
 * 2D 뷰 우클릭 메뉴는 부모 없는 QMenu 를 `popup()` 으로 띄운다. `actions`/`trigger` 는 모든
 * 액션을 이름으로 찾아 같은 이름(Delete 등)이 여럿이면 못 고른다 — 여기는 **지금 열린 그 메뉴**만 본다.
 * 글자는 Qt 원문 그대로(`&&`·`&` 단축 표시 포함) — 판정은 여기서, 플러그인은 받은 대로(절대 규칙 5).
 */
export type PopupItem = {
  text: string
  enabled: boolean
  checkable: boolean
  checked?: boolean
  separator: boolean
  /** 하위 메뉴를 여는 항목이면 그 항목들 */
  items?: PopupItem[]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseItem(raw: unknown): PopupItem | null {
  if (raw === null || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const out: PopupItem = {
    text: str(a.text),
    enabled: a.enabled === true,
    checkable: a.checkable === true,
    separator: a.separator === true,
  }
  if (a.checkable === true && typeof a.checked === 'boolean') out.checked = a.checked
  if (Array.isArray(a.items)) out.items = a.items.map(parseItem).filter((x): x is PopupItem => x !== null)
  return out
}

export function parsePopup(body: Record<string, unknown>): { open: boolean; items: PopupItem[] } {
  if (body.open !== true || !Array.isArray(body.items)) return { open: false, items: [] }
  return { open: true, items: body.items.map(parseItem).filter((x): x is PopupItem => x !== null) }
}

/** `"Flip > Flip horizontal"` → 각 단계의 글자. 부를 수 있는 항목(켜짐·명령)이어야 한다 */
export function findPopupItem(
  items: readonly PopupItem[],
  path: string,
): { ok: true; path: string[] } | { ok: false; error: string } {
  const parts = path.split(' > ')
  let level: readonly PopupItem[] = items
  for (let i = 0; i < parts.length; i++) {
    const hits = level.filter((x) => !x.separator && x.text === parts[i])
    if (parts[i] === '' || hits.length === 0) {
      return { ok: false, error: `"${parts.slice(0, i + 1).join(' > ')}" 항목이 없다 — 있는 것: ${level.filter((x) => !x.separator).map((x) => x.text).join(', ')}` }
    }
    if (hits.length > 1) return { ok: false, error: `"${parts.slice(0, i + 1).join(' > ')}" 이 ${hits.length}개다` }
    const it = hits[0]!
    if (!it.enabled) return { ok: false, error: `"${parts.slice(0, i + 1).join(' > ')}" 은 꺼져 있다` }
    if (i === parts.length - 1) {
      if (it.items !== undefined) return { ok: false, error: `"${path}" 는 하위 메뉴다 — 그 안의 항목을 고른다` }
      return { ok: true, path: parts }
    }
    if (it.items === undefined) return { ok: false, error: `"${parts.slice(0, i + 2).join(' > ')}" 항목이 없다 — "${parts[i]}" 는 하위 메뉴가 아니다` }
    level = it.items
  }
  return { ok: false, error: `"${path}" 항목이 없다` }
}

/** 사람이 읽는 줄 — 하위 메뉴는 두 칸 들여쓰기 */
export function popupLines(items: readonly PopupItem[], indent = ''): string[] {
  return items.flatMap((x) => {
    if (x.separator) return [`${indent}─`]
    const mark = `${x.items !== undefined ? ' ▸' : ''}${x.enabled ? '' : ' [꺼짐]'}${x.checkable ? (x.checked ? ' [✓]' : ' [ ]') : ''}`
    return [`${indent}${x.text}${mark}`, ...(x.items ? popupLines(x.items, indent + '  ') : [])]
  })
}
