import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findConflicts, findShortcut, parseShortcut, parseShortcutIni } from './shortcut.ts'

test('parseShortcut — 글자와 숫자는 ASCII 대문자·숫자가 가상키코드다', () => {
  assert.deepEqual(parseShortcut('P'), { vk: 0x50, ctrl: false, alt: false, shift: false })
  assert.deepEqual(parseShortcut('Z'), { vk: 0x5a, ctrl: false, alt: false, shift: false })
  assert.deepEqual(parseShortcut('2'), { vk: 0x32, ctrl: false, alt: false, shift: false })
  // 소문자로 와도 같아야 한다
  assert.equal(parseShortcut('p').vk, 0x50)
})

test('parseShortcut — 수식키 조합', () => {
  assert.deepEqual(parseShortcut('Ctrl+Z'), { vk: 0x5a, ctrl: true, alt: false, shift: false })
  assert.deepEqual(parseShortcut('Shift+P'), { vk: 0x50, ctrl: false, alt: false, shift: true })
  assert.deepEqual(parseShortcut('Ctrl+Shift+R'), { vk: 0x52, ctrl: true, alt: false, shift: true })
  assert.deepEqual(parseShortcut('Alt+F4'), { vk: 0x73, ctrl: false, alt: true, shift: false })
})

test('parseShortcut — 이름 있는 키', () => {
  assert.equal(parseShortcut('SPACE').vk, 0x20)
  assert.equal(parseShortcut('ESC').vk, 0x1b)
  assert.equal(parseShortcut('DEL').vk, 0x2e)
  assert.equal(parseShortcut('BACKSPACE').vk, 0x08)
  assert.equal(parseShortcut('LEFT').vk, 0x25)
  assert.equal(parseShortcut('DOWN').vk, 0x28)
  assert.equal(parseShortcut('F1').vk, 0x70)
  assert.equal(parseShortcut('F12').vk, 0x7b)
})

test('parseShortcut — shortcut.ini 에 실제로 있는 기호 키', () => {
  assert.equal(parseShortcut('PLUS').vk, 0xbb)
  assert.equal(parseShortcut('-').vk, 0xbd)
  assert.deepEqual(parseShortcut('Ctrl+SPACE'), { vk: 0x20, ctrl: true, alt: false, shift: false })
})

test('parseShortcut — `-` 가 키인 조합도 쪼개지지 않는다', () => {
  assert.deepEqual(parseShortcut('Shift+-'), { vk: 0xbd, ctrl: false, alt: false, shift: true })
})

// 이 프로젝트에서 가장 중요한 테스트다. 틀린 키는 아무 일도 안 일어나는 게 아니라
// **다른 명령을 실행한다** (2026-09-09 실측: Shift 빠진 P 가 핀 도구를 켰다).
test('parseShortcut — 모르는 토큰은 추측하지 않고 던진다', () => {
  assert.throws(() => parseShortcut('SUPER+K'), /바꿀 수 없다/)
  assert.throws(() => parseShortcut('F13'), /바꿀 수 없다/)
  assert.throws(() => parseShortcut('MouseWheel'), /바꿀 수 없다/)
})

test('parseShortcut — 수식키만 있으면 던진다', () => {
  assert.throws(() => parseShortcut('Ctrl'), /키가 없다/)
  assert.throws(() => parseShortcut('Ctrl+Shift'), /키가 없다/)
  assert.throws(() => parseShortcut(''), /빈 단축키/)
  assert.throws(() => parseShortcut('   '), /빈 단축키/)
})

test('parseShortcut — 키가 둘이면 던진다', () => {
  assert.throws(() => parseShortcut('A+B'), /키가 둘 이상/)
})

// 실제 shortcut.ini 에서 그대로 가져온 조각
const SAMPLE = `Version=1.6

[Main menu]
MainUndo=Ctrl+Z
MainRedo=Ctrl+Y
MainTack=T
SimulationStart=SPACE
SimulationStep=Ctrl+SPACE
SimulationReset=Shift+SPACE
CameraFit=Shift+F

[2d shortcuts]
Divide Curve=I
SurfaceEnlarge=PLUS
SurfaceShrink=-
ActivateSelected=Shift+D
DeactivateSelected=Shift+D

[3d shortcuts]
ResetSculpt=Ctrl+Shift+R
`

test('parseShortcutIni — 버전과 섹션을 읽는다', () => {
  const f = parseShortcutIni(SAMPLE)
  assert.equal(f.version, '1.6')
  assert.equal(f.unparsed.length, 0)

  const sections = [...new Set(f.entries.map((e) => e.section))]
  assert.deepEqual(sections, ['Main menu', '2d shortcuts', '3d shortcuts'])
})

test('parseShortcutIni — 기능 이름에 공백이 있어도 읽는다', () => {
  const f = parseShortcutIni(SAMPLE)
  const e = findShortcut(f, 'Divide Curve')
  assert.ok(e, '"Divide Curve" 를 찾아야 한다')
  assert.equal(e.stroke.vk, 0x49) // I
  assert.equal(e.section, '2d shortcuts')
})

test('parseShortcutIni — 실제 항목이 올바른 키로 해석된다', () => {
  const f = parseShortcutIni(SAMPLE)
  assert.deepEqual(findShortcut(f, 'SimulationStart')!.stroke, {
    vk: 0x20,
    ctrl: false,
    alt: false,
    shift: false,
  })
  assert.deepEqual(findShortcut(f, 'SimulationStep')!.stroke, {
    vk: 0x20,
    ctrl: true,
    alt: false,
    shift: false,
  })
  assert.deepEqual(findShortcut(f, 'ResetSculpt')!.stroke, {
    vk: 0x52,
    ctrl: true,
    alt: false,
    shift: true,
  })
})

test('parseShortcutIni — 못 읽은 줄은 던지지 않고 모아 보고한다', () => {
  const f = parseShortcutIni('[X]\nGood=A\nBad=SUPER+K\nNoEquals\n')
  assert.equal(f.entries.length, 1)
  assert.equal(f.entries[0]!.name, 'Good')
  assert.equal(f.unparsed.length, 2)
  assert.equal(f.unparsed[0]!.line, 3)
  assert.match(f.unparsed[1]!.reason, /= 가 없다/)
})

// 실측으로 발견한 것. 같은 섹션에서 Shift+D 가 두 기능에 묶여 있다.
test('findConflicts — 같은 키에 묶인 기능을 찾아낸다', () => {
  const f = parseShortcutIni(SAMPLE)
  const conflicts = findConflicts(f)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0]!.spec, 'Shift+D')
  assert.deepEqual(conflicts[0]!.names.sort(), ['ActivateSelected', 'DeactivateSelected'])
})

test('findConflicts — 섹션이 다르면 충돌로 보지 않는다', () => {
  // CameraBack=2 (Main menu) 와 RenderBack=2 (3d) 는 대상이 달라 공존한다
  const f = parseShortcutIni('[Main menu]\nCameraBack=2\n\n[3d shortcuts]\nRenderBack=2\n')
  assert.equal(findConflicts(f).length, 0)
})
