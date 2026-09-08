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
const PROBE_ROOT = 'd:/z-emotion/zw-probe'

// 명령 문자열이 Z-Weave를 언급하는지. 절대경로(d:/z-emotion/Z-Weave)뿐 아니라
// 상대 탈출(../Z-Weave/...)도 잡아야 하므로 리포 이름만으로 판정한다.
const MENTIONS_ZWEAVE = /z-?weave/i

// 발동 판정은 "문자열에 z-weave 가 있나" 가 아니라
// **"토큰 중 Z-Weave 안으로 해석되는 경로가 있나"** 로 한다.
//
// 문자열 판정은 양쪽으로 틀렸다. 이름에 zweave 가 든 자기 파일(guard-zweave.mjs)이나
// "Z-Weave" 를 언급하는 자기 문서를 다루는 것만으로 발동해 정상 작업을 막았고,
// 반대로 그것을 문자열에서 걷어내려 하니 `--git-dir=<경로>` 와 gh 리포 지정자가 빠져나갔다.
// 경로로 해석하면 둘 다 정확히 갈린다.
//
// 상대경로는 cwd(=zw-probe)를 기준으로 해석한다. `../Z-Weave/x` 가 이걸로 잡힌다.
function tokenPaths(token) {
  const bare = token.replace(/^["'`]+|["'`]+$/g, '')
  if (!bare) return []
  const out = [bare]
  const eq = bare.indexOf('=') // --git-dir=<경로>, VAR=<경로>
  if (eq > 0) {
    const v = bare.slice(eq + 1).replace(/^["'`]+|["'`]+$/g, '')
    if (v) out.push(v)
  }
  return out
}

function underZWeave(p) {
  let abs
  try { abs = resolve(PROBE_ROOT, p) } catch { return false }
  const n = abs.replace(/\\/g, '/').toLowerCase()
  return n === ZWEAVE_ROOT || n.startsWith(ZWEAVE_ROOT + '/')
}

function touchesZWeave(cmd) {
  for (const token of cmd.split(/\s+/)) {
    for (const p of tokenPaths(token)) if (underZWeave(p)) return true
  }
  return false
}

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

// git 이 다른 리포를 겨냥하게 만드는 플래그. 이게 붙으면 서브명령이 무엇이든 막는다.
//
// 사용자 스코프에 `Bash(git --git-dir:*)` 가 있지만 **등호 형태를 잡지 못한다** —
// 패턴은 `--git-dir` 을 별개 토큰으로 기대하는데 `--git-dir="..."` 은 한 토큰이다.
// 2026-09-08 실측: `git --git-dir="D:/.../Z-Weave/.git" status` 가 그대로 실행돼
// 대상 앱 리포의 git 상태를 읽어냈다. 공백 형태와 등호 형태를 모두 잡는다.
const GIT_REPO_REDIRECT = /(?:^|\s)(?:-C(?:\s|$)|--(?:git-dir|work-tree|exec-path)(?:[=\s]|$))/

// 리포를 갈아끼우지 않는 한 git 은 항상 현재 리포(zw-probe)에서만 동작한다.
// 그래서 `commit` 이 여기 있다 — 커밋 메시지에 "Z-Weave" 가 들어가는 정상 작업을
// 막지 않기 위해서다. 목적지 경로를 인자로 받는 서브명령(init·clone·worktree·
// submodule·archive·bundle·config --file …)은 이 목록에 없으므로 전부 막힌다.
const GIT_ALLOWED = new Set([
  'commit',
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
  // gh 는 로컬 경로가 아니라 리포 지정자(`-R z-emotion/Z-Weave`)로 대상 앱에 닿는다.
  // 경로 판정으로는 잡히지 않으므로 gh 만 문자열 언급으로도 발동시킨다(의도된 과차단).
  const isGh = segments(cmd).some((s) => commandName(s) === 'gh')
  if (!touchesZWeave(cmd) && !(isGh && MENTIONS_ZWEAVE.test(cmd))) return

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
      if (GIT_REPO_REDIRECT.test(seg)) {
        deny(`git 을 다른 리포로 갈아끼우는 플래그(-C / --git-dir / --work-tree / --exec-path)를 쓰고 있다: ${seg}\nCLAUDE.md 절대 규칙 3 — 대상 앱 리포에는 어떤 git 명령도 실행하지 않는다.`)
      }
      const sub = seg.split(/\s+/).filter((t) => !/^-/.test(t))[1]?.toLowerCase()
      if (!sub || !GIT_ALLOWED.has(sub)) {
        deny(`Z-Weave 를 언급하는 git 명령의 서브명령("${sub ?? '없음'}")이 허용 목록에 없다: ${seg}`)
      }
      continue
    }

    if (name === 'gh') {
      deny(`Z-Weave 를 언급하는 gh 명령은 읽기까지 전부 막는다(의도된 과차단): ${seg}\n로컬 파일 읽기는 cat/grep/find 를 쓴다. GitHub 조회가 정말 필요하면 사용자에게 근거를 제시하고 허용을 받아라.`)
    }

    if ((name === 'sed' || name === 'yq') && /(^|\s)(-i|--in-place)/.test(seg)) {
      deny(`${name} 제자리 편집(-i)은 파일을 고친다: ${seg}`)
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
