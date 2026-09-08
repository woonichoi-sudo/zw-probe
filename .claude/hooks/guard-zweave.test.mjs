// guard-zweave.mjs 의 판정 테스트.
//   node --test .claude/hooks/guard-zweave.test.mjs
//
// 훅은 차단할 때만 stdout 에 JSON을 낸다. 통과는 빈 출력이다.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('./guard-zweave.mjs', import.meta.url))

function run(payload) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `훅이 비정상 종료했다: ${r.stderr}`)
  if (!r.stdout.trim()) return null
  return JSON.parse(r.stdout).hookSpecificOutput
}

const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } })
const write = (file_path) => run({ tool_name: 'Write', tool_input: { file_path } })
const edit = (file_path) => run({ tool_name: 'Edit', tool_input: { file_path } })

function assertDenied(out, label) {
  assert.ok(out, `${label}: 차단돼야 하는데 통과했다`)
  assert.equal(out.permissionDecision, 'deny', label)
}

function assertPassed(out, label) {
  assert.equal(out, null, `${label}: 통과돼야 하는데 차단됐다 — ${out?.permissionDecisionReason}`)
}

test('Write/Edit — Z-Weave 안이면 막고, zw-probe 안이면 통과', () => {
  assertDenied(write('D:/z-emotion/Z-Weave/CMakeLists.txt'), '절대경로 Write')
  assertDenied(write('d:\\z-emotion\\Z-Weave\\Zest\\.clang-format'), '역슬래시 소문자 드라이브 Write')
  assertDenied(edit('D:/z-emotion/Z-Weave/cmake/setupConfigs.cmake'), 'Edit')
  assertDenied(write('D:/z-emotion/Z-Weave'), '리포 루트 자체')

  assertPassed(write('D:/z-emotion/zw-probe/src/shot.ts'), '자기 프로젝트 Write')
  assertPassed(write('D:/z-emotion/zw-probe/CLAUDE.md'), '자기 프로젝트 문서')
})

test('Write — 이름이 비슷한 형제 경로는 막지 않는다', () => {
  assertPassed(write('D:/z-emotion/Z-Weave-notes/memo.md'), 'Z-Weave 접두사만 같은 별개 폴더')
})

test('Bash — Z-Weave 를 언급하지 않으면 관여하지 않는다', () => {
  assertPassed(bash('ls -la D:/z-emotion/zw-probe'), '무관한 ls')
  assertPassed(bash('node --test src/shot.test.ts'), '자기 테스트 실행')
  assertPassed(bash('git commit -m "[M1] 창 캡처"'), '커밋')
})

test('Bash — Z-Weave 읽기는 통과한다', () => {
  assertPassed(bash('cat D:/z-emotion/Z-Weave/CMakeLists.txt'), 'cat')
  assertPassed(bash('grep -rn "setObjectName" D:/z-emotion/Z-Weave/Z-Weave'), 'grep')
  assertPassed(bash('find D:/z-emotion/Z-Weave/doc -maxdepth 2 -type f'), 'find')
  assertPassed(bash('ls "D:/z-emotion/Z-Weave/cmake_build/bin/Debug" 2>/dev/null'), '/dev/null 리다이렉션')
  assertPassed(bash('head -50 D:/z-emotion/Z-Weave/CMakeLists.txt | grep project'), '파이프로 읽기 연결')
  assertPassed(bash('grep -c "Z-Weave" CLAUDE.md'), '자기 문서에서 Z-Weave 문자열 검색')
})

test('Bash — Z-Weave 쓰기는 막는다', () => {
  assertDenied(bash('sed -i "s/a/b/" D:/z-emotion/Z-Weave/CMakeLists.txt'), 'sed -i')
  assertDenied(bash('echo hi > D:/z-emotion/Z-Weave/probe.txt'), '리다이렉션')
  assertDenied(bash('cat > "D:/z-emotion/Z-Weave/x.txt" <<EOF\nhi\nEOF'), 'heredoc')
  assertDenied(bash('cp a.txt D:/z-emotion/Z-Weave/a.txt'), 'cp')
  assertDenied(bash('mv a.txt D:/z-emotion/Z-Weave/a.txt'), 'mv')
  assertDenied(bash('rm -rf D:/z-emotion/Z-Weave/build'), 'rm')
  assertDenied(bash('mkdir D:/z-emotion/Z-Weave/newdir'), 'mkdir')
  assertDenied(bash('touch D:/z-emotion/Z-Weave/newfile'), 'touch')
  assertDenied(bash('tee D:/z-emotion/Z-Weave/x.txt'), 'tee')
  assertDenied(bash('powershell -c "Set-Content D:/z-emotion/Z-Weave/x.txt hi"'), 'powershell')
  assertDenied(bash('node write-something.mjs D:/z-emotion/Z-Weave/x.txt'), 'node 스크립트')
})

test('Bash — 상대경로 탈출도 막는다', () => {
  assertDenied(bash('sed -i "s/a/b/" ../Z-Weave/CMakeLists.txt'), '../Z-Weave')
  assertDenied(bash('cp x.txt ../Z-Weave/x.txt'), '../Z-Weave cp')
})

test('Bash — 파이프 뒷단에 숨은 쓰기도 막는다', () => {
  assertDenied(bash('cat D:/z-emotion/Z-Weave/CMakeLists.txt | tee /tmp/x'), '읽기 뒤 tee')
  assertDenied(bash('ls D:/z-emotion/Z-Weave && rm -rf D:/z-emotion/Z-Weave/x'), '&& 뒤 rm')
  assertDenied(bash('cat CLAUDE.md; sed -i s/a/b/ D:/z-emotion/Z-Weave/x'), '; 뒤 sed -i')
})

