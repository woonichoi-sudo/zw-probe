// 2단 픽스처 통합 테스트 — Z-Weave 없이 돈다.
//
// WinForms 픽스처 창을 녹화한다. zwwin.exe record 를 백그라운드로 띄우고, 정지 파일로 멈추고,
// 결과 JSON 과 **파일에 실제로 들어간 것**(moov·샘플 수·길이)을 맞춰 본다.
// 디코딩은 하지 않으므로 상하 반전·색은 여기서 못 본다 — 2026-09-30 에 브라우저로 재생해 확인했다.
//
//   node --test src/record/record.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listWindows, startRecord, ZWWIN_EXE } from '../win/zwwin.ts'
import { judgeRecording, parseRecordResult, readMp4Summary } from './record.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_EXE = resolve(HERE, '../../bin/zwfixture.exe')
// 다른 테스트가 찾는 제목 조각("zwprobe-fixture")을 **포함하지 않는** 제목, 그리고 그들이 누르는 (80,80) 과
// 겹치지 않는 위치. 병렬로 도는 zwwin 테스트가 이 창을 자기 것으로 집으면 안 된다.
const FIXTURE_TITLE = 'zwprobe-rec-target'
const FIXTURE_AT = '700,80'

const built = existsSync(ZWWIN_EXE) && existsSync(FIXTURE_EXE)
const skip = process.platform === 'darwin'
  ? 'Windows 전용 — WinForms 픽스처와 zwwin.exe 를 시험한다 (macOS 는 src/mac/zwmac.integration.test.ts)'
  : built
  ? false
  : 'bin/ 이 비어 있다. bash tools/zwwin/build.sh && bash fixtures/winapp/build.sh 를 먼저 실행한다.'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await sleep(100)
  }
  throw new Error(`${what} — ${timeoutMs}ms 안에 오지 않았다`)
}

test('픽스처 창을 녹화하고 정지 파일로 멈춘다 — 파일의 샘플 수가 보고와 같다', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-rec-'))
  const out = join(dir, 'fixture.mp4')
  const result = join(dir, 'fixture.result.json')
  const stop = join(dir, 'fixture.stop')
  const child = spawn(FIXTURE_EXE, ['--title', FIXTURE_TITLE, '--at', FIXTURE_AT], { detached: false, stdio: 'ignore' })

  try {
    // **pid 로 좁힌다.** node --test 가 파일을 병렬로 돌려서 다른 파일이 띄운 같은 제목의 픽스처가
    // 동시에 떠 있다 — 제목으로 찾으면 서로의 창을 집는다 (2026-09-30 실제로 zwwin 테스트 셋이 깨졌다).
    const fixturePid = child.pid!
    await waitFor(() => listWindows({ pid: fixturePid }).some((w) => w.width > 0), 8000, '픽스처 창')

    // printwindow — 테스트 창이 다른 창에 가려져 있어도 찍혀야 한다
    const pid = startRecord({ pid: fixturePid, out, result, stop, fps: 10, maxSeconds: 30, mode: 'printwindow', cursor: true })
    assert.ok(pid > 0)

    await sleep(2000)
    assert.equal(existsSync(result), false, '멈추라고 하기 전에 끝났다: ' + (existsSync(result) ? readFileSync(result, 'utf8') : ''))
    writeFileSync(stop, '')
    await waitFor(() => existsSync(result), 20000, '결과 파일')

    const r = parseRecordResult(readFileSync(result, 'utf8'))
    assert.ok(r.ok, r.ok ? '' : r.error)
    assert.equal(r.stopReason, 'stop')
    assert.equal(r.window.title, FIXTURE_TITLE)
    assert.equal(r.window.pid, fixturePid)
    assert.ok(r.frames >= 15, `2초에 10 fps 인데 ${r.frames} 프레임이다`)
    assert.equal(r.width % 2, 0, 'H.264 는 짝수 크기여야 한다')
    assert.equal(r.height % 2, 0)

    const file = readMp4Summary(readFileSync(out))
    assert.equal(file.hasMoov, true, 'moov 가 없다 — 마무리되지 않았다')
    assert.equal(file.samples, r.frames, '인코더가 프레임을 버렸다')
    assert.ok(Math.abs(file.seconds - r.frames / r.fps) < 0.15, `길이 ${file.seconds}초 ≠ ${r.frames}/${r.fps}`)
    assert.equal(judgeRecording(r, file).usable, true)
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('창이 없으면 바로 실패를 결과 파일에 쓴다', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-rec-'))
  const result = join(dir, 'none.result.json')
  try {
    startRecord({
      title: 'zwprobe-no-such-window-7f3a', out: join(dir, 'none.mp4'), result, stop: join(dir, 'none.stop'),
      fps: 10, maxSeconds: 5, mode: 'screen', cursor: true,
    })
    await waitFor(() => existsSync(result), 8000, '결과 파일')
    const r = parseRecordResult(readFileSync(result, 'utf8'))
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.error.includes('찾지 못했다'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
