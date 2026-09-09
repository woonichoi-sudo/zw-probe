// 대상 앱 로그의 순수 파싱과 판정. 의존성 0, I/O 0.
//
// 줄 형식 (`zwLogFile.cpp` 의 이미터와 정확히 대응):
//   <asctime> [<SEVERITY>] <classContext>: <detailedContext>: <message>
//   Wed Sep  9 14:54:50 2026 [ERROR] zsRenderTarget: WidgetsFBO: clearDepth=true, ...
//
// **한 항목이 여러 줄일 수 있다.** 메시지 자체가 줄바꿈을 품는 경우가 있다
// (OpenGL 디버그 출력). 실측: 302줄 파일의 항목은 268개였다. 그래서 타임스탬프로
// 앵커를 걸고 앵커 없는 줄은 앞 항목의 연속으로 붙인다.
//
// severity 를 세려면 반드시 앵커를 써야 한다. 메시지 안에도 `[ERROR]` 같은
// 문자열이 들어 있어서(OpenGL 이 `[API]` 를 쓴다) 앵커 없이 세면 과다 계상된다 —
// 실측: `[ERROR]` 309건 중 실제 severity 는 300건이었다.

export type Severity = 'FATAL' | 'ASSERT' | 'ERROR' | 'WARNING' | 'INFO' | 'SPAM' | 'UNKNOWN'

/** 심각한 것이 큰 수. 임계값 비교에 쓴다. */
const RANK: Record<Severity, number> = {
  FATAL: 5,
  ASSERT: 4,
  ERROR: 3,
  WARNING: 2,
  INFO: 1,
  SPAM: 0,
  UNKNOWN: 1,
}

export function severityRank(s: Severity): number {
  return RANK[s]
}

export function atLeast(s: Severity, min: Severity): boolean {
  return severityRank(s) >= severityRank(min)
}

export function toSeverity(text: string): Severity {
  switch (text.toUpperCase()) {
    case 'FATAL':
      return 'FATAL'
    case 'ASSERT':
      return 'ASSERT'
    case 'ERROR':
      return 'ERROR'
    case 'WARNING':
      return 'WARNING'
    case 'INFO':
      return 'INFO'
    case 'SPAM':
      return 'SPAM'
    default:
      return 'UNKNOWN'
  }
}