test('Bash — 명령 치환은 판정 불가이므로 막는다', () => {
  assertDenied(bash('cat $(ls D:/z-emotion/Z-Weave/*.txt)'), '$() 치환')
  assertDenied(bash('cat `ls D:/z-emotion/Z-Weave`'), '백틱 치환')
})

test('Bash — git 은 허용 목록의 서브명령만 통과한다', () => {
  assertPassed(bash('git log --oneline -- D:/z-emotion/Z-Weave/CMakeLists.txt'), 'git log')
  assertDenied(bash('git init D:/z-emotion/Z-Weave/probe'), 'git init')
  assertDenied(bash('git add D:/z-emotion/Z-Weave/x'), 'git add')
})

// 커밋 메시지에 대상 앱 이름이 들어가는 것은 정상 작업이다. 이게 막히면
// `[M1] Z-Weave 창 캡처` 같은 커밋을 못 하게 되므로 commit 은 허용 목록에 둔다.
// 리포를 갈아끼우는 플래그가 없는 git 은 항상 현재 리포에서만 동작하므로 안전하다.
test('Bash — 커밋 메시지의 Z-Weave 언급은 막지 않는다', () => {
  assertPassed(bash('git commit -m "[M1] Z-Weave 창 캡처 구현"'), 'git commit -m')
})

// 2026-09-08 실측으로 찾은 구멍. 사용자 스코프의 `Bash(git --git-dir:*)` 는
// 등호 형태를 잡지 못하고(`--git-dir="..."` 이 한 토큰), 훅도 서브명령이 status 라서
// 읽기로 통과시켰다. 그 결과 대상 앱 리포의 git 상태가 실제로 읽혔다.
test('Bash — git 을 다른 리포로 갈아끼우는 플래그를 막는다', () => {
  assertDenied(
    bash('git --git-dir="D:/z-emotion/Z-Weave/.git" --work-tree="D:/z-emotion/Z-Weave" status --short'),
    '등호 형태 --git-dir + --work-tree (실측된 구멍)',
  )
  assertDenied(bash('git --git-dir=D:/z-emotion/Z-Weave/.git status'), '따옴표 없는 등호 형태')
  assertDenied(bash('git --git-dir "D:/z-emotion/Z-Weave/.git" log'), '공백 형태')
  assertDenied(bash('git --work-tree="D:/z-emotion/Z-Weave" status'), '--work-tree 단독')
  assertDenied(bash('git -C "D:/z-emotion/Z-Weave" status'), '-C')
  assertDenied(bash('git --exec-path="D:/z-emotion/Z-Weave" status'), '--exec-path')
})

// 목적지 경로를 인자로 받는 서브명령들. deny 목록에는 없어서 훅이 유일한 방어선이다.
// (2026-09-08 실측: git init·git worktree add 는 권한을 통과해 git 본체까지 도달했다)
test('Bash — 목적지 경로로 Z-Weave 에 쓰는 git 서브명령을 막는다', () => {
  assertDenied(bash('git init "D:/z-emotion/Z-Weave/__probe__"'), 'git init')
  assertDenied(bash('git worktree add "D:/z-emotion/Z-Weave/__probe__"'), 'git worktree add')
  assertDenied(bash('git clone https://example.com/x.git D:/z-emotion/Z-Weave/x'), 'git clone')
  assertDenied(bash('git submodule update --init D:/z-emotion/Z-Weave'), 'git submodule')
})

test('Bash — gh 로 Z-Weave 에 쓰는 것을 막는다', () => {
  assertDenied(bash('gh repo clone z-emotion/other D:/z-emotion/Z-Weave/x'), 'gh repo clone')
  assertDenied(bash('gh release download -D D:/z-emotion/Z-Weave/dl'), 'gh release download -D')
  // gh 는 읽기 계열도 막힌다(과차단). 필요하면 근거를 들고 사용자에게 허용을 받는다.
  assertDenied(bash('gh pr list -R z-emotion/Z-Weave'), 'gh pr list — 과차단이지만 닫히는 방향')
  assertPassed(bash('gh pr list -R z-emotion/zw-probe'), 'Z-Weave 무관한 gh 는 관여 안 함')
})

// 자기 프로젝트 파일을 다루는 것은 이름·내용에 Z-Weave 가 들어가도 막지 않는다.
// (훅이 자기 테스트 실행을 막는 것을 실제로 확인한 뒤 추가했다)
test('Bash — 자기 프로젝트 작업은 이름에 zweave 가 있어도 통과한다', () => {
  assertPassed(bash('node --test "d:/z-emotion/zw-probe/.claude/hooks/guard-zweave.test.mjs"'), '절대경로로 자기 테스트 실행')
  assertPassed(bash('node --test .claude/hooks/guard-zweave.test.mjs'), '상대경로로 자기 테스트 실행')
  assertPassed(bash('cat .claude/hooks/guard-zweave.mjs'), '자기 훅 읽기')
  assertPassed(bash('sed -i "s/Z-Weave/대상 앱/" docs/WORKLOG.md'), '자기 문서 제자리 편집')
  assertPassed(bash('echo "Z-Weave 조사" >> docs/WORKLOG.md'), '자기 문서에 리다이렉션')
})

test('Bash — 자기 경로와 Z-Weave 경로가 섞이면 막는다', () => {
  assertDenied(bash('cp "d:/z-emotion/zw-probe/x.txt" "D:/z-emotion/Z-Weave/y.txt"'), '자기 것 → Z-Weave 복사')
  assertDenied(bash('node "d:/z-emotion/zw-probe/write.mjs" "D:/z-emotion/Z-Weave/y"'), '자기 스크립트로 Z-Weave 쓰기')
})

test('훅 입력이 깨지면 막는다', () => {
  const r = spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny')
})
