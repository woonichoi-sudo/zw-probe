// 2단 픽스처 통합 테스트 — Z-Weave 없이 돈다.
//
// WinForms 픽스처 창을 띄우고, 찾고, 캡처하고, 4분면 색을 확인한다.
// 색이 다 다르므로 이 한 번으로 세 가지가 동시에 검증된다:
//   ① 캡처가 실제로 창 내용을 담았는가
//   ② 상하가 뒤집히지 않았는가 (좌상단이 빨강)
//   ③ 채널 순서가 BGRA 인가 (빨강이 초록·파랑으로 읽히지 않는가)
//
//   node --test src/win/zwwin.integration.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { listWindows, shot, ZWWIN_EXE } from './zwwin.ts'
import { analyze, judgeBlank, pixelAt } from '../image/stats.ts'
import type { Bgra, Rgb } from '../image/stats.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_EXE = resolve(HERE, '../../bin/zwfixture.exe')
const FIXTURE_TITLE = 'zwprobe-fixture'

const built = existsSync(ZWWIN_EXE) && existsSync(FIXTURE_EXE)
const skip = built
  ? false
  : 'bin/ 이 비어 있다. bash tools/zwwin/build.sh && bash fixtures/winapp/build.sh 를 먼저 실행한다.'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 픽스처 창이 뜰 때까지 기다린다. 못 찾으면 던진다. */
async function waitForFixture(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = listWindows({ title: FIXTURE_TITLE })
    if (found.length > 0 && found[0]!.width > 0) return found[0]!
    await sleep(100)
  }
  throw new Error(`픽스처 창을 ${timeoutMs}ms 안에 찾지 못했다`)
}

/** 두 색이 눈으로 같은 색인가. 캡처 경로에서 1~2 정도는 흔들릴 수 있다. */
function near(actual: Rgb, r: number, g: number, b: number, tol = 8): boolean {
  return (
    Math.abs(actual.r - r) <= tol && Math.abs(actual.g - g) <= tol && Math.abs(actual.b - b) <= tol
  )
}

function show(c: Rgb): string {
  return `rgb(${c.r},${c.g},${c.b})`
}

test('픽스처 창을 찾아 캡처하고 4분면 색을 확인한다', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zwprobe-'))
  const png = join(dir, 'fixture.png')
  const raw = join(dir, 'fixture.bgra')
  const child = spawn(FIXTURE_EXE, [], { detached: false, stdio: 'ignore' })

  try {
    await waitForFixture()
    await sleep(200) // 첫 페인트가 끝나도록 잠깐 둔다

    const info = shot({ title: FIXTURE_TITLE, png, raw })
    const w = info.window

    assert.equal(info.format, 'bgra8')
    assert.equal(info.mode, 'printwindow')
    assert.ok(w.width > 0 && w.height > 0, `창 크기가 이상하다: ${w.width}x${w.height}`)
    assert.equal(w.title, FIXTURE_TITLE)

    const img: Bgra = {
      width: w.width,
      height: w.height,
      data: new Uint8Array(readFileSync(raw)),
    }

    // 버퍼 길이가 창 크기와 정확히 맞아야 한다 — stride 처리가 틀리면 여기서 걸린다
    assert.equal(img.data.length, w.width * w.height * 4)

    const stats = analyze(img)
    assert.equal(judgeBlank(stats).blank, false, '캡처가 비어 있다')

    // 각 사분면의 한가운데를 찍는다. 창 크기를 실측값에서 끌어오므로
    // DPI 배율이 걸려 있어도 무너지지 않는다.
    const qx = Math.floor(w.width / 4)
    const qy = Math.floor(w.height / 4)
    const topLeft = pixelAt(img, qx, qy)
    const topRight = pixelAt(img, w.width - qx, qy)
    const bottomLeft = pixelAt(img, qx, w.height - qy)
    const bottomRight = pixelAt(img, w.width - qx, w.height - qy)

    assert.ok(near(topLeft, 255, 0, 0), `좌상단이 빨강이어야 한다 — 실제 ${show(topLeft)}`)
    assert.ok(near(topRight, 0, 255, 0), `우상단이 초록이어야 한다 — 실제 ${show(topRight)}`)
    assert.ok(near(bottomLeft, 0, 0, 255), `좌하단이 파랑이어야 한다 — 실제 ${show(bottomLeft)}`)
    assert.ok(
      near(bottomRight, 255, 255, 255),
      `우하단이 흰색이어야 한다 — 실제 ${show(bottomRight)}`,
    )
  } finally {
    child.kill()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('없는 창을 요청하면 예외로 알려준다', { skip }, () => {
  assert.throws(
    () => shot({ title: '존재하지-않는-창-zzz', png: join(tmpdir(), 'never.png') }),
    /찾지 못했다/,
  )
})
