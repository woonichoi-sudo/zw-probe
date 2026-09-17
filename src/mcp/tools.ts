// MCP 로 내보내는 도구 목록과 인자 → CLI argv 변환.
//
// **여기는 판단하지 않는다.** 도구 하나가 CLI 동사 하나에 대응하고, 이 파일이 하는
// 일은 "인자를 argv 로 옮기는 것" 과 "옮길 수 없으면 거부하는 것" 뿐이다. 판정은
// 전부 CLI 안(zwprobe)에 있고 종료 코드로 나온다 — CLAUDE.md §절대규칙 5.
//
// 이 도구를 쓰는 쪽은 **다른 프로젝트의 세션**이라 CLAUDE.md 를 읽지 않았다.
// 그래서 설명에 함정을 같이 싣는다. 설명이 없으면 조용히 틀린다.

export type Param = {
  name: string
  type: 'string' | 'number' | 'boolean'
  desc: string
  required?: true
  /** 값을 고를 수 있으면 그 목록. 스키마에 enum 으로 실린다. */
  choices?: string[]
  /** CLI argv 로 옮기는 방법. */
  arg:
    | { kind: 'flag'; flag: string }
    | { kind: 'switch'; flag: string }
    | { kind: 'positional'; at: number }
}

export type Tool = {
  /** MCP 도구 이름. 다른 프로젝트의 도구들과 섞이므로 접두사를 붙인다. */
  name: string
  /** CLI 동사. */
  verb: string
  title: string
  desc: string
  /** 대상 앱을 바꾸는가. 관찰만 하면 false — MCP annotations 로 나간다. */
  mutates: boolean
  params: Param[]
  /** 다 주거나 하나도 안 주거나 해야 하는 인자 묶음. 반쪽은 다른 명령이 된다. */
  together?: string[][]
  /** 종료 코드의 뜻. 그대로 결과 끝에 실어서 숫자를 해석하지 않아도 되게 한다. */
  exits: Record<number, string>
}

/** 어느 명령에나 붙는 창 필터. 안 주면 CLI 가 대상 앱(z-weave)으로 좁힌다. */
const FILTERS: Param[] = [
  { name: 'process', type: 'string', desc: '프로세스 이름. 기본은 z-weave', arg: { kind: 'flag', flag: 'process' } },
  { name: 'pid', type: 'number', desc: '프로세스 id. 창이 여럿일 때 확실하다', arg: { kind: 'flag', flag: 'pid' } },
  { name: 'title', type: 'string', desc: '창 제목 조각', arg: { kind: 'flag', flag: 'title' } },
]

/** UIA 요소 질의. click 과 uia 가 같은 것을 쓴다. */
const QUERY: Param[] = [
  { name: 'name', type: 'string', desc: '요소 이름. 탭 라벨은 잘려서 보고되므로(ads::CElidingLabel) 앞부분만 줘도 된다', arg: { kind: 'flag', flag: 'name' } },
  { name: 'id', type: 'string', desc: 'AutomationId. 계층적이다 (예: ViewWidget.dock_manager)', arg: { kind: 'flag', flag: 'id' } },
  { name: 'class', type: 'string', desc: '클래스 이름', arg: { kind: 'flag', flag: 'class' } },
  { name: 'type', type: 'string', desc: '컨트롤 타입 (예: Button, ComboBox)', arg: { kind: 'flag', flag: 'type' } },
]

/**
 * `agent` 계열의 hello 경로 기본값.
 *
 * CLI 기본값은 `%TEMP%/zwagent-hello.json` 인데 **거기엔 픽스처가 남긴 낡은 파일이
 * 있다** — 2026-09-15 에 끝난 픽스처 pid 를 실앱인 줄 알고 보고했다. launch-zweave.sh
 * 가 쓰는 자리를 기본으로 둬서 그 함정을 피한다.
 */
export const DEFAULT_HELLO = 'runs/zwagent-hello.json'

