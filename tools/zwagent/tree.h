// 위젯 트리를 JSON 으로 옮기는 공용 코드.
//
// hello 파일(1회 스냅샷)과 명령 채널(온디맨드 조회)이 **같은 코드를 써야 한다.**
// 두 벌이면 필드가 갈라지고, 밖에서는 어느 쪽을 읽었는지에 따라 답이 달라진다.
//
// **여기는 판정하지 않는다** (절대 규칙 5). 찾고, 세고, JSON 을 뱉을 뿐이다.

#pragma once

#include <QJsonObject>
#include <QList>
#include <QString>

class QWidget;

namespace zwagent
{
/// 위젯 수·깊이 상한의 기본값. 폭주 방지용이고 정상 규모를 자르는 값이면 안 된다 —
/// 실앱이 5199개라 옛 값 500·6 은 트리의 90% 를 잘랐다 (2026-09-09 실측).
constexpr int kDefaultBudget = 12000;
constexpr int kDefaultMaxDepth = 40;

/// 위젯 하나를 JSON 으로. `budget` 은 남은 위젯 수이고 재귀하며 줄어든다.
QJsonObject describeWidget(const QWidget* w, int depth, int maxDepth, int* budget);

/// 프로세스 안의 위젯 총 개수. **깊이·개수 상한이 없다.**
///
/// 두 곳에 쓴다. ① JSON 트리가 상한에 잘려도 **몇 개인지는 알 수 있다**. ② 이 값이
/// 멈추는 것이 UI 가 정착했다는 신호다. 클래스 이름을 찾지 않으므로 대상 앱 지식이 0이다.
int countAllWidgets();

/// 보이는 최상위 위젯이 하나라도 있는가.
///
/// **이것만으로는 "UI 가 떴다" 가 아니다.** 대상 앱은 메인 창보다 65초 먼저 스플래시를
/// 띄우고, 첫 폴링에서 이 함수가 이미 true 다 (2026-09-09 실측). 정착 판정은
/// countAllWidgets 가 멈추는 것으로 한다.
bool haveVisibleUi();

/// 최상위 위젯 전부를 JSON 으로. `topLevelCount`·`topLevelWidgets`·`widgetBudgetLeft` 를 넣는다.
void putTopLevelWidgets(QJsonObject& root, int budget, int maxDepth);

/// objectName 이 정확히 일치하는 위젯 전부. **여럿일 수 있다** — 고르는 것은 부르는 쪽이다.
QList<QWidget*> findByObjectName(const QString& name);
} // namespace zwagent
