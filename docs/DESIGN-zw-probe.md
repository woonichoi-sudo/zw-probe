# zw-probe 설계문서

작성: 2026-09-08 · 대상 앱: Z-Weave (`d:/z-emotion/Z-Weave`, C++/Qt5 데스크톱 의상 CAD)

---

## 1. 문제

Z-Weave를 Claude Code로 작업할 때 web 프로젝트 대비 UI 관련 작업이 현저히 불편하다.

web 프로젝트에서는 Claude in Chrome으로 브라우저를 제어해 UI 테스트를 하고, UI에서 버그를 재현해 바로 원인을 찾아 고칠 수 있다. Z-Weave는 브라우저에서 동작하지 않으므로:

- 화면을 사람이 캡처해 수동으로 업로드해야 한다
- Claude가 앱을 조작할 수 없어 재현을 사람이 대신 해야 한다
- 수정 후 확인도 사람이 다시 해야 한다

**근본 원인:** Chrome은 원격 제어 프로토콜(CDP)이 앱에 내장되어 있다. Z-Weave에는 그에 상응하는 채널이 없다. 따라서 CDP에 해당하는 것을 외부에서 만들어야 한다.

## 2. 목표와 비목표

**목표**

- Claude가 사람 개입 없이 Z-Weave 화면을 보고, 조작하고, 결과를 판정한다
- 재현 절차를 스크립트로 재사용한다
- 수정 후 회귀를 자동 확인한다

**비목표**

- web 수준의 반복 속도. 핫 리로드가 없으므로 달성 불가 (§8)
- Z-Weave 소스 코드 수정. **0줄을 끝까지 유지한다**
- 렌더링의 미묘한 정확성(색·음영·재질감) 판정
- 체감 프레임률·성능 회귀 측정

## 3. 조사 결과 — 검증된 사실

2026-09-08 Z-Weave 리포를 직접 조사해 확인한 사실이다. 설계는 전부 이 위에 서 있다.

### 3.1 앱 구조

| 사실 | 근거 |
|---|---|
| Qt 5.15.6 msvc2019_64 (`external/Qt-5.15.6-lts-lgpl-msvc2019_64`) | `build/common/run_cmake.bat` |
| 제너레이터는 Visual Studio 17 2022 (msbuild) | `cmake_build/CMakeCache.txt` |
| `ninja`, `ccache`, `sccache` **미설치** → 증분 빌드가 느림 | 환경 확인 |
| 디버그 빌드 산출물 존재 (`cmake_build/bin/Debug/z-weave.exe`, 2026-08-25) | 파일 확인 |
| UI가 상태 머신·커맨드로 수렴 | `Z-Weave/state/zwStateMachine.h`, `zwContextCommandFactory.h`, `zwShortcutManager.h` |
| undo/redo 히스토리 관리자 존재 | `Z-Weave/state/zwHistoryManager.h` |

### 3.2 외부에서 읽을 수 있는 신호 (앱 수정 없이)

| 신호 | 근거 | 용도 |
|---|---|---|
| **창 제목에 파일명 + dirty 플래그** | `Z-Weave/zwQtMainWindow.cpp:2005` — `setWindowTitle(mFileNameSave, isDirty)` | 어떤 파일이 열렸나, 미저장 변경이 있나 |
| **진행 다이얼로그 존재** | `Z-Weave/zwQtMainWindow.cpp:2109` — `mProgressDialog->setWindowTitle(...)` | "작업 중" 판정. sleep 추측 대체 |
| **로그 파일** | `Z-Weave/zwAppZWeave.cpp` — `InitLog()`, `ZT_LOG_INFO` | 경고·에러 수거 |
| **OBJ 익스포트** | `Z-Weave/scene/zwObjExporter.h:18` — `SaveAllInOne()` | 정점 좌표를 텍스트로 얻어 **밖에서 수치 판정** |

익스포터는 OBJ 외에도 glTF/FBX/Alembic/USD가 있다 (`Z-Weave/scene/`). OBJ가 파싱이 가장 단순하다.