export const TOOLS: Tool[] = [
  {
    name: 'zw_state',
    verb: 'state',
    title: '지금 조작할 수 있는가',
    desc:
      'Z-Weave 창 구조를 읽어 지금 입력을 보내도 되는지 판정한다. 다이얼로그는 자신을 띄운 창을 ' +
      '소유자로 갖고 메인 창은 갖지 않는다 — 그 소유 관계로 가른다. **조작 전에 먼저 이것을 본다.**',
    mutates: false,
    params: FILTERS,
    exits: { 0: 'idle — 지금 조작할 수 있다', 3: 'busy — 다이얼로그 등이 떠 있어 입력을 보내면 안 된다', 1: '보이는 창을 찾지 못했다 (앱이 안 떠 있다)' },
  },
  {
    name: 'zw_windows',
    verb: 'windows',
    title: '창 목록',
    desc: '창 목록과 소유자·크기·pid·클래스. 앱이 떠 있는지, 다이얼로그가 몇 개인지 볼 때 쓴다.',
    mutates: false,
    params: FILTERS,
    exits: { 0: '창을 찾았다', 1: '조건에 맞는 창이 없다' },
  },
  {
    name: 'zw_shot',
    verb: 'shot',
    title: '창 캡처',
    desc:
      '창을 PNG + 생 픽셀(.bgra) + 사이드카(.json)로 찍는다. 가려진 창도 잡힌다. 출력의 "저장" 줄에 ' +
      'PNG **절대경로**가 나오므로 Read 로 그 파일을 열어 보면 된다.\n' +
      '**좌표를 읽을 목적이면 mode=screen 으로 찍는다** — 기본 printwindow 는 최대화된 창에서 창 기준 ' +
      '좌표보다 +8,+8 밀려 있고(실측), 펼친 메뉴 같은 별도 팝업 창을 담지 못한다.',
    mutates: false,
    params: [
      { name: 'mode', type: 'string', choices: ['printwindow', 'screen'], desc: 'printwindow(기본, 가려져도 잡힘) 또는 screen(좌표가 정확하고 팝업도 담김)', arg: { kind: 'flag', flag: 'mode' } },
      { name: 'out', type: 'string', desc: '저장 경로(.png). 기본은 captures/shot-<시각>.png', arg: { kind: 'flag', flag: 'out' } },
      ...FILTERS,
    ],
    exits: { 0: '정상 — 쓸 수 있는 캡처다', 2: '쓸 수 없다 (검정 화면·최소화 등, 이유가 출력에 있다)', 1: '찍지 못했다' },
  },
  {
    name: 'zw_uia',
    verb: 'uia',
    title: 'UI 요소 트리',
    desc:
      'UIAutomation 트리를 덤프하거나 질의로 거른다. 좌표는 **창 기준**(wx,wy)으로 나오고 그것이 ' +
      'zw_click 이 받는 좌표계다. 질의 없이 부르면 트리 전체라 길다 — name·type 으로 좁히는 것이 낫다.\n' +
      '한계: 메뉴를 절반만 보여주고(File·Edit·Window·Help), **비활성 dock 은 아예 안 나온다** — ' +
      '그래서 남아 있는 dock 하나가 활성 탭이다. 펼친 콤보박스 목록은 별도 팝업이라 안 나온다.',
    mutates: false,
    params: [
      ...QUERY,
      { name: 'clickable', type: 'boolean', desc: '누를 수 있는 것만 (크기 0·화면 밖 제외)', arg: { kind: 'switch', flag: 'clickable' } },
      { name: 'depth', type: 'number', desc: '내려갈 깊이 상한', arg: { kind: 'flag', flag: 'depth' } },
      { name: 'max', type: 'number', desc: '노드 개수 상한', arg: { kind: 'flag', flag: 'max' } },
      ...FILTERS,
    ],
    exits: { 0: '트리를 읽었다', 1: '질의에 맞는 요소가 없다' },
  },
  {
    name: 'zw_doc',
    verb: 'doc',
    title: '열린 파일명과 저장 여부',
    desc:
      '열린 문서 이름과 dirty 플래그. **OS 창 제목에는 이 정보가 없다** — Windows 빌드는 커스텀 헤더 ' +
      '위젯에만 넣으므로 UIA 로만 읽힌다. 파일을 여는 조작의 완료 판정은 화면이 아니라 이것으로 한다.',
    mutates: false,
    params: FILTERS,
    exits: { 0: '읽었다 — 저장된 상태', 3: '읽었다 — 변경 있음(dirty). 문서를 바꾸는 조작은 저장 확인 모달에 막힌다', 1: '못 읽었다' },
  },
  {
    name: 'zw_log',
    verb: 'log',
    title: '앱 로그',
    desc:
      '실행 중인 앱 버전의 최신 로그를 tail 하고 severity 를 집계한다. **정상 동작 중에도 ERROR 가 ' +
      '나온다**(환경 매니저·깊이 버퍼 등) — "ERROR 가 있으면 실패" 라는 규칙은 아직 쓸 수 없다.',
    mutates: false,
    params: [
      { name: 'minSeverity', type: 'string', desc: '이 등급 이상만 (기본 WARNING)', arg: { kind: 'flag', flag: 'min-severity' } },
      { name: 'tail', type: 'number', desc: '마지막 N개 항목', arg: { kind: 'flag', flag: 'tail' } },
      { name: 'all', type: 'boolean', desc: '전부 보여준다', arg: { kind: 'switch', flag: 'all' } },
    ],
    exits: { 0: '읽었다', 1: '로그 파일을 찾지 못했다' },
  },
  {
    name: 'zw_shortcuts',
    verb: 'shortcuts',
    title: '단축키 목록',
    desc:
      'shortcut.ini 를 읽어 기능 이름 ↔ 키 매핑과 충돌을 보여준다. zw_key 에 넘길 **기능 이름**을 ' +
      '여기서 찾는다. 하드코딩된 목록이 아니라 파일이므로 사용자가 바꾼 것도 반영된다.',
    mutates: false,
    params: [{ name: 'filter', type: 'string', desc: '이름 조각으로 거른다', arg: { kind: 'flag', flag: 'filter' } }],
    exits: { 0: '읽었다' },
  },
  {
    name: 'zw_agent',
    verb: 'agent',
    title: '프로세스 안 위젯 트리 (읽기)',
    desc:
      '앱 프로세스 안의 zwagent.dll 을 통해 위젯 트리·라벨·명령 목록을 읽는다. UIA 로 안 보이는 것이 ' +
      '여기서 보인다 — 툴바 버튼(objectName 이 비어 있어 라벨로 찾는다), 비활성 패널 내용, 메뉴 전체.\n' +
      'find 로 찾으면 **누를 창 기준 좌표**까지 나오므로 zw_click 에 그대로 넘긴다. ' +
      'grab 은 위젯 하나만 찍는다 — 가려져 있어도, 스크롤 밖에 있어도 잡힌다.\n' +
      '앱을 `-style zwagent` 로 띄웠어야 한다.',
    mutates: false,
    params: [
      { name: 'live', type: 'boolean', desc: '파이프로 지금의 트리를 받는다. 안 주면 앱 시작 때의 스냅샷이라 낡는다', arg: { kind: 'switch', flag: 'live' } },
      { name: 'find', type: 'string', desc: '라벨로 위젯을 찾는다 (text·toolTip·accessibleName·QAction 텍스트를 다 본다)', arg: { kind: 'flag', flag: 'find' } },
      { name: 'actions', type: 'string', desc: '부를 수 있는 명령 목록. 조각을 주면 거른다 (빈 문자열이면 전체)', arg: { kind: 'flag', flag: 'actions' } },
      { name: 'grab', type: 'string', desc: '이 objectName 의 위젯 하나를 찍는다', arg: { kind: 'flag', flag: 'grab' } },
      { name: 'out', type: 'string', desc: 'grab 저장 경로(.png)', arg: { kind: 'flag', flag: 'out' } },
      { name: 'filter', type: 'string', desc: '기본 목록을 objectName 조각으로 거른다', arg: { kind: 'flag', flag: 'filter' } },
      { name: 'max', type: 'number', desc: '보여줄 개수 상한 (기본 60)', arg: { kind: 'flag', flag: 'max' } },
      { name: 'hello', type: 'string', desc: `hello 파일 경로. 기본 ${DEFAULT_HELLO}`, arg: { kind: 'flag', flag: 'hello' } },
    ],
    exits: { 0: '로드됐고 트리를 믿을 수 있다', 3: '로드됐지만 UI 가 아직 정착 전이다 — 트리를 믿지 않는다', 1: 'hello 를 못 읽었다 (플러그인 미로드)' },
  },

  // ─── 여기부터 대상 앱을 바꾼다 ───

  {
    name: 'zw_key',
    verb: 'key',
    title: '단축키 보내기',
    desc:
      'shortcut.ini 의 기능 이름으로 단축키를 보낸다. **창을 포그라운드로 올린다** — keybd_event 가 ' +
      '시스템 전역이라 그래야 한다. 이름은 zw_shortcuts 로 찾는다.\n' +
      '**단축키는 포커스가 있는 뷰로 간다** — 2D 를 누른 뒤 3D 단축키를 보내면 무시된다.',
    mutates: true,
    params: [
      { name: 'feature', type: 'string', required: true, desc: '기능 이름 (예: SimulationStart, MainUndo, CameraFit)', arg: { kind: 'positional', at: 0 } },
      ...FILTERS,
    ],
    exits: { 0: '보냈다', 2: '포그라운드를 확보하지 못했다 — 키가 다른 창으로 갔을 수 있다', 1: '기능 이름을 찾지 못했다' },
  },
  {
    name: 'zw_click',
    verb: 'click',
    title: '클릭',
    desc:
      '좌표나 UIA 요소 이름으로 클릭한다. **실제 커서를 옮겨서 누른다.** 좌표는 창 왼쪽 위 기준이고 ' +
      'zw_shot(mode=screen)의 PNG 좌표, zw_uia 의 wx·wy, zw_agent --find 의 "창 기준 한가운데" 와 같은 계다.\n' +
      '**임의 좌표 클릭은 되돌리기 어렵다** — CAD 캔버스 위 클릭은 형상을 만들 수 있다. 다이얼로그 버튼처럼 ' +
      '형상을 만들 수 없는 곳이 아니면 먼저 사람에게 확인받는다.\n' +
      '하위 메뉴를 열 때는 stay 로 커서를 두고 온다. 사람이 지켜보는 중이면 slow.',
    mutates: true,
    params: [
      { name: 'x', type: 'number', desc: '창 기준 x. name 과 함께 줄 수 없다', arg: { kind: 'positional', at: 0 } },
      { name: 'y', type: 'number', desc: '창 기준 y', arg: { kind: 'positional', at: 1 } },
      ...QUERY,
      { name: 'button', type: 'string', choices: ['left', 'right', 'middle'], desc: '기본 left', arg: { kind: 'flag', flag: 'button' } },
      { name: 'double', type: 'boolean', desc: '더블클릭', arg: { kind: 'switch', flag: 'double' } },
      { name: 'slow', type: 'boolean', desc: '사람이 보게 커서를 천천히 옮기고 전후로 멈춘다 (1.6초)', arg: { kind: 'switch', flag: 'slow' } },
      { name: 'stay', type: 'boolean', desc: '커서를 원래 자리로 돌리지 않는다. 하위 메뉴(›)를 열 때 필요하다', arg: { kind: 'switch', flag: 'stay' } },
      { name: 'hold', type: 'number', desc: '누르고 있을 시간(ms)', arg: { kind: 'flag', flag: 'hold' } },
      ...FILTERS,
    ],
    together: [['x', 'y']],
    exits: {
      0: '정상 — 누른 자리가 대상 창이다',
      2: '의심 — 누른 자리의 최상위 창이 대상과 다르다. **소유 다이얼로그나 콤보박스 팝업 안의 버튼은 실제로는 정확히 눌린 것이다**(알려진 한계)',
      1: '누르지 못했다',
    },
  },
  {
    name: 'zw_agent_trigger',
    verb: 'agent',
    title: '메뉴·명령 호출 (프로세스 안)',
    desc:
      'QAction::trigger() 를 프로세스 안에서 부른다. 마우스도 다이얼로그도 거치지 않는다 — ' +
      '`File > Recent files` 밑의 파일을 부르면 **파일 다이얼로그 없이 프로젝트가 열린다.**\n' +
      '**"불렀다" 가 아니라 "큐에 넣었다" 를 답한다** — 모달이 뜨면 이벤트 루프가 멈춰 응답이 못 나오기 ' +
      '때문이다. 무슨 일이 일어났는지는 zw_state·zw_shot·zw_doc 로 관찰해서 확인한다.\n' +
      '이름이 겹치면(Import 밑과 Export 밑의 OBJ 등) 부르지 않고 후보를 보여준다 — path 를 붙여 다시 부른다.\n' +
      '**토글 메뉴에 주의한다** — 이미 켜져 있는 것을 부르면 꺼진다. 상태를 맞추려는 목적이면 먼저 ' +
      'zw_agent(actions)로 켬/끔을 읽는다.',
    mutates: true,
    params: [
      { name: 'text', type: 'string', required: true, desc: '명령 이름 (zw_agent 의 actions 로 찾는다)', arg: { kind: 'flag', flag: 'trigger' } },
      { name: 'path', type: 'string', desc: '메뉴 경로 (예: "File > Recent files"). 이름이 겹칠 때 필요하다', arg: { kind: 'flag', flag: 'path' } },
      { name: 'hello', type: 'string', desc: `hello 파일 경로. 기본 ${DEFAULT_HELLO}`, arg: { kind: 'flag', flag: 'hello' } },
    ],
    exits: { 0: '큐에 넣었다 — 결과는 관찰해서 확인한다', 1: '부르지 못했다 (이름이 겹쳤거나 비활성이거나 파이프가 없다)' },
  },
  {
    name: 'zw_run',
    verb: 'run',
    title: '시나리오 실행',
    desc:
      '시나리오 파일(.ts)을 순차 실행한다. 실패하면 그 지점의 캡처와 UIA 트리를 같은 시각에 남긴다. ' +
      '**도는 동안 포그라운드를 점유한다** — 사람이 다른 창을 만지면 입력이 그쪽으로 간다.\n' +
      '시작 전에 파이프와 명령 이름을 검증하고, 문제가 있으면 **아무 단계도 실행하지 않고 거부한다.**\n' +
      '오래 걸릴 수 있다(앱 준비까지 포함하면 분 단위). 경로는 zw-probe 리포 기준 상대경로로 준다.',
    mutates: true,
    params: [
      { name: 'file', type: 'string', required: true, desc: '시나리오 파일 (예: scenarios/panel-toggle-auto.ts)', arg: { kind: 'positional', at: 0 } },
      { name: 'out', type: 'string', desc: '산출물 폴더', arg: { kind: 'flag', flag: 'out' } },
      { name: 'keepGoing', type: 'boolean', desc: '실패해도 계속한다', arg: { kind: 'switch', flag: 'keep-going' } },
      ...FILTERS,
    ],
    exits: { 0: '전부 통과', 2: '실패한 단계가 있다', 1: '시작하지 않았다 (시나리오를 못 읽거나 검증 거부 — 앱 상태는 그대로다)' },
  },
  {
    name: 'zw_baseline',
    verb: 'baseline',
    title: 'baseline 뜨기 / 목록',
    desc:
      '지금 화면을 "정답" 으로 저장한다. 이름을 안 주면 목록만 보여준다.\n' +
      '**레이아웃이 정착한 뒤에 뜬다** — 과도 상태를 담으면 그 뒤 모든 비교가 그것을 정답으로 삼는다. ' +
      '뜨기 전에 PNG 를 직접 보고 정말 정상인지 판단한다. 덮어쓰기는 force 가 필요하다 — ' +
      '무심코 덮으면 회귀가 정상으로 굳는다.',
    mutates: false,
    params: [
      { name: 'name', type: 'string', desc: 'baseline 이름. 없으면 목록', arg: { kind: 'positional', at: 0 } },
      { name: 'force', type: 'boolean', desc: '기존 baseline 을 덮어쓴다', arg: { kind: 'switch', flag: 'force' } },
      { name: 'dir', type: 'string', desc: 'baseline 폴더', arg: { kind: 'flag', flag: 'dir' } },
      ...FILTERS,
    ],
    exits: { 0: '떴다 / 목록을 보여줬다', 1: '이미 있거나 이름이 잘못됐다' },
  },
  {
    name: 'zw_diff',
    verb: 'diff',
    title: '두 캡처 비교',
    desc:
      '두 캡처의 픽셀을 비교한다. 이름은 **확장자 없이** 준다 (.png/.bgra/.json 셋이 함께 다닌다). ' +
      '예: a="baselines/빈씬", b="captures/shot-20260917-101500".',
    mutates: false,
    params: [
      { name: 'a', type: 'string', required: true, desc: '왼쪽 캡처 (확장자 없이)', arg: { kind: 'positional', at: 0 } },
      { name: 'b', type: 'string', required: true, desc: '오른쪽 캡처 (확장자 없이)', arg: { kind: 'positional', at: 1 } },
      { name: 'tolerance', type: 'number', desc: '채널당 허용 차이', arg: { kind: 'flag', flag: 'tolerance' } },
      { name: 'maxChanged', type: 'number', desc: '허용할 변한 픽셀 비율 (예: 0.01)', arg: { kind: 'flag', flag: 'max-changed' } },
    ],
    exits: { 0: '같다', 2: '다르다', 1: '비교할 수 없다 (크기가 다르거나 파일을 못 읽었다)' },
  },
]

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name)
}

