// 1단 순수 단위 — 프레임 알약 문구를 정하는 규칙 (2026-11-17 사용자와 정함).
//
// 정답은 사용자와 정한 규칙이다: --label 이 이기고, 없으면 MCP 클라이언트 이름(clientInfo.name)으로,
// 그것도 없으면 "AI Agent 작업 중". Claude in Chrome 이 "working" 이라 "작업 중" 을 쓴다.
//
//   node --test src/input/frameLabel.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_FRAME_LABEL, frameLabel } from './frameLabel.ts'

test('frameLabel — 아무것도 없으면 AI Agent 작업 중', () => {
  assert.equal(DEFAULT_FRAME_LABEL, 'AI Agent 작업 중')
  assert.equal(frameLabel(undefined, undefined), 'AI Agent 작업 중')
  assert.equal(frameLabel('', ''), 'AI Agent 작업 중')
  assert.equal(frameLabel('   ', '  '), 'AI Agent 작업 중')
})

test('frameLabel — 알려진 클라이언트 이름은 보기 좋은 이름으로', () => {
  assert.equal(frameLabel('claude-code'), 'Claude Code 작업 중')
  assert.equal(frameLabel('Claude-Code'), 'Claude Code 작업 중')
  assert.equal(frameLabel('claude-ai'), 'Claude 작업 중')
  assert.equal(frameLabel('codex-mcp-client'), 'Codex 작업 중')
  assert.equal(frameLabel('gemini-cli-mcp-client'), 'Gemini 작업 중')
  assert.equal(frameLabel('cursor-vscode'), 'Cursor 작업 중')
})

test('frameLabel — 처음 보는 이름은 그대로 붙인다 (다듬어서)', () => {
  assert.equal(frameLabel('my-agent'), 'my-agent 작업 중')
  assert.equal(frameLabel('  my-agent \n'), 'my-agent 작업 중')
  // 제어 문자는 빼고, 너무 길면 30자로 자른다
  assert.equal(frameLabel('a\u0000b\u0007c'), 'abc 작업 중')
  assert.equal(frameLabel('x'.repeat(50)), `${'x'.repeat(30)} 작업 중`)
})

test('frameLabel — --label 이 이긴다, 그대로 쓰고 40자로 자른다', () => {
  assert.equal(frameLabel('claude-code', 'Codex 리뷰 중'), 'Codex 리뷰 중')
  assert.equal(frameLabel(undefined, '  수동 지정  '), '수동 지정')
  assert.equal(frameLabel(undefined, 'y'.repeat(60)), 'y'.repeat(40))
})
