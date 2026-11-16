// 프레임 알약 문구 — 어떤 AI 가 작업 중인가 (2026-11-17 사용자와 정함). 순수 함수.
//
// --label 이 이기고, 없으면 MCP 클라이언트 이름(initialize 의 clientInfo.name, MCP 서버가 ZWPROBE_AGENT 로 넘긴다),
// 그것도 없으면 DEFAULT_FRAME_LABEL. "작업 중" 은 Claude in Chrome 의 "Claude is working here" 를 따랐다.
// 알 수 있는 것은 클라이언트 프로그램 이름까지다 — 그 안의 모델(Opus/Sonnet 등)은 MCP 인사에 없다.

export const DEFAULT_FRAME_LABEL = 'AI Agent 작업 중'

/** 클라이언트 이름 조각 → 보기 좋은 이름. 위에서부터 처음 맞는 것 */
const KNOWN: Array<[RegExp, string]> = [
  [/claude-code/i, 'Claude Code'],
  [/claude/i, 'Claude'],
  [/codex/i, 'Codex'],
  [/gemini/i, 'Gemini'],
  [/cursor/i, 'Cursor'],
]

const clean = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max)

export function frameLabel(clientName?: string, override?: string): string {
  const o = clean(override ?? '', 40)
  if (o !== '') return o
  const n = clean(clientName ?? '', 30)
  if (n === '') return DEFAULT_FRAME_LABEL
  for (const [re, pretty] of KNOWN) if (re.test(n)) return `${pretty} 작업 중`
  return `${n} 작업 중`
}