/** MCP 가 요구하는 JSON Schema. 파라미터 정의에서 기계적으로 만든다. */
export function inputSchema(tool: Tool): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const p of tool.params) {
    properties[p.name] = {
      type: p.type,
      description: p.desc,
      ...(p.choices ? { enum: p.choices } : {}),
    }
  }
  const required = tool.params.filter((p) => p.required).map((p) => p.name)
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

export type BuildResult = { ok: true; argv: string[] } | { ok: false; reason: string }

/**
 * 도구 인자를 CLI argv 로 옮긴다.
 *
 * **모르는 것은 조용히 버리지 않고 거부한다.** 오타 난 인자를 무시하면 사용자가 의도한
 * 것과 다른 명령이 나가고, 그건 이 프로젝트에서 가장 나쁜 실패다(조용히 틀리는 종류).
 */
export function buildArgv(tool: Tool, args: Record<string, unknown>): BuildResult {
  const known = new Set(tool.params.map((p) => p.name))
  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      return { ok: false, reason: `모르는 인자 "${key}". 쓸 수 있는 것: ${[...known].join(', ')}` }
    }
  }

  const given = (name: string) => args[name] !== undefined && args[name] !== null

  for (const p of tool.params) {
    if (p.required && !given(p.name)) {
      return { ok: false, reason: `"${p.name}" 이 필요하다 — ${p.desc}` }
    }
  }

  for (const group of tool.together ?? []) {
    const have = group.filter(given)
    if (have.length !== 0 && have.length !== group.length) {
      const missing = group.filter((n) => !given(n))
      return { ok: false, reason: `${group.join('·')} 는 함께 줘야 한다. 빠진 것: ${missing.join(', ')}` }
    }
  }

  const positionals: { at: number; value: string }[] = []
  const flags: string[] = []

  for (const p of tool.params) {
    const raw = args[p.name]
    if (raw === undefined || raw === null) continue

    if (p.type === 'boolean') {
      if (typeof raw !== 'boolean') return { ok: false, reason: `"${p.name}" 은 true/false 여야 한다: ${JSON.stringify(raw)}` }
      if (raw && p.arg.kind === 'switch') flags.push(`--${p.arg.flag}`)
      continue
    }

    if (p.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, reason: `"${p.name}" 은 숫자여야 한다: ${JSON.stringify(raw)}` }
      }
    } else if (typeof raw !== 'string') {
      return { ok: false, reason: `"${p.name}" 은 문자열이어야 한다: ${JSON.stringify(raw)}` }
    }

    const value = String(raw)
    if (p.choices && !p.choices.includes(value)) {
      return { ok: false, reason: `"${p.name}" 은 ${p.choices.join(', ')} 중 하나여야 한다: ${value}` }
    }
    // CLI 파서는 `--` 로 시작하는 값을 플래그로 읽는다. 그대로 넘기면 **다른 명령이
    // 조립된다** — 값으로는 받지 않는다.
    if (value.startsWith('--')) {
      return { ok: false, reason: `"${p.name}" 의 값이 "--" 로 시작하면 CLI 가 플래그로 읽는다: ${value}` }
    }

    if (p.arg.kind === 'positional') positionals.push({ at: p.arg.at, value })
    else if (p.arg.kind === 'flag') flags.push(`--${p.arg.flag}`, value)
  }

  // 위치 인자는 **비어 있으면 안 된다.** 0번 없이 1번만 주면 CLI 가 1번을 0번으로 읽는다.
  positionals.sort((a, b) => a.at - b.at)
  for (let i = 0; i < positionals.length; i++) {
    if (positionals[i]!.at !== i) {
      const missing = tool.params.find((p) => p.arg.kind === 'positional' && p.arg.at === i)
      return { ok: false, reason: `"${missing?.name ?? `위치 ${i}`}" 없이 뒤의 인자만 줄 수 없다` }
    }
  }

  const argv = [tool.verb, ...positionals.map((p) => p.value), ...flags]

  // agent 계열은 hello 기본값을 %TEMP% 가 아니라 이 리포의 것으로 둔다 (위 DEFAULT_HELLO).
  if (tool.verb === 'agent' && args.hello === undefined) argv.push('--hello', DEFAULT_HELLO)

  return { ok: true, argv }
}
