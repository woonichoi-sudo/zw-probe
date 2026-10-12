#include "server.h"

#include "actions.h"
#include "tree.h"

#include <QCoreApplication>
#include <QAction>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QPixmap>
#include <QWidget>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QKeyEvent>
#include <QApplication>
#include <QMenu>
#include <QPointer>
#include <QTimer>
#include <QWindow>
#include <qpa/qwindowsysteminterface.h>

namespace
{
/// 응답 봉투. **성공과 실패가 같은 모양이어야** 밖에서 한 번에 읽는다.
QByteArray reply(const QJsonObject& body)
{
	// Compact 로 쓴다 — 실앱 트리가 6MB 이고 들여쓰기가 그걸 더 키운다.
	return QJsonDocument(body).toJson(QJsonDocument::Compact);
}


/// 열린 팝업 메뉴의 항목을 차례대로 — 보이는 것만, 하위 메뉴는 items 로. 판정은 TS(popup.ts)가 한다.
QJsonArray popupItems(const QMenu* menu, int depth = 0)
{
	QJsonArray arr;
	if (menu == nullptr || depth > 8) return arr;
	for (const QAction* a : menu->actions())
	{
		if (a == nullptr || !a->isVisible()) continue;
		QJsonObject o;
		o[QStringLiteral("text")] = a->text();
		o[QStringLiteral("enabled")] = a->isEnabled();
		o[QStringLiteral("checkable")] = a->isCheckable();
		if (a->isCheckable()) o[QStringLiteral("checked")] = a->isChecked();
		o[QStringLiteral("separator")] = a->isSeparator();
		if (a->menu() != nullptr) o[QStringLiteral("items")] = popupItems(a->menu(), depth + 1);
		arr.append(o);
	}
	return arr;
}

/// 지금 열린 팝업 메뉴(가장 바깥). 하위 메뉴가 열려 있으면 그 부모를 거슬러 올라간다.
QMenu* openPopup()
{
	QMenu* m = qobject_cast<QMenu*>(QApplication::activePopupWidget());
	for (int i = 0; m != nullptr && i < 8; i++)
	{
		QMenu* up = nullptr;
		if (const QAction* self = m->menuAction())
		{
			for (QWidget* w : self->associatedWidgets())
			{
				if (auto* pm = qobject_cast<QMenu*>(w); pm != nullptr && pm->isVisible()) { up = pm; break; }
			}
		}
		if (up == nullptr) break;
		m = up;
	}
	return m;
}

QByteArray fail(const QJsonValue& id, const QString& why)
{
	QJsonObject o;
	o[QStringLiteral("ok")] = false;
	if (!id.isUndefined()) o[QStringLiteral("id")] = id;
	o[QStringLiteral("error")] = why;
	return reply(o);
}

int intOr(const QJsonObject& o, const char* key, int fallback)
{
	const QJsonValue v = o.value(QLatin1String(key));
	return v.isDouble() ? v.toInt() : fallback;
}
} // namespace