export type LogEntry = {
  /** 항목 전체 원문 (여러 줄이면 줄바꿈 포함) */
  raw: string
  /** 로컬 시각. asctime 에는 표준시 정보가 없어 로컬로 해석한다. 못 읽으면 null */
  time: Date | null
  severity: Severity
  classContext: string
  detailedContext: string
  message: string
  /** 항목이 시작된 물리적 줄 번호 (1부터) */
  line: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// `Wed Sep  9 14:32:35 2026 [INFO] ` — 날짜가 한 자리면 공백이 둘이다
const HEAD =
  /^[A-Za-z]{3} ([A-Za-z]{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) \[([A-Za-z]+)\] ?/

export function parseTime(month: string, day: number, h: number, m: number, s: number, year: number): Date | null {
  const mi = MONTHS.indexOf(month)
  if (mi < 0) return null
  const d = new Date(year, mi, day, h, m, s)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 로그 본문을 항목 배열로. 앵커가 없는 선행 줄은 버리지 않고 첫 항목의 연속으로도
 * 붙일 수 없으므로(앞 항목이 없다) 무시한다 — 파일이 잘려 시작하는 경우다.
 */
export function parseLogEntries(text: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const head = HEAD.exec(line)

    if (head === null) {
      // 앵커 없는 줄 = 앞 항목의 연속
      const prev = entries[entries.length - 1]
      if (prev !== undefined) {
        prev.raw += '\n' + line
        prev.message += '\n' + line
      }
      continue
    }

    const rest = line.slice(head[0].length)
    const { classContext, detailedContext, message } = splitContext(rest)

    entries.push({
      raw: line,
      time: parseTime(
        head[1]!,
        Number(head[2]),
        Number(head[3]),
        Number(head[4]),
        Number(head[5]),
        Number(head[6]),
      ),
      severity: toSeverity(head[7]!),
      classContext,
      detailedContext,
      message,
      line: i + 1,
    })
  }

  // 연속 줄을 붙이며 생긴 뒤쪽 빈 줄을 정리한다. `std::endl` 과 메시지 자신의
  // 줄바꿈이 겹쳐 빈 줄이 남는다.
  for (const e of entries) {
    e.raw = e.raw.replace(/\n+$/, '')
    e.message = e.message.replace(/\n+$/, '')
  }

  return entries
}

/**
 * 이미터는 class 와 detail 사이, detail 과 message 사이에 `": "` 를 각각 하나씩 넣는다.
 * 그래서 앞의 두 조각만 떼고 나머지는 전부 메시지다 — 메시지에 `": "` 가 들어 있어도
 * 안전하다. 다만 detailedContext 자체가 `": "` 를 품고 있으면 구분할 방법이 없다
 * (`zwAppZWeave::LoadFonts: 478: ...` 에서 `478` 이 detail 인지 message 인지).
 * 실사용에서는 severity 필터와 메시지 검색만 쓰므로 문제되지 않는다.
 */
function splitContext(rest: string): {
  classContext: string
  detailedContext: string
  message: string
} {
  const first = rest.indexOf(': ')
  if (first < 0) return { classContext: rest, detailedContext: '', message: '' }

  const classContext = rest.slice(0, first)
  const afterFirst = rest.slice(first + 2)

  const second = afterFirst.indexOf(': ')
  if (second < 0) return { classContext, detailedContext: afterFirst, message: '' }

  return {
    classContext,
    detailedContext: afterFirst.slice(0, second),
    message: afterFirst.slice(second + 2),
  }
}

export type LogSummary = {
  total: number
  counts: Record<Severity, number>
  /** 가장 심각한 severity. 항목이 없으면 null */
  worst: Severity | null
  /** WARNING 이상 항목 */
  problems: LogEntry[]
}

export function summarize(entries: readonly LogEntry[], min: Severity = 'WARNING'): LogSummary {
  const counts: Record<Severity, number> = {
    FATAL: 0,
    ASSERT: 0,
    ERROR: 0,
    WARNING: 0,
    INFO: 0,
    SPAM: 0,
    UNKNOWN: 0,
  }

  let worst: Severity | null = null
  const problems: LogEntry[] = []

  for (const e of entries) {
    counts[e.severity]++
    if (worst === null || severityRank(e.severity) > severityRank(worst)) worst = e.severity
    if (atLeast(e.severity, min)) problems.push(e)
  }

  return { total: entries.length, counts, worst, problems }
}

/** 로그 파일 이름을 뜯는다. `z-weave_5.0.34_2026.09.09_05.32.35.934.log` */
export type LogFileName = {
  app: string
  appVersion: string
  /** 파일명에 박힌 시각. **UTC 다** — 줄 안의 시각은 로컬이므로 섞으면 안 된다 */
  startedUtc: Date
}

export function parseLogFileName(name: string): LogFileName | null {
  const m =
    /^(.+)_([0-9][0-9.]*)_(\d{4})\.(\d{2})\.(\d{2})_(\d{2})\.(\d{2})\.(\d{2})\.(\d{3})\.log$/.exec(
      name,
    )
  if (m === null) return null

  const startedUtc = new Date(
    Date.UTC(
      Number(m[3]),
      Number(m[4]) - 1,
      Number(m[5]),
      Number(m[6]),
      Number(m[7]),
      Number(m[8]),
      Number(m[9]),
    ),
  )
  if (Number.isNaN(startedUtc.getTime())) return null

  return { app: m[1]!, appVersion: m[2]!, startedUtc }
}