### 3.3 제약

| 제약 | 근거 | 영향 |
|---|---|---|
| **Windows에 파일 열기 인자가 없음** | `Z-Weave/zwAppZWeave.cpp:217-244`. 옵션은 `--audaces`, `--launcher-login`, `--launcher-logout`뿐이고 positional argument 처리가 없다 | `z-weave.exe project.zls` 불가. 파일 다이얼로그를 거쳐야 함 |
| Windows 로그인은 zlauncher URL 스킴 경유 | 같은 파일 | 자동화 시 로그인 상태가 전제 |
| `setObjectName` 호출이 21개 파일 44곳뿐 | 리포 검색 | 위젯에 안정적 식별자가 드묾. UIAutomation은 화면 텍스트 의존 → 취약 |
| `QLocalServer`/`QTcpServer`/`QWebSocketServer`가 리포 전체에 **없음** | 리포 전수 검색 | 기존 IPC 채널에 얹을 수 없음. 반대로 충돌할 구현도 없음 |
| `ZWEAVE_API` export가 3개 클래스뿐 | `zwMaterialManager.h:48`, `zwGltfExporter.h:16`, `zwSceneManagerProxy.h:25` | 앱 내부 직접 호출은 대부분 막힘 |

### 3.4 테스팅 빌드의 성질 (참고용, 현 설계에서는 미사용)

`ZWEAVE_TESTING=ON`이면 앱이 실행 파일이 아니라 **SHARED 라이브러리**로 빌드되고 `generate_export_header`로 `ZWEAVE_API`가 생성되며 `Z-Weave/testing/` 서브디렉토리가 추가된다 (`Z-Weave/CMakeLists.txt:760`, `:1123`). 프로덕션 빌드는 `else()` 분기로 더미 헤더를 쓴다 (`Z-Weave/ZWeaveExport.h` — `#define ZWEAVE_API`가 빈 값).

즉 "앱을 라이브러리로 링크하는 외부 타겟" 경로가 이미 존재한다. 유닛 테스트가 그렇게 동작한다 (`Z-Weave/testing/unit/CMakeLists.txt`의 `generate_unit_test_suite`).

**현 설계는 이 경로를 쓰지 않는다.** 완전 분리를 우선하기로 결정했기 때문이다 (§6.2). 다만 외부 접근만으로 한계에 부딪히면 되돌아올 수 있는 대안으로 기록해 둔다.

### 3.5 개발 환경

| 항목 | 상태 |
|---|---|
| Node | v24.19.0 **설치됨** |
| PowerShell | 5.1.26100 (전체 .NET Framework 접근 가능) |
| .NET SDK (`dotnet`) | **없음** |
| C# 컴파일러 | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` **존재** (Windows 내장, 설치 불필요) |
| Visual Studio | 2022 Community |
| Python | Microsoft Store 스텁만. 실사용 불가 → pywinauto 경로 배제 |

## 4. 아키텍처

세 구성요소가 각각 독립 실행된다. **Z-Weave 리포와 소스는 건드리지 않는다.**

```
z-weave.exe  [-style zwagent]      앱. 소스 변경 0줄.
   └─ zwagent.dll                  중간 계층. 별도 프로젝트.
                                   앱 프로세스 안에서 named pipe 서버로 동작.

zwprobe  (Node/TypeScript)         외부 프로그램. 두뇌이자 CLI.
   └─ zwwin.exe  (C#)              Win32 · UIAutomation 헬퍼.
```

| 구성요소 | 언어 | 역할 |
|---|---|---|
| `zwprobe` | TypeScript / Node 24 | CLI, 시나리오 실행, OBJ 파싱, 픽셀 diff, 판정, 리포트 |
| `zwwin.exe` | C# (csc.exe 빌드) | 창 찾기, `PrintWindow` 캡처, `SendInput`, UIAutomation 트리 |
| `zwagent.dll` | C++ / Qt 플러그인 | 앱 내부에서 위젯 트리 조회, `QAction::trigger()`, `QFileDialog` 자동 처리, `QWidget::grab()`, wait-for-idle |