namespace zwagent
{
QString pipeNameFor(qint64 pid)
{
	return QStringLiteral("zwagent-%1").arg(pid);
}

Server::Server(QObject* parent) : QObject(parent)
{
	m_name = pipeNameFor(QCoreApplication::applicationPid());
}

bool Server::listening() const
{
	return m_server != nullptr && m_server->isListening();
}

bool Server::listen()
{
	if (listening()) return true;

	m_server = new QLocalServer(this);
	// 앞선 실행이 비정상 종료하면 이름이 남아 `listen` 이 실패한다. 같은 pid 가
	// 재사용된 경우이므로 지우고 여는 것이 맞다.
	QLocalServer::removeServer(m_name);

	connect(m_server, &QLocalServer::newConnection, this, &Server::onNewConnection);

	if (!m_server->listen(m_name))
	{
		m_lastError = m_server->errorString();
		delete m_server;
		m_server = nullptr;
		return false;
	}
	m_lastError.clear();
	return true;
}

void Server::onNewConnection()
{
	while (QLocalSocket* sock = m_server->nextPendingConnection())
	{
		connect(sock, &QLocalSocket::readyRead, this, [this, sock]() { onReadyRead(sock); });
		connect(sock, &QLocalSocket::disconnected, sock, &QLocalSocket::deleteLater);
	}
}

void Server::onReadyRead(QLocalSocket* sock)
{
	// 줄 단위 프로토콜. 한 번의 readyRead 에 여러 줄이 올 수도 있고 한 줄이 쪼개져
	// 올 수도 있다 — **둘 다 실제로 일어난다.** 소켓에 버퍼를 붙여 완전한 줄만 처리한다.
	auto buf = sock->property("zwbuf").toByteArray();
	buf += sock->readAll();

	int nl;
	while ((nl = buf.indexOf('\n')) >= 0)
	{
		const QByteArray line = buf.left(nl);
		buf.remove(0, nl + 1);
		if (line.trimmed().isEmpty()) continue;
		sock->write(handle(line));
		sock->write("\n");
		sock->flush();
	}
	sock->setProperty("zwbuf", buf);
}

QByteArray Server::handle(const QByteArray& line)
{
	QJsonParseError err{};
	const QJsonDocument doc = QJsonDocument::fromJson(line, &err);
	if (err.error != QJsonParseError::NoError || !doc.isObject())
	{
		return fail(QJsonValue(), QStringLiteral("JSON 이 아니다: %1").arg(err.errorString()));
	}
	const QJsonObject req = doc.object();
	const QJsonValue id = req.value(QStringLiteral("id"));
	const QString op = req.value(QStringLiteral("op")).toString();

	QJsonObject out;
	out[QStringLiteral("ok")] = true;
	if (!id.isUndefined()) out[QStringLiteral("id")] = id;
	out[QStringLiteral("op")] = op;

	if (op == QStringLiteral("ping"))
	{
		// 살아 있는지, 누구인지. 파이프가 열렸다는 것 자체가 로드 확인이다.
		out[QStringLiteral("pid")] = QCoreApplication::applicationPid();
		out[QStringLiteral("qtRuntime")] = QString::fromLatin1(qVersion());
		out[QStringLiteral("appFilePath")] = QCoreApplication::applicationFilePath();
		return reply(out);
	}

	if (op == QStringLiteral("tree"))
	{
		// **온디맨드다.** hello 스냅샷과 달리 지금 이 순간의 트리이므로, 사람이 탭을
		// 바꾼 뒤에도 맞다. 상한은 요청이 정할 수 있게 열어둔다 — 큰 트리를 다 받는
		// 것이 기본이지만, 빠른 확인만 하고 싶을 때 줄일 수 있어야 한다.
		const int budget = intOr(req, "budget", kDefaultBudget);
		const int maxDepth = intOr(req, "maxDepth", kDefaultMaxDepth);
		if (budget < 1 || maxDepth < 0)
		{
			return fail(id, QStringLiteral("budget 은 1 이상, maxDepth 는 0 이상이어야 한다."));
		}
		out[QStringLiteral("widgetTotal")] = countAllWidgets();
		out[QStringLiteral("sawUi")] = haveVisibleUi();
		putTopLevelWidgets(out, budget, maxDepth);
		return reply(out);
	}

	if (op == QStringLiteral("actions"))
	{
		// 부를 수 있는 것의 목록. **여기서 거르지 않는다** — 필터링은 TS 가 한다
		// (절대 규칙 5). 실앱이 액션 수백 개라 커지지만 트리(6MB)보다 훨씬 작다.
		QJsonArray arr;
		for (const ActionRef& ref : collectActions()) arr.append(describeAction(ref));
		out[QStringLiteral("actions")] = arr;
		out[QStringLiteral("count")] = arr.size();
		return reply(out);
	}

	if (op == QStringLiteral("trigger"))
	{
		return handleTrigger(req, id, out);
	}

	if (op == QStringLiteral("popup"))
	{
		// 열린 팝업 메뉴(문맥 메뉴)의 항목. 없으면 open false
		QMenu* m = openPopup();
		out[QStringLiteral("open")] = m != nullptr;
		if (m != nullptr) out[QStringLiteral("items")] = popupItems(m);
		return reply(out);
	}

	if (op == QStringLiteral("popupTrigger"))
	{
		// 열린 팝업 메뉴에서 경로(글자 목록)로 항목 하나를 고른다 — 실제 클릭처럼 메뉴를 닫고 실행한다
		// (QMenuPrivate::activateAction: hideUpToMenuBar 뒤 activate). 모달이 뜰 수 있어 응답 뒤에 큐로
		const QJsonArray path = req.value(QStringLiteral("path")).toArray();
		QMenu* top = openPopup();
		if (top == nullptr) return fail(id, QStringLiteral("열린 팝업 메뉴가 없다."));
		if (path.isEmpty()) return fail(id, QStringLiteral("popupTrigger 에는 path(글자 배열)가 필요하다."));
		const QMenu* level = top;
		QAction* hit = nullptr;
		for (int i = 0; i < path.size(); i++)
		{
			const QString t = path.at(i).toString();
			QList<QAction*> hits;
			for (QAction* a : level->actions())
				if (a != nullptr && a->isVisible() && !a->isSeparator() && a->text() == t) hits.append(a);
			if (hits.size() != 1) return fail(id, QStringLiteral("\"%1\" 인 항목이 %2개다.").arg(t).arg(hits.size()));
			hit = hits.first();
			if (!hit->isEnabled()) return fail(id, QStringLiteral("\"%1\" 은 꺼져 있다.").arg(t));
			if (i < path.size() - 1)
			{
				if (hit->menu() == nullptr) return fail(id, QStringLiteral("\"%1\" 은 하위 메뉴가 아니다.").arg(t));
				level = hit->menu();
			}
			else if (hit->menu() != nullptr)
			{
				return fail(id, QStringLiteral("\"%1\" 은 하위 메뉴다.").arg(t));
			}
		}
		QPointer<QMenu> pm(top);
		QPointer<QAction> pa(hit);
		QTimer::singleShot(0, [pm, pa]() {
			if (pm) pm->hide();
			if (pa) pa->activate(QAction::Trigger);
		});
		out[QStringLiteral("text")] = hit->text();
		out[QStringLiteral("queued")] = true;
		return reply(out);
	}

	if (op == QStringLiteral("grab"))
	{
		return handleGrab(req, id, out);
	}

	if (op == QStringLiteral("mouse"))
	{
		return handleMouse(req, id, out);
	}

	if (op == QStringLiteral("key"))
	{
		return handleKey(req, id, out);
	}

	if (op == QStringLiteral("windows")) return handleWindows(req, id, out);
	if (op == QStringLiteral("shotWindow")) return handleShotWindow(req, id, out);
	if (op == QStringLiteral("clickWindow")) return handleClickWindow(req, id, out);
	if (op == QStringLiteral("keyWindow")) return handleKeyWindow(req, id, out);

	return fail(id, QStringLiteral("모르는 op: \"%1\"").arg(op));
}

/**
 * `QAction::trigger()`. **이 파일에서 유일하게 대상 앱을 바꾸는 곳이다.**
 *
 * 규칙 셋이 다 "조용히 틀리지 않기" 를 위한 것이다.
 *
 * ① **정확히 하나로 좁혀져야 부른다.** 이름은 유일하지 않다 — 실앱의 Import 와
 *    Export 밑에 똑같이 `OBJ` 가 있다. 여럿이면 부르지 않고 후보를 돌려준다.
 * ② **비활성이면 거부한다.** Qt 는 비활성 액션의 trigger 를 조용히 무시하므로,
 *    부르고 나서는 "안 눌렸다" 와 "눌렸는데 효과가 없다" 를 구분할 수 없다.
 * ③ **부르기 전에 응답을 보낸다.** `trigger()` 가 모달 다이얼로그를 띄우면 그 자리에서
 *    이벤트 루프가 멈추고 응답이 영영 안 나간다. 큐에 넣고 먼저 답한 다음, 결과는
 *    밖에서 관찰한다 — 어차피 "무엇이 일어났나" 는 화면과 트리를 봐야 안다.
 */
QByteArray Server::handleTrigger(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const QString text = req.value(QStringLiteral("text")).toString();
	if (text.isEmpty()) return fail(id, QStringLiteral("trigger 에는 text 가 필요하다."));
	// 경로는 선택이다. 주면 그것으로 좁힌다 (`Fixture > Recent`).
	const bool hasPath = req.contains(QStringLiteral("path"));
	const QString path = req.value(QStringLiteral("path")).toString();

	QList<ActionRef> hits;
	for (const ActionRef& ref : collectActions())
	{
		if (ref.action->text() != text) continue;
		if (hasPath && ref.path != path) continue;
		hits.append(ref);
	}

	if (hits.isEmpty())
	{
		return fail(id, QStringLiteral("\"%1\" 인 액션이 없다%2. actions 로 목록을 본다.")
		                    .arg(text, hasPath ? QStringLiteral(" (경로 \"%1\")").arg(path) : QString()));
	}
	if (hits.size() > 1)
	{
		// **후보를 돌려준다.** 어느 것인지 정하는 것은 부르는 쪽의 일이고, 여기서
		// 첫 번째를 고르면 다른 명령이 실행된다.
		QJsonObject o;
		o[QStringLiteral("ok")] = false;
		if (!id.isUndefined()) o[QStringLiteral("id")] = id;
		o[QStringLiteral("error")] =
		    QStringLiteral("\"%1\" 이 %2개다. path 로 좁힌다.").arg(text).arg(hits.size());
		QJsonArray arr;
		for (const ActionRef& ref : hits) arr.append(describeAction(ref));
		o[QStringLiteral("candidates")] = arr;
		return reply(o);
	}

	const ActionRef& ref = hits.first();
	if (!ref.action->isEnabled())
	{
		return fail(id, QStringLiteral("\"%1\" 은 비활성이다. 눌러도 아무 일도 일어나지 않는다.")
		                    .arg(text));
	}

	out[QStringLiteral("triggered")] = describeAction(ref);
	// **큐에 넣는다.** 여기서 직접 부르면 모달이 뜰 때 응답이 못 나간다.
	QMetaObject::invokeMethod(ref.action, "trigger", Qt::QueuedConnection);
	out[QStringLiteral("queued")] = true;
	return reply(out);
}
} // namespace zwagent

