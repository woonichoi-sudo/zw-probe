#include "actions.h"

#include <QAction>
#include <QApplication>
#include <QMenu>
#include <QSet>
#include <QWidget>

namespace
{
/// 이 메뉴가 사는 경로. 상위 메뉴를 거슬러 올라가며 제목을 이어붙인다.
///
/// `QMenu::menuAction()` 이 "그 메뉴를 여는 항목"이고, 그 항목이 다시 상위 메뉴에
/// 들어 있다. 서브메뉴(`File > Import`)가 이 사슬로 풀린다. 깊이 상한은 순환 방어다 —
/// 대상 앱을 신뢰해서 무한 루프를 만들 이유가 없다.
QString menuPath(const QMenu* menu, int depth = 0)
{
	if (menu == nullptr || depth > 8) return QString();
	const QAction* self = menu->menuAction();
	if (self == nullptr) return QString();

	QString parent;
	for (QWidget* w : self->associatedWidgets())
	{
		if (const auto* pm = qobject_cast<const QMenu*>(w))
		{
			parent = menuPath(pm, depth + 1);
			break;
		}
	}
	const QString title = self->text();
	if (title.isEmpty()) return parent;
	return parent.isEmpty() ? title : parent + QStringLiteral(" > ") + title;
}

/// 이 액션이 사는 메뉴 경로. 메뉴에 안 들어 있으면(툴바 등) 빈 문자열.
QString pathOf(const QAction* a)
{
	for (QWidget* w : a->associatedWidgets())
	{
		if (const auto* m = qobject_cast<const QMenu*>(w))
		{
			const QString p = menuPath(m);
			if (!p.isEmpty()) return p;
		}
	}
	return QString();
}

void walk(QWidget* w, QList<zwagent::ActionRef>& out, QSet<const QAction*>& seen)
{
	for (QAction* a : w->actions())
	{
		if (a == nullptr || seen.contains(a)) continue;
		seen.insert(a);
		out.append({a, pathOf(a)});
	}
	for (QObject* child : w->children())
	{
		if (auto* cw = qobject_cast<QWidget*>(child)) walk(cw, out, seen);
	}
}
} // namespace

namespace zwagent
{
QList<ActionRef> collectActions()
{
	QList<ActionRef> out;
	QSet<const QAction*> seen;
	for (QWidget* w : QApplication::topLevelWidgets()) walk(w, out, seen);
	return out;
}

QJsonObject describeAction(const ActionRef& ref)
{
	const QAction* a = ref.action;
	QJsonObject o;
	o[QStringLiteral("text")] = a->text();
	o[QStringLiteral("path")] = ref.path;
	o[QStringLiteral("objectName")] = a->objectName();
	// **부를 수 있는지 미리 안다.** 비활성 액션을 trigger 하면 Qt 가 조용히 아무것도
	// 안 한다 — 밖에서는 "불렀는데 화면이 안 바뀐다" 로만 보이고 원인을 못 짚는다.
	o[QStringLiteral("enabled")] = a->isEnabled();
	o[QStringLiteral("visible")] = a->isVisible();
	o[QStringLiteral("checkable")] = a->isCheckable();
	if (a->isCheckable()) o[QStringLiteral("checked")] = a->isChecked();
	o[QStringLiteral("separator")] = a->isSeparator();
	// 서브메뉴를 여는 항목인지. **이걸 trigger 해도 메뉴가 열릴 뿐 명령이 아니다.**
	o[QStringLiteral("isMenu")] = a->menu() != nullptr;
	const QString sc = a->shortcut().toString();
	if (!sc.isEmpty()) o[QStringLiteral("shortcut")] = sc;
	const QString tip = a->toolTip();
	if (!tip.isEmpty() && tip != a->text()) o[QStringLiteral("toolTip")] = tip;
	return o;
}
} // namespace zwagent