### 4.1 왜 이 스택인가

- **`zwprobe`를 TypeScript로**: Node 24가 이미 있고, 사용자가 JS 개발자다. 시나리오와 판정 로직은 사용자가 직접 읽고 고쳐야 하는 부분이므로 사용자의 언어로 둔다.
- **`zwwin.exe`를 C#으로**: UIAutomation은 COM이라 Node의 FFI로 다루면 고통스럽다. .NET에는 `System.Windows.Automation`, `SendInput` P/Invoke, GDI 캡처가 모두 1급으로 있다. `dotnet` SDK가 없어도 Windows 내장 `csc.exe`로 빌드되므로 설치가 0이다. 이 층은 한 번 만들면 거의 변하지 않으므로 사용자가 손댈 일이 없다.
- **`zwagent.dll`을 Qt 플러그인으로**: §5 참조.

### 4.2 핵심 통찰 — Qt의 심볼만 있으면 된다

`zwagent.dll`이 앱 프로세스 안에 들어가면 **Z-Weave의 export된 심볼이 필요하지 않다.** 필요한 것은 Qt의 심볼이고 `Qt5Core.dll`/`Qt5Widgets.dll`은 전부 export한다. 따라서 Qt의 공개 API만으로 다음이 가능하다.

- `qApp->topLevelWidgets()` + `findChildren<QWidget*>()` → **실제 위젯 트리** (UIAutomation의 추측이 아니라 클래스명·objectName·geometry·enabled/visible 전부)
- `QAction::trigger()` → 메뉴를 좌표로 클릭하지 않고 액션을 이름으로 실행
- `QAbstractButton::click()`, `QLineEdit::text()/setText()` → 다이얼로그 값 읽기·쓰기
- `QFileDialog`가 뜨는 즉시 경로를 채우고 `accept()` → **§3.3의 최대 취약점 제거**
- `QWidget::grab()` → 특정 패널만 캡처. 화면 가림·DPI 무관
- 이벤트 루프 훅 → **진짜 wait-for-idle**
- `QMetaObject::invokeMethod` → `Q_OBJECT` 클래스의 슬롯을 문자열 이름으로 호출. 메타 정보가 바이너리 안에 있으므로 **`ZWEAVE_API` export 없이도 동작한다**

## 5. zwagent.dll 진입 방법

**1안 (우선): Qt 스타일 플러그인 + `-style zwagent`**

Qt는 `-style <이름>` 인자를 받으면 `styles/` 폴더에서 스타일 플러그인을 로드한다. 문서화된 표준 동작이며 `QApplication` 생성 시점에 플러그인의 `create()`가 호출된다. 거기서 브리지를 띄우고 프록시 스타일을 반환한다.

- 앱이 이후 `QApplication::setStyle(new zwStyle)`로 스타일을 덮어써도 우리 코드는 이미 실행됐고 DLL은 프로세스에 남는다
- Qt5는 `-style`을 argv에서 제거하므로 `zwAppZWeave.cpp:244`의 `parser.process(app)`에 영향이 없다
- 배포 폴더 `cmake_build/bin/Debug/`에 `styles/` 디렉토리가 이미 존재한다. 빌드 산출물이므로 리포와 무관하다
- **`-style zwagent`를 붙이지 않으면 아무것도 로드되지 않는다.** 평소 실행에 흔적이 없다

**2안 (대체): `CreateRemoteThread` + `LoadLibraryW` 주입**

플러그인 로드가 실패하면 자체 런처가 DLL을 주입한다. 확실히 동작하지만 EDR이 의심할 수 있다. 개발 머신에서 본인 앱을 대상으로 하는 것이므로 수용 가능. 이 경우도 앱 소스는 그대로다.

