#include "tree.h"

#include <QAbstractButton>
#include <QAction>
#include <QApplication>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QWidget>

namespace
{
/// 빈 문자열은 싣지 않는다. 위젯 5199개 × 라벨 후보 5개면 대부분이 빈 값이고,
/// 그것만으로 파일이 배로 커진다.
void putIfSet(QJsonObject& o, const char* key, const QString& v)
{
	if (!v.isEmpty()) o[QLatin1String(key)] = v;
}

/**
 * 사람이 화면에서 보는 라벨.
 *
 * **objectName 만으로는 주소를 매길 수 없다.** 대상 앱에서 보이는 `zwQtButton` 54개 중
 * objectName 이 있는 것은 0개다 (2026-09-09 실측) — 툴바를 이름으로 누르려면 버튼
 * 자신의 라벨이 필요하다. 어디서 오는지 모르므로 **가능한 출처를 다 싣고 고르는 것은
 * TS 에 맡긴다** (절대 규칙 5). 라벨을 실은 뒤 54개 중 37개가 닿는다.
 *
 * `text` 는 위젯 종류마다 다른 게터에 있고 공통 기반이 없다. 그래서 캐스팅으로 훑는다.
 * `QLineEdit` 을 넣은 것은 **값 자체가 판정 대상**이기 때문이다 — 길이·둘레가 음수이거나
 * NaN 인 것을 잡는 것이 이 도구의 목적 중 하나다.
 */
void putLabels(QJsonObject& o, const QWidget* w)
{
	if (const auto* b = qobject_cast<const QAbstractButton*>(w)) putIfSet(o, "text", b->text());
	else if (const auto* l = qobject_cast<const QLabel*>(w)) putIfSet(o, "text", l->text());
	else if (const auto* e = qobject_cast<const QLineEdit*>(w)) putIfSet(o, "text", e->text());

	putIfSet(o, "toolTip", w->toolTip());
	putIfSet(o, "accessibleName", w->accessibleName());
	putIfSet(o, "windowTitle", w->windowTitle());

	// QAction 텍스트. 툴바 버튼이 라벨을 액션에만 갖고 있을 수 있다 — `QWidget::actions()`
	// 는 종류를 안 가리므로 캐스팅 없이 닿는다. QToolButton 의 defaultAction 도 여기 든다.
	//
	// **여기서 메뉴 구조가 통째로 나온다.** QMenu 의 actions() 가 항목 이름을 준다:
	// File 메뉴의 Recent files, Window 메뉴의 패널 이름, Development 메뉴 — UIA 가
	// 절반만 보여주던 것들이다.
	QJsonArray acts;
	for (const QAction* a : w->actions())
	{
		if (a != nullptr && !a->text().isEmpty()) acts.append(a->text());
	}
	if (!acts.isEmpty()) o[QStringLiteral("actions")] = acts;
}

int countWidgets(const QWidget* w)
{
	int n = 1;
	for (const QObject* child : w->children())
	{
		const auto* cw = qobject_cast<const QWidget*>(child);
		if (cw != nullptr) n += countWidgets(cw);
	}
	return n;
}
} // namespace

namespace zwagent
{
QJsonObject describeWidget(const QWidget* w, int depth, int maxDepth, int* budget)
{
	QJsonObject o;
	o[QStringLiteral("class")] = QString::fromUtf8(w->metaObject()->className());
	o[QStringLiteral("objectName")] = w->objectName();
	o[QStringLiteral("visible")] = w->isVisible();
	o[QStringLiteral("enabled")] = w->isEnabled();
	// **부모 기준이다.** 최상위만 화면 좌표이고 자식은 부모 안에서의 위치다 — 툴바
	// 버튼이 `3,3` 으로 나온다. 이것만으로는 누를 수 없다. 그래서 아래 절대 좌표를 함께 싣는다.
	const QRect g = w->geometry();
	o[QStringLiteral("x")] = g.x();
	o[QStringLiteral("y")] = g.y();
	o[QStringLiteral("width")] = g.width();
	o[QStringLiteral("height")] = g.height();

	// **화면 절대 좌표.** 여기서 변환하지 않는다 — 캡처 사각형 원점을 빼는 규칙이
	// `zwwin.exe` 한 곳에 모여 있고(그래서 UIA 와 클릭이 8px 씩 어긋나지 않는다),
	// 두 번째 변환 경로를 만들면 그 이점이 사라진다. 절대 좌표는 그 규칙의 입력이다.
	const QPoint tl = w->mapToGlobal(QPoint(0, 0));
	o[QStringLiteral("screenX")] = tl.x();
	o[QStringLiteral("screenY")] = tl.y();

	putLabels(o, w);

	if (depth >= maxDepth) return o;

	QJsonArray kids;
	for (QObject* child : w->children())
	{
		if (*budget <= 0) break;
		auto* cw = qobject_cast<QWidget*>(child);
		if (cw == nullptr) continue;
		(*budget)--;
		kids.append(describeWidget(cw, depth + 1, maxDepth, budget));
	}
	if (!kids.isEmpty()) o[QStringLiteral("children")] = kids;
	return o;
}

int countAllWidgets()
{
	int n = 0;
	for (const QWidget* w : QApplication::topLevelWidgets()) n += countWidgets(w);
	return n;
}

bool haveVisibleUi()
{
	for (const QWidget* w : QApplication::topLevelWidgets())
	{
		if (w->isVisible()) return true;
	}
	return false;
}

void putTopLevelWidgets(QJsonObject& root, int budget, int maxDepth)
{
	QJsonArray tops;
	const QWidgetList list = QApplication::topLevelWidgets();
	for (QWidget* w : list)
	{
		if (budget <= 0) break;
		budget--;
		tops.append(describeWidget(w, 0, maxDepth, &budget));
	}
	root[QStringLiteral("topLevelCount")] = list.size();
	root[QStringLiteral("topLevelWidgets")] = tops;
	root[QStringLiteral("widgetBudgetLeft")] = budget;
}
} // namespace zwagent

namespace zwagent
{
namespace
{
void collectByName(QWidget* w, const QString& name, QList<QWidget*>& out)
{
	if (w->objectName() == name) out.append(w);
	for (QObject* child : w->children())
	{
		if (auto* cw = qobject_cast<QWidget*>(child)) collectByName(cw, name, out);
	}
}
} // namespace

QList<QWidget*> findByObjectName(const QString& name)
{
	QList<QWidget*> out;
	if (name.isEmpty()) return out;
	for (QWidget* w : QApplication::topLevelWidgets()) collectByName(w, name, out);
	return out;
}
} // namespace zwagent