namespace zwagent
{
/**
 * `QWidget::grab()` — 위젯 하나만 찍는다.
 *
 * **`shot` 과 다른 점**은 창이 아니라 **위젯**이라는 것이다. 가려져 있어도, 스크롤
 * 밖에 있어도 찍힌다 — 위젯이 자기를 직접 그리기 때문이다. 패널 하나만 baseline 으로
 * 두고 싶을 때 창 전체를 비교하지 않아도 된다.
 *
 * **파일로 쓴다. base64 로 파이프에 싣지 않는다.** 트리가 이미 6MB 이고 여기에 이미지
 * 까지 얹으면 무거워진다. hello 파일이 이미 같은 방식이고, `zwwin.exe` 의 `shot` 도
 * 파일로 쓴다 — 형식을 맞추면 `diff`·`baseline` 이 그대로 받는다.
 *
 * **`.bgra` 는 `shot` 과 같은 바이트 배치여야 한다.** `Format_ARGB32` 는 리틀엔디언에서
 * 메모리에 B,G,R,A 순으로 놓이고 QImage 는 위에서 아래로 간다 — `shot` 이 내는 것과 같다.
 * 다르면 판정이 조용히 틀린다(색이 뒤집히거나 상하가 뒤집힌 채 "다르다" 만 나온다).
 */
QByteArray Server::handleGrab(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const QString name = req.value(QStringLiteral("objectName")).toString();
	if (name.isEmpty()) return fail(id, QStringLiteral("grab 에는 objectName 이 필요하다."));

	const QString pngPath = req.value(QStringLiteral("pngPath")).toString();
	const QString rawPath = req.value(QStringLiteral("rawPath")).toString();
	if (pngPath.isEmpty() && rawPath.isEmpty())
	{
		return fail(id, QStringLiteral("pngPath 나 rawPath 중 적어도 하나는 필요하다."));
	}

	const QList<QWidget*> hits = findByObjectName(name);
	if (hits.isEmpty())
	{
		return fail(id, QStringLiteral("objectName 이 \"%1\" 인 위젯이 없다.").arg(name));
	}
	if (hits.size() > 1)
	{
		// trigger 와 같은 규칙이다 — 여럿이면 고르지 않는다. 엉뚱한 위젯을 찍으면
		// 그 그림이 baseline 이 되고 그 뒤 비교가 전부 무의미해진다.
		return fail(id, QStringLiteral("objectName 이 \"%1\" 인 위젯이 %2개다.")
		                    .arg(name)
		                    .arg(hits.size()));
	}

	QWidget* w = hits.first();
	if (w->width() <= 0 || w->height() <= 0)
	{
		return fail(id, QStringLiteral("\"%1\" 의 크기가 %2x%3 이라 찍을 수 없다.")
		                    .arg(name)
		                    .arg(w->width())
		                    .arg(w->height()));
	}

	// **논리 크기로 찍는다.** HiDPI(macOS Retina, dpr=2)에서 grab 은 장치 픽셀(2배)로 나오는데,
	// shot·트리 좌표는 논리 픽셀이다 — 맞추지 않으면 PNG 에서 읽은 좌표가 2배로 틀린다.
	// dpr=1(이 프로젝트의 Windows)에서는 아무것도 바뀌지 않는다.
	QImage img = w->grab().toImage();
	if (img.width() != w->width() || img.height() != w->height())
	{
		img = img.scaled(w->size(), Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
	}
	img.setDevicePixelRatio(1.0);
	img = img.convertToFormat(QImage::Format_ARGB32);
	if (img.isNull()) return fail(id, QStringLiteral("\"%1\" 을 그리지 못했다.").arg(name));

	if (!pngPath.isEmpty())
	{
		QDir().mkpath(QFileInfo(pngPath).absolutePath());
		if (!img.save(pngPath, "PNG"))
		{
			return fail(id, QStringLiteral("PNG 를 쓰지 못했다: %1").arg(pngPath));
		}
	}
	if (!rawPath.isEmpty())
	{
		QDir().mkpath(QFileInfo(rawPath).absolutePath());
		QFile f(rawPath);
		if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
		{
			return fail(id, QStringLiteral("생 픽셀을 쓰지 못했다: %1").arg(rawPath));
		}
		// **줄마다 따로 쓴다.** QImage 는 스캔라인에 패딩을 둘 수 있고, 통째로 쓰면
		// 폭에 따라 어긋난 바이트가 섞인다.
		const int rowBytes = img.width() * 4;
		for (int y = 0; y < img.height(); y++)
		{
			f.write(reinterpret_cast<const char*>(img.constScanLine(y)), rowBytes);
		}
		f.close();
	}

	out[QStringLiteral("objectName")] = name;
	out[QStringLiteral("class")] = QString::fromUtf8(w->metaObject()->className());
	out[QStringLiteral("width")] = img.width();
	out[QStringLiteral("height")] = img.height();
	out[QStringLiteral("visible")] = w->isVisible();
	if (!pngPath.isEmpty()) out[QStringLiteral("pngPath")] = pngPath;
	if (!rawPath.isEmpty()) out[QStringLiteral("rawPath")] = rawPath;
	return reply(out);
}
} // namespace zwagent

namespace zwagent
{
namespace
{
struct MouseStep
{
	QEvent::Type type = QEvent::None;
	QPoint pos;
	Qt::MouseButton button = Qt::NoButton;
	Qt::KeyboardModifiers mods = Qt::NoModifier;
};
} // namespace

/**
 * 위젯 하나에 마우스 이벤트를 차례로 넣는다. **trigger 다음으로 대상 앱을 바꾸는 곳이다.**
 *
 * **왜 QWindowSystemInterface 인가.** 플랫폼 플러그인이 OS 마우스 입력을 Qt 에 넘기는 바로
 * 그 입구다. 그래서 ① 전역 상태(`QGuiApplication::keyboardModifiers()`·`mouseButtons()`)가
 * 실제 입력처럼 바뀌고 — 대상 앱의 스냅·사각형 도구가 이것을 읽는다 — ② 위젯 찾기·마우스
 * 잡기(grab)·더블클릭 판정이 Qt 자신의 규칙대로 된다. `sendEvent` 로 위젯에 바로 던지면
 * 이벤트만 맞고 전역은 비어 있다. 실제 커서는 안 움직이고 창 포커스도 안 뺏는다.
 *
 * **다 검사한 뒤 보낸다.** 하나라도 틀리면 하나도 보내지 않는다 — 누름만 가고 뗌이 거부되면
 * 앱에 눌린 버튼이 남는다. 같은 이유로 끝에 눌린 버튼이 남는 요청도 거부한다.
 *
 * **오른쪽 버튼은 받지 않는다.** 2D 뷰의 오른쪽 뗌이 문맥 메뉴를 띄울 수 있고, 메뉴의
 * `exec()` 는 여기서 동기로 부른 뗌 안에서 이벤트 루프를 돌려 응답을 막는다.
 *
 * 좌표는 위젯 기준 px. 위젯 밖 좌표는 거부한다 — 밖의 점은 다른 위젯이 받는다.
 */
QByteArray Server::handleMouse(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const QString name = req.value(QStringLiteral("objectName")).toString();
	if (name.isEmpty()) return fail(id, QStringLiteral("mouse 에는 objectName 이 필요하다."));

	const QList<QWidget*> hits = findByObjectName(name);
	if (hits.isEmpty()) return fail(id, QStringLiteral("objectName 이 \"%1\" 인 위젯이 없다.").arg(name));
	if (hits.size() > 1)
	{
		return fail(id, QStringLiteral("objectName 이 \"%1\" 인 위젯이 %2개다.").arg(name).arg(hits.size()));
	}
	QWidget* w = hits.first();
	if (!w->isVisible()) return fail(id, QStringLiteral("\"%1\" 이 보이지 않는다.").arg(name));

	// 위젯을 품은 창. 자기 창이 있으면(native) 그것, 아니면 가장 가까운 native 조상
	QWidget* host = w->windowHandle() != nullptr ? w : w->nativeParentWidget();
	QWindow* win = host != nullptr ? host->windowHandle() : nullptr;
	if (win == nullptr) return fail(id, QStringLiteral("\"%1\" 을 품은 창(QWindow)이 없다.").arg(name));

	const QJsonValue evv = req.value(QStringLiteral("events"));
	if (!evv.isArray() || evv.toArray().isEmpty())
	{
		return fail(id, QStringLiteral("events 는 비지 않은 배열이어야 한다."));
	}

	QList<MouseStep> steps;
	Qt::MouseButtons held = Qt::NoButton;
	const QJsonArray arr = evv.toArray();
	for (int i = 0; i < arr.size(); i++)
	{
		const QJsonObject e = arr.at(i).toObject();
		const QString at = QStringLiteral("events[%1]").arg(i);
		MouseStep st;
		const QString type = e.value(QStringLiteral("type")).toString();
		if (type == QStringLiteral("press")) st.type = QEvent::MouseButtonPress;
		else if (type == QStringLiteral("move")) st.type = QEvent::MouseMove;
		else if (type == QStringLiteral("release")) st.type = QEvent::MouseButtonRelease;
		else return fail(id, QStringLiteral("%1 의 type 은 press·move·release 중 하나다: \"%2\"").arg(at, type));

		const QString button = e.value(QStringLiteral("button")).toString(QStringLiteral("left"));
		if (button == QStringLiteral("left")) st.button = Qt::LeftButton;
		else if (button == QStringLiteral("middle")) st.button = Qt::MiddleButton;
		// 오른쪽 — 2D 뷰 문맥 메뉴는 QMenu::popup() 이라 응답을 막지 않는다(열린 메뉴는 popup·popupTrigger 로).
		// 오른쪽 누름이 모달 창을 exec 하는 상태(곡선 분할 도구)에서는 그 창이 닫힐 때까지 응답이 늦는다.
		else if (button == QStringLiteral("right")) st.button = Qt::RightButton;
		else
		{
			return fail(id, QStringLiteral("%1 의 button 은 left·middle·right 만 받는다: \"%2\"").arg(at, button));
		}

		const QJsonValue xv = e.value(QStringLiteral("x"));
		const QJsonValue yv = e.value(QStringLiteral("y"));
		if (!xv.isDouble() || !yv.isDouble()) return fail(id, QStringLiteral("%1 에 x·y(숫자)가 필요하다.").arg(at));
		// Qt 마우스 이벤트 위치는 정수 위젯 좌표다(대상 앱은 event->x() 를 읽는다). 반올림을 여기 한 곳에서 한다.
		st.pos = QPoint(qRound(xv.toDouble()), qRound(yv.toDouble()));
		if (!w->rect().contains(st.pos))
		{
			return fail(id, QStringLiteral("%1 의 (%2,%3) 이 위젯 밖이다 — 위젯은 %4x%5")
			                    .arg(at).arg(st.pos.x()).arg(st.pos.y()).arg(w->width()).arg(w->height()));
		}

		const QJsonObject m = e.value(QStringLiteral("modifiers")).toObject();
		if (m.value(QStringLiteral("shift")).toBool()) st.mods |= Qt::ShiftModifier;
		if (m.value(QStringLiteral("ctrl")).toBool()) st.mods |= Qt::ControlModifier;
		if (m.value(QStringLiteral("alt")).toBool()) st.mods |= Qt::AltModifier;

		if (st.type == QEvent::MouseButtonPress)
		{
			if (held & st.button) return fail(id, QStringLiteral("%1 은 이미 누른 버튼을 또 누른다.").arg(at));
			held |= st.button;
		}
		else if (st.type == QEvent::MouseButtonRelease)
		{
			if (!(held & st.button)) return fail(id, QStringLiteral("%1 은 누르지 않은 버튼을 뗀다.").arg(at));
			held &= ~Qt::MouseButtons(st.button);
		}
		steps.append(st);
	}
	if (held != Qt::NoButton) return fail(id, QStringLiteral("끝에 눌린 버튼이 남는다 — 뗌까지 한 요청에 넣는다."));

	// 보낸다. 버튼 상태는 Qt 규칙대로 — 누름·뗌의 state 는 그 이벤트 **뒤의** 눌린 버튼들이다.
	Qt::MouseButtons state = Qt::NoButton;
	int delivered = 0;
	for (const MouseStep& st : steps)
	{
		if (st.type == QEvent::MouseButtonPress) state |= st.button;
		else if (st.type == QEvent::MouseButtonRelease) state &= ~Qt::MouseButtons(st.button);
		const QPoint local = host == w ? st.pos : w->mapTo(host, st.pos);
		const QPoint global = w->mapToGlobal(st.pos);
		notePointer(global);
		QWindowSystemInterface::handleMouseEvent<QWindowSystemInterface::SynchronousDelivery>(
		    win, QPointF(local), QPointF(global), state,
		    st.type == QEvent::MouseMove ? Qt::NoButton : st.button, st.type, st.mods);
		delivered++;
		// 이벤트 사이에 앱이 다시 그리고 큐에 쌓인 일을 처리하게 한다 — 실제 입력도 그 사이에 루프가 돈다
		QCoreApplication::processEvents();
	}

	out[QStringLiteral("objectName")] = name;
	out[QStringLiteral("class")] = QString::fromUtf8(w->metaObject()->className());
	out[QStringLiteral("width")] = w->width();
	out[QStringLiteral("height")] = w->height();
	const QPoint tl = w->mapToGlobal(QPoint(0, 0));
	out[QStringLiteral("screenX")] = tl.x();
	out[QStringLiteral("screenY")] = tl.y();
	out[QStringLiteral("delivered")] = delivered;
	return reply(out);
}
} // namespace zwagent

namespace zwagent
{
/**
 * 위젯 하나에 키 누름·뗌을 `sendEvent` 로 보낸다. **대상 앱을 바꾼다** — 2D 뷰의 Delete 는 지운다.
 *
 * **왜 창이 아니라 위젯에 바로 보내는가.** zwwin 의 `key` 는 시스템 전역(keybd_event)이라 창을
 * 포그라운드로 올려야 하고, 사람이 다른 창을 쓰고 있으면 Windows 가 그걸 막아 **키가 남의 창으로
 * 간다**(2026-10-05 실제로). 대상 앱 2D 뷰는 `event->key()`·`modifiers()` 만 읽으므로
 * (zwQt2DView.cpp:930-964) 위젯에 직접 넣은 QKeyEvent 가 실제 키와 같다. 포커스도 안 바꾼다.
 *
 * 키 값(Qt::Key)과 글자는 TS 가 정한다(qtKey.ts) — 여기는 받은 대로 넣는다(절대 규칙 5).
 */
QByteArray Server::handleKey(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const QString name = req.value(QStringLiteral("objectName")).toString();
	if (name.isEmpty()) return fail(id, QStringLiteral("key 에는 objectName 이 필요하다."));
	const QJsonValue kv = req.value(QStringLiteral("key"));
	if (!kv.isDouble() || kv.toDouble() <= 0) return fail(id, QStringLiteral("key(Qt::Key 값, 양수)가 필요하다."));
	const int key = static_cast<int>(kv.toDouble());

	const QList<QWidget*> hits = findByObjectName(name);
	if (hits.isEmpty()) return fail(id, QStringLiteral("objectName 이 \"%1\" 인 위젯이 없다.").arg(name));
	if (hits.size() > 1)
	{
		return fail(id, QStringLiteral("objectName 이 \"%1\" 인 위젯이 %2개다.").arg(name).arg(hits.size()));
	}
	QWidget* w = hits.first();
	if (!w->isVisible()) return fail(id, QStringLiteral("\"%1\" 이 보이지 않는다.").arg(name));

	Qt::KeyboardModifiers mods = Qt::NoModifier;
	const QJsonObject m = req.value(QStringLiteral("modifiers")).toObject();
	if (m.value(QStringLiteral("shift")).toBool()) mods |= Qt::ShiftModifier;
	if (m.value(QStringLiteral("ctrl")).toBool()) mods |= Qt::ControlModifier;
	if (m.value(QStringLiteral("alt")).toBool()) mods |= Qt::AltModifier;
	const QString text = req.value(QStringLiteral("text")).toString();

	QKeyEvent press(QEvent::KeyPress, key, mods, text);
	QCoreApplication::sendEvent(w, &press);
	QCoreApplication::processEvents();
	QKeyEvent release(QEvent::KeyRelease, key, mods, text);
	QCoreApplication::sendEvent(w, &release);
	QCoreApplication::processEvents();

	out[QStringLiteral("objectName")] = name;
	out[QStringLiteral("class")] = QString::fromUtf8(w->metaObject()->className());
	out[QStringLiteral("key")] = key;
	out[QStringLiteral("pressAccepted")] = press.isAccepted();
	return reply(out);
}
} // namespace zwagent
