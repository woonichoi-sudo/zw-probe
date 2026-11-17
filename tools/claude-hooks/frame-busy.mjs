// Claude Code 훅 — 가상 커서 프레임에 "Claude Code 가 지금 일하는 중" 을 알린다 (2026-11-17).
//
//   node tools/claude-hooks/frame-busy.mjs busy   ← UserPromptSubmit (요청을 보냈다)
//   node tools/claude-hooks/frame-busy.mjs idle   ← Stop · SessionEnd (답을 마쳤다·세션이 끝났다)
//
// busy 는 <busy 폴더>/<session_id> 에 시작 시각(unix ms)을 쓰고, idle 은 그 파일을 지운다. 세션마다 따로 두므로
// 한 세션이 끝나도 다른 세션의 표시는 남는다. 프레임(zwwin.exe frame --busy-dir)은 0.5초마다 이 폴더를 보고,
// 작업 표시가 있고 그 작업이 시작된 뒤 대상 창에 가상 입력이 있었으면 사람 클릭을 막는다.
// busy 폴더: ZWPROBE_BUSY_DIR, 없으면 이 리포의 runs/frames/busy.
//
// **훅은 Claude Code 를 절대 막지 않는다** — 무슨 일이 있어도 종료 코드 0, 아무것도 찍지 않는다
// (UserPromptSubmit 훅의 stdout 은 대화에 붙는다).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = process.env.ZWPROBE_BUSY_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../runs/frames/busy')
const action = process.argv[2]

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  try {
    const id = String(JSON.parse(input).session_id ?? '')
    // 파일 이름으로 쓸 수 있는 것만 — 폴더 밖으로 나가지 못하게
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return
    const file = join(DIR, id)
    if (action === 'busy') {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(file, String(Date.now()))
    } else if (action === 'idle') {
      rmSync(file, { force: true })
    }
  } catch {
    // 조용히 넘어간다
  }
})