**ABI 제약 (양쪽 공통):** 플러그인은 Qt 5.15.6 + MSVC + 앱과 같은 Debug/Release 구성으로 빌드해야 한다. 디버그 앱은 `Qt5Cored.dll`을 쓰므로 디버그 플러그인이 따로 필요하다. **현 설계의 유일한 기술적 불확실성이며 M4에서 싸게 검증한다.**

## 6. 기각한 대안

### 6.1 앱 본체에 서버 삽입

`zwAppZWeave.cpp`에 `QLocalServer` 시작 코드를 넣는 방식. 프로덕션 실행 경로에 들어가므로 기각. 사용자가 완전 분리를 요구했고, `zwagent.dll`로 같은 기능을 얻을 수 있다.

### 6.2 테스팅 빌드 하위 타겟 (§3.4)

`Z-Weave/testing/` 아래 새 타겟을 만들어 앱을 라이브러리로 링크하는 방식. 릴리즈 바이너리에 한 바이트도 들어가지 않고 `zwSceneManagerProxy`가 이미 export되어 있어 씬 상태 조회가 가능하다는 장점이 있었다.

기각 이유: (a) Z-Weave 리포에 파일이 들어가고 CMake 1줄 수정이 필요하다. (b) 테스팅 빌드에서는 앱이 DLL이 되고 `main.cpp`가 빠지므로, 조작 대상이 일반 `z-weave.exe`가 아니라 테스트 실행 파일이 띄운 GUI가 된다. GUI가 정상적으로 올라오는지 자체가 미검증이다. (c) C++ 재빌드가 임계 경로에 들어온다.

**되돌아올 조건:** 외부 접근 + `zwagent.dll`로도 메쉬·씬 내부 데이터가 필요한 판정을 못 할 때.

### 6.3 Python / pywinauto

Python이 Store 스텁뿐이라 설치 비용이 발생한다. UIAutomation·`PrintWindow`·`SendInput`은 Windows 내장이므로 C#으로 설치 0에 해결된다.

### 6.4 Node FFI(koffi 등)로 Win32 직접 호출

캡처·입력은 가능하지만 UIAutomation이 COM이라 다루기 나쁘다. 얇은 C# 층이 낫다.

### 6.5 디버거(cdb/WinDbg) 경유

PDB가 있어 내부 상태 읽기가 이론상 가능하지만 느리고 취약하며, 브레이크 중 앱이 멈춘다.

## 7. 마일스톤

쪼개는 원칙: (1) 각 단계는 그 자체로 사용 가능하다. (2) 불확실한 것은 싸게 먼저 확인한다. (3) Z-Weave 소스 변경 0줄을 끝까지 유지한다.

| # | 내용 | 이 단계만으로 얻는 것 | 리스크 |
|---|---|---|---|
| **M1** | `zwprobe shot` — 창 찾기 + PNG 캡처 | **수동 업로드 소멸.** 이후 모든 단계를 눈으로 검증할 도구 | 없음 |
| **M2** | 입력(단축키·클릭), UIA 트리 덤프, 창 제목 파싱, 진행 다이얼로그 감지, 로그 tail | "키 누르고 → 캡처" 루프. 텍스트로 상태 확인 → 판독 오류·토큰 절약 | 없음 |
| **M3** | 시나리오 러너 + 픽셀 baseline diff | 재현 절차 재사용, 수정 후 회귀 확인 | 없음 |
| **M4** | **분기점.** Qt 픽스처 앱(§11.2) + hello 플러그인. 로드·ABI 검증 | ABI 불확실성 소각 **+ M5·M6의 테스트 하네스 확보**. 실패 시 §5 2안으로 전환 | 낮음 (실패해도 M1~M3 무손실) |
| **M5** | `zwagent.dll` 최소 기능 — named pipe + 위젯 트리 + `QAction::trigger()` + `QWidget::grab()` | 좌표 의존 대폭 감소. 메뉴 구조 변경에 안 깨짐 | 중 |
| **M6** | `QFileDialog` 자동 처리 + wait-for-idle | **진짜 자동 루프 성립.** 프로젝트 열기·익스포트 안정화 | 중 |
| **M7** | OBJ 익스포트 → 의상 메쉬 바운딩 박스·최저 Y를 아바타와 비교 | 흘러내림이 자동 단정으로 | 중 |

