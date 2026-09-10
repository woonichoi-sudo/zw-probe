// QAction 을 찾고 부르는 부분.
//
// **왜 QAction 인가.** 툴바 버튼에는 objectName 이 없고(실앱에서 보이는 54개 중 0개)
// 좌표는 레이아웃이 바뀌면 틀린다. 반면 메뉴 항목은 이름이 잘리지도 현지화 폭에
// 흔들리지도 않는다 — 실앱 트리가 File > Recent files, Window > 패널 이름,
// Development > 다이얼로그 샘플을 통째로 보여줬다 (2026-09-09).
//
// **이름은 유일하지 않다.** 실앱의 Import 와 Export 밑에 똑같이 `OBJ`·`FBX` 가 있다.
// 그래서 경로(`File > Import`)로 좁힐 수 있게 하고, **그래도 여럿이면 부르지 않고
// 후보를 돌려준다.** 조용히 첫 번째를 고르면 다른 명령이 실행된다 — `PostMessage` 가
// 수식키를 잃어 핀 도구를 켰던 것과 같은 종류의 사고다.

#pragma once

#include <QJsonObject>
#include <QList>
#include <QString>

class QAction;

namespace zwagent
{
/// 액션 하나와 그것이 사는 메뉴 경로.
struct ActionRef
{
	QAction* action = nullptr;
	/// `Fixture > Recent` 처럼 상위 메뉴 제목을 이어붙인 것. 툴바 액션이면 빈 문자열
	QString path;
};

/**
 * 프로세스 안의 QAction 전부.
 *
 * **위젯 트리와 같은 순서로 훑는다** — 최상위 위젯부터 자식으로 내려가며 각 위젯의
 * `actions()` 를 모으고 포인터로 중복을 지운다. `QApplication::allWidgets()` 를 쓰면
 * 순서가 보장되지 않아 같은 상태에서 두 번 물었을 때 답이 달라질 수 있다.
 */
QList<ActionRef> collectActions();

/// 액션 하나를 JSON 으로. 부를 수 있는지(`enabled`)까지 싣는다.
QJsonObject describeAction(const ActionRef& ref);
} // namespace zwagent
