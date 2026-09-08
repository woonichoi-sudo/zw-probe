// PreToolUse 훅 — zw-probe 세션이 Z-Weave 리포에 쓰는 것을 막는다.
//
// 목표: 읽기는 완전히 자유, 쓰기는 0. 판단이 안 서면 막는다(fail-closed).
// 막힌 지점에서 Claude가 멈추고 사용자에게 근거를 들고 오게 하는 것이 설계 의도다.
//
// stdin 으로 훅 JSON을 받고, 차단할 때만 JSON을 stdout 으로 낸다.
// 통과시킬 때는 아무것도 출력하지 않는다 — "allow"를 내면 다른 권한 검사를 건너뛰게 되므로
// 명시적 허용이 아니라 침묵으로 통과시킨다.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ZWEAVE_ROOT = 'd:/z-emotion/z-weave'

// 명령 문자열이 Z-Weave를 언급하는지. 절대경로(d:/z-emotion/Z-Weave)뿐 아니라
// 상대 탈출(../Z-Weave/...)도 잡아야 하므로 리포 이름만으로 판정한다.
// zwprobe·zwwin·zwagent 에는 "z-weave"가 없으므로 오탐이 자기 작업을 막지 않는다.
const MENTIONS_ZWEAVE = /z-?weave/i

// Z-Weave를 언급해도 통과시키는 읽기 전용 명령. 여기 없는 것은 전부 막힌다.
const READ_ONLY = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'nl',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'find', 'ls', 'dir', 'tree', 'stat', 'file', 'du', 'wc',
  'diff', 'cmp', 'comm',
  'cut', 'sort', 'uniq', 'tr', 'rev', 'fold', 'column',
  'basename', 'dirname', 'realpath', 'readlink', 'dirname',
  'echo', 'printf', 'true', 'false', 'test', 'pwd', 'which', 'type',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'sum',
  'strings', 'xxd', 'od', 'hexdump', 'nm', 'objdump', 'dumpbin',
  'jq', 'yq',
])

// git 은 읽기 서브명령만. (`git -C`·`--git-dir`·`--work-tree` 는 사용자 스코프에서
// 이미 deny 되어 있으므로 git 이 Z-Weave 리포에 도달할 현실적 경로는 없지만,
// 방어를 훅 안에서도 닫아둔다.)
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse',
  'cat-file', 'blame', 'describe', 'shortlog', 'count-objects', 'var', 'help',
])

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function inZWeave(p) {
  if (!p) return false
  const n = resolve(String(p)).replace(/\\/g, '/').toLowerCase()
  return n === ZWEAVE_ROOT || n.startsWith(ZWEAVE_ROOT + '/')
}

// 파이프·논리연산자·세미콜론·개행으로 서브명령을 쪼갠다.
function segments(cmd) {
  return cmd.split(/(?:\|\||&&|[;|\n])/).map((s) => s.trim()).filter(Boolean)
}

// 앞쪽 환경변수 대입(FOO=bar cmd)을 걷어내고 실행 파일 이름만 남긴다.
function commandName(segment) {
  const tokens = segment.split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  const raw = tokens[i] ?? ''
  const base = raw.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com)$/i, '')
  return base.toLowerCase()
}

function checkBash(cmd) {
  if (!MENTIONS_ZWEAVE.test(cmd)) return // Z-Weave 와 무관 — 훅이 관여하지 않는다

  // 명령 치환 안에 쓰기가 숨을 수 있다. 판단 불가이므로 막는다.
  if (/\$\(|`/.test(cmd)) {
    deny('Z-Weave 경로를 언급하면서 명령 치환($(...) 또는 백틱)을 쓰고 있어 내용을 판정할 수 없다. 치환 없이 다시 쓰거나, 정말 필요하면 사용자에게 근거를 제시하고 허용을 받아라.')
  }

  for (const seg of segments(cmd)) {
    // /dev/null 로 버리는 리다이렉션은 무해하므로 먼저 제거한 뒤 나머지 `>`를 본다.
    const stripped = seg.replace(/\d?>>?\s*\/dev\/null/g, '').replace(/\d?>&\d/g, '')
    if (/>/.test(stripped)) {
      deny(`Z-Weave 경로를 언급하는 명령에 출력 리다이렉션이 있다: ${seg}\n파일을 만들거나 덮어쓸 수 있어 막았다.`)
    }

    const name = commandName(seg)
    if (!name) continue

    if (name === 'git') {
      const sub = seg.split(/\s+/).filter((t) => !/^-/.test(t))[1]?.toLowerCase()
      if (!sub || !GIT_READ.has(sub)) {
        deny(`Z-Weave 경로를 언급하는 git 명령의 서브명령("${sub ?? '없음'}")이 읽기 전용 목록에 없다: ${seg}`)
      }
      continue
    }

    if (name === 'sed' && /(^|\s)(-i|--in-place)/.test(seg)) {
      deny(`sed 제자리 편집(-i)은 파일을 고친다: ${seg}`)
    }

    if (name === 'find' && /(^|\s)-(delete|exec|execdir|ok|fls|fprint|fprintf)(\s|$)/.test(seg)) {
      deny(`find 의 부작용 옵션(-delete/-exec 등)은 파일을 고칠 수 있다: ${seg}`)
    }

    if (!READ_ONLY.has(name)) {
      deny(`Z-Weave 경로를 언급하는 명령 "${name}" 이 읽기 전용 목록에 없다: ${seg}\n읽기라면 cat/head/grep/find/ls 같은 명령을 쓰고, 쓰기가 정말 필요하면 사용자에게 근거를 제시하고 허용을 받아라.`)
    }
  }
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}')
} catch {
  // 훅 입력을 못 읽으면 판단할 수 없다 — 통과시키지 않는다.
  deny('guard-zweave: 훅 입력을 파싱할 수 없어 판단을 보류하고 막았다.')
}

const tool = input.tool_name ?? ''
const args = input.tool_input ?? {}

if (tool === 'Bash') {
  checkBash(String(args.command ?? ''))
} else if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
  const target = args.file_path ?? args.notebook_path
  if (inZWeave(target)) {
    deny(`${tool} 대상이 Z-Weave 리포 안이다: ${target}\nCLAUDE.md 절대 규칙 1 — Z-Weave 소스는 0줄도 수정하지 않는다. 수정이 필요해 보이면 먼저 사용자에게 근거를 제시하고 승인을 받아라.`)
  }
}

// 여기까지 왔으면 관여하지 않는다.