**M3까지가 투자 대비 효과의 대부분이다.** M1~M3은 리스크 0이고 외부에서만 돈다. M4 이후는 "더 안 깨지게" 만드는 작업이므로, M3까지 실사용해 실제로 무엇이 깨지는지 본 다음 M5를 설계한다. **M5의 API를 지금 확정하지 않는다.**

증분 빌드 시간 측정은 계획에서 제외했다. 앱을 재빌드할 일이 없으므로 임계 경로가 아니다.

## 8. 한계 — 사라지지 않는 것

- **핫 리로드가 없다.** web 루프의 힘은 도구가 아니라 수정→새로고침 1초다. 여기는 수정→msbuild→재실행→상태 재구성이고, 제너레이터가 msbuild이며 ccache/ninja가 없다. **web과 동등한 속도는 달성 불가**이며 `zwagent.dll`로도 개선되지 않는다.
- 좌표·화면 텍스트 기반 조작은 레이아웃·DPI 변경에 깨진다. 단축키 경로 우선, M5 이후 위젯 트리 기반으로 이전해 완화한다.
- 메쉬 정점 같은 비-QObject 내부 데이터는 직접 읽을 수 없다. OBJ 익스포트 경유이므로 한 사이클 더 걸린다.
- 일반 `z-weave.exe`는 zlauncher 로그인을 거친다. 이미 로그인된 상태가 전제다.

## 9. 버그 판단 경계

화면에서 버그를 판단할 때 **일반 상식을 먼저 적용한다.** 도메인 지식이 없다는 이유로 판단을 사용자에게 넘기지 않는다. 매 판단마다 사람을 부르면 자동 루프가 성립하지 않는다.

**Claude가 판단한다 (상식 범위):** 옷이 흘러내림·바닥으로 떨어짐·몸을 관통하거나 파묻힘, 메쉬 폭발, 봉제선 분리, 좌우 대칭이어야 할 것의 비대칭, 노멀 뒤집힘·텍스처 누락·검은 화면, 길이/둘레가 음수이거나 자리수가 터무니없음, NaN/빈 값, 텍스트 잘림·위젯이 패널 밖으로 나감, 클릭 무반응·다이얼로그가 안 닫힘, undo 후 상태 미복원.

**사용자에게 넘긴다 (상식 밖):** 수치의 정확성(12.5 대신 12.3), 원단 물성이 의도한 드레이프인지, 패턴 제작 규칙·업계 관행(그레이딩, 시접 방향), 주름·실루엣이 의도된 디자인인지 버그인지, 사내 스펙·고객 요구사항.

애매하면 빈 질문으로 되돌리지 않고 **판단과 근거를 먼저 제시한 뒤** 확인을 받는다.

## 11. 테스트 전략

목표는 **기능을 최소 단위로 테스트하면서 개발하는 것**이다. GUI를 상대하는 도구는 방치하면 "실앱을 띄워야만 확인 가능한 덩어리"가 되기 쉬우므로, 구조 제약을 먼저 건다.

### 11.1 구조 제약 — 판단은 TS에, I/O는 가장자리에

**`zwwin.exe`와 `zwagent.dll`은 아무것도 판단하지 않는다.** 창을 찾고, 캡처하고, 트리를 JSON으로 뱉을 뿐이다. 판정·비교·해석은 전부 `zwprobe`의 순수 함수에 둔다.

이 제약을 지키면 가치 있는 로직 전부가 OS도 앱도 없이 단위 테스트된다. 반대로 C# 층이나 DLL에 "이 다이얼로그가 뜨면 이렇게 하라" 같은 판단이 들어가면 테스트 불가능한 덩어리가 생긴다. **리뷰 시 이 경계를 먼저 본다.**

### 11.2 3단 구성

**1단 · 순수 단위 테스트** — 의존성 0, 밀리초 단위. 로직의 대부분이 여기 있다.

- OBJ 파서: 고정 `.obj` 픽스처 → 바운딩 박스·최저 Y
- 흘러내림 판정: 아바타 bbox + 의상 bbox → 판정 결과
- 창 제목 파서: 제목 문자열 → 파일명, dirty 여부
- 픽셀 diff: 고정 PNG 두 장 → 차이 비율
- UIA/위젯 트리 조회: 고정 JSON → 위젯 검색 결과
- 시나리오 러너: 브리지를 스텁으로 주입해 순서·실패 처리 검증

**도구는 Node 내장으로 충분하다.** Node 24는 타입이 붙은 `.ts`를 그대로 실행하고 `node --test`가 내장이다 (2026-09-08 실측 확인). 테스트 프레임워크도 빌드 단계도 없다. 제약은 erasable syntax만 쓸 수 있다는 것 — `enum`과 파라미터 프로퍼티를 쓰지 않고, 타입 전용 import는 `import type`으로 쓴다.

**2단 · 픽스처 통합 테스트** — 초 단위, **Z-Weave 없이 돈다.** 대상 앱을 직접 만든다.

- `fixtures/winapp` — WinForms 창 약 40줄, `csc.exe`로 빌드. 알려진 창 제목·버튼 이름·픽셀 패턴을 두고 `zwwin.exe`의 캡처·클릭·트리 덤프를 검증
- `fixtures/qtapp` — 최소 Qt 앱 약 50줄 (`QMainWindow` + `QAction` + `QFileDialog`). Qt 5.15.6 디버그 구성. `-style zwagent`로 플러그인을 로드해 **ABI·플러그인 발견·named pipe·위젯 트리·`QAction::trigger()`·파일 다이얼로그 자동 처리**를 검증

픽스처 앱을 갖는 이점은 결정적이다. **`zwagent.dll` 개발 중 Z-Weave를 띄울 필요가 없다** — 44MB 앱 로딩도, 로그인도, `.zls` 샘플도 필요 없이 초 단위로 반복한다.

**3단 · 실앱 스모크** — 실제 `z-weave.exe` 필요. 로그인 상태와 `.zls` 샘플이 전제다. 개수를 최소로 유지하고 태그로 분리해 기본 스위트에서 제외한다. 실앱에서만 드러나는 것(실제 메뉴 구조, 실제 진행 다이얼로그, 실제 익스포트 산출물)만 여기서 확인한다.

### 11.3 개발 루프 속도

§8에서 "핫 리로드가 없다"고 한 것은 **Z-Weave 버그를 고칠 때** 이야기다. zw-probe 자체 개발은 다르다.

- 1단: 밀리초. 파일 저장 → `node --test`
- 2단: 초. 우리 픽스처 앱과 작은 DLL만 재빌드
- Z-Weave는 재빌드하지 않는다 (소스를 수정하지 않으므로)

## 12. 열린 항목

| 항목 | 상태 |
|---|---|
| `zwagent.dll`의 ABI·로드 가능성 | **M4에서 검증.** 현 설계의 유일한 기술적 불확실성 |
| `ZWEAVE_TEST_SAMPLES_DIR` 경로 | 미확인. `build/run_cmake_testing_vs_2022.bat`에 빈 값이고 주석에 Dropbox 경로 예시가 있다. 현 설계에서는 불필요하나 §6.2로 되돌아가면 필요 |
| 로그 파일 실제 경로 | `InitLog()` 구현 확인 필요 (M2) |
| 단축키 목록 | `zwShortcutManager` 확인 필요 (M2). 가장 안정적인 조작 경로 |
| 팀 공유 여부 | 미정. 현재는 일반 폴더. 필요해지면 `git init` |
