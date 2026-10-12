// 창 단위 op — `windows`·`shotWindow`·`clickWindow`·`keyWindow`.
//
// **왜 프로세스 안에서 창을 다루는가 (macOS, 2026-10-12).** Windows 에서는 `zwwin.exe` 가 밖에서
// 창 목록·캡처·입력을 한다. macOS 에서 밖에서 같은 일을 하려면 화면 기록·손쉬운 사용 권한(TCC)이
// 필요하고, 그 권한은 사람이 시스템 설정에서 줘야 하며 터미널마다 다르다. 앱 프로세스 안에서는
// **자기 창을 찍고 자기에게 입력을 넣는 데 권한이 필요 없다.** 그래서 macOS 의 `zwmac`(TS)은
// 이 op 들로 `zwwin.exe` 와 같은 JSON 을 만든다. Windows 에서도 동작은 하지만 쓰지 않는다.
//
// **판정하지 않는다** (절대 규칙 5). 어느 창이 메인인지, 바쁜지는 TS(windowState.ts)가 정한다.
// 여기는 Qt 가 아는 사실 — 소유 창(transient parent), 모달로 막혔는가 — 을 그대로 싣는다.
//
// **입력은 응답 뒤에 큐로 넣는다.** 클릭이 모달 다이얼로그를 `exec()` 하면 그 자리에서 이벤트
// 루프가 멈추고 응답이 영영 안 나간다 — trigger 와 같은 이유다. 무슨 일이 일어났는지는
// 밖에서 다시 관찰한다.

#include "server.h"

#include <QApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonDocument>
#include <QKeyEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPixmap>
#include <QPointer>
#include <QTimer>
#include <QWidget>
#include <QWindow>
#include <private/qguiapplication_p.h>
#include <qpa/qwindowsysteminterface.h>

namespace zwagent
{
namespace
{
QByteArray replyJson(const QJsonObject& body)
{
	return QJsonDocument(body).toJson(QJsonDocument::Compact);
}

QByteArray failJson(const QJsonValue& id, const QString& why)
{
	QJsonObject o;
	o[QStringLiteral("ok")] = false;
	if (!id.isUndefined()) o[QStringLiteral("id")] = id;
	o[QStringLiteral("error")] = why;
	return replyJson(o);
}

QPoint g_lastPointer(-1, -1);

/// 창의 id. **native 창 핸들(winId)이다** — macOS 에서는 NSView 주소. JSON 숫자(double)로
/// 정확히 실리는 범위(2^53)다. 0 은 "없음" 으로 쓰므로 창 id 가 될 수 없다.
qint64 windowId(const QWidget* w)
{
	return w == nullptr ? 0 : static_cast<qint64>(w->winId());
}

/// 보이는 최상위 위젯들. 숨김·크기 0 은 뺀다 — 밖에서 보는 "창" 이 아니다.
QList<QWidget*> visibleWindows()
{
	QList<QWidget*> out;
	for (QWidget* w : QApplication::topLevelWidgets())
	{
		if (w == nullptr || !w->isWindow() || !w->isVisible()) continue;
		if (w->width() <= 0 || w->height() <= 0) continue;
		if (w->windowHandle() == nullptr) continue;
		out.append(w);
	}
	return out;
}

QWidget* windowById(qint64 id)
{
	for (QWidget* w : visibleWindows())
	{
		if (windowId(w) == id) return w;
	}
	return nullptr;
}

/// 소유 창 — Qt 가 다이얼로그에 붙이는 transient parent. 없으면 부모 위젯의 창.
QWidget* ownerOf(QWidget* w)
{
	QWindow* tp = w->windowHandle() != nullptr ? w->windowHandle()->transientParent() : nullptr;
	if (tp != nullptr)
	{
		for (QWidget* c : QApplication::topLevelWidgets())
		{
			if (c != nullptr && c->windowHandle() == tp) return c;
		}
	}
	if (w->parentWidget() != nullptr) return w->parentWidget()->window();
	return nullptr;
}

/// 모달에 막혀 입력을 못 받는가. Qt 는 macOS 에서 막힌 창을 `setEnabled(false)` 하지 않고
/// 이벤트를 걸러낸다 — 그래서 isEnabled 만 보면 "받는다" 로 틀린다.
bool isBlocked(QWidget* w)
{
	QWindow* win = w->windowHandle();
	return win != nullptr && QGuiApplicationPrivate::instance() != nullptr &&
	       QGuiApplicationPrivate::instance()->isWindowBlocked(win);
}

QJsonObject describeWindow(QWidget* w)
{
	QJsonObject o;
	const QPoint tl = w->mapToGlobal(QPoint(0, 0));
	o[QStringLiteral("id")] = windowId(w);
	o[QStringLiteral("owner")] = windowId(ownerOf(w));
	o[QStringLiteral("title")] = w->windowTitle();
	o[QStringLiteral("class")] = QString::fromUtf8(w->metaObject()->className());
	o[QStringLiteral("objectName")] = w->objectName();
	o[QStringLiteral("enabled")] = w->isEnabled();
	o[QStringLiteral("blocked")] = isBlocked(w);
	o[QStringLiteral("modal")] = w->isModal();
	o[QStringLiteral("popup")] = w->windowType() == Qt::Popup;
	o[QStringLiteral("toolTip")] = w->windowType() == Qt::ToolTip;
	o[QStringLiteral("active")] = w->isActiveWindow();
	o[QStringLiteral("minimized")] = w->isMinimized();
	// 클라이언트 영역(= grab 이 찍는 영역)의 화면 좌표. 창 기준 좌표의 원점이다
	o[QStringLiteral("x")] = tl.x();
	o[QStringLiteral("y")] = tl.y();
	o[QStringLiteral("width")] = w->width();
	o[QStringLiteral("height")] = w->height();
	o[QStringLiteral("dpr")] = w->devicePixelRatioF();
	return o;
}

/// 겹쳐 그릴 순서. Qt 는 창의 z 순서를 알려주지 않는다 — 실제 화면에서 위에 오는 순서를 근사한다:
/// 보통 창 → 다이얼로그(소유 창이 있는 것) → 팝업(메뉴·콤보 목록) → 툴팁.
int layerOf(QWidget* w)
{
	if (w->windowType() == Qt::ToolTip) return 3;
	if (w->windowType() == Qt::Popup) return 2;
	if (ownerOf(w) != nullptr || w->isModal()) return 1;
	return 0;
}

QImage grabLogical(QWidget* w, bool logical, bool fast = false)
{
	QImage img = w->grab().toImage();
	if (logical && (img.width() != w->width() || img.height() != w->height()))
	{
		// fast 는 녹화용 — 부드러운 축소가 프레임당 시간을 먹어 fps 를 못 따라간다(2026-10-12: 복제 64%)
		img = img.scaled(w->size(), Qt::IgnoreAspectRatio, fast ? Qt::FastTransformation : Qt::SmoothTransformation);
	}
	img.setDevicePixelRatio(1.0);
	return img.convertToFormat(QImage::Format_ARGB32);
}

/// 화살표 커서. 실제 커서 그림이 아니라 "여기를 눌렀다" 를 보이기 위한 표시다.
void drawPointer(QImage& img, QPoint at, double scale)
{
	QPainter p(&img);
	p.setRenderHint(QPainter::Antialiasing);
	p.translate(at.x() * scale, at.y() * scale);
	p.scale(scale, scale);
	QPainterPath path;
	path.moveTo(0, 0);
	path.lineTo(0, 17);
	path.lineTo(4.5, 13);
	path.lineTo(7.5, 19.5);
	path.lineTo(10, 18.5);
	path.lineTo(7, 12);
	path.lineTo(12.5, 12);
	path.closeSubpath();
	p.setPen(QPen(Qt::white, 1.5));
	p.setBrush(Qt::black);
	p.drawPath(path);
}

bool writeImage(const QImage& img, const QString& pngPath, const QString& rawPath, QString* err)
{
	if (!pngPath.isEmpty())
	{
		QDir().mkpath(QFileInfo(pngPath).absolutePath());
		if (!img.save(pngPath, "PNG"))
		{
			*err = QStringLiteral("PNG 를 쓰지 못했다: %1").arg(pngPath);
			return false;
		}
	}
	if (!rawPath.isEmpty())
	{
		QDir().mkpath(QFileInfo(rawPath).absolutePath());
		QFile f(rawPath);
		if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
		{
			*err = QStringLiteral("생 픽셀을 쓰지 못했다: %1").arg(rawPath);
			return false;
		}
		// shot·grab 과 같은 배치 — 위에서 아래로, B,G,R,A. 줄마다 쓴다(스캔라인 패딩)
		const int rowBytes = img.width() * 4;
		for (int y = 0; y < img.height(); y++) f.write(reinterpret_cast<const char*>(img.constScanLine(y)), rowBytes);
		f.close();
	}
	return true;
}

Qt::KeyboardModifiers modsFrom(const QJsonObject& m)
{
	Qt::KeyboardModifiers mods = Qt::NoModifier;
	if (m.value(QStringLiteral("shift")).toBool()) mods |= Qt::ShiftModifier;
	// Qt 의 Ctrl 은 macOS 에서 Command 키다(Qt 가 바꿔 싣는다). 대상 앱의 "Ctrl+Z" 단축키도
	// Qt::ControlModifier 로 정의돼 있으므로 여기서 Qt 값 그대로 넣으면 맞는다
	if (m.value(QStringLiteral("ctrl")).toBool()) mods |= Qt::ControlModifier;
	if (m.value(QStringLiteral("alt")).toBool()) mods |= Qt::AltModifier;
	return mods;
}

QJsonObject idName(QWidget* w)
{
	QJsonObject o;
	o[QStringLiteral("id")] = windowId(w == nullptr ? nullptr : w->window());
	o[QStringLiteral("class")] = w == nullptr ? QString() : QString::fromUtf8(w->metaObject()->className());
	o[QStringLiteral("objectName")] = w == nullptr ? QString() : w->objectName();
	return o;
}
} // namespace

/// 마지막으로 넣은 마우스 위치(화면 좌표). 캡처에 커서를 그려 넣는 데 쓴다 — 프로세스 안 입력은
/// 실제 커서를 안 움직이므로, 녹화에서 어디를 눌렀는지 보이려면 이것뿐이다. mouse op(server.cpp)도 남긴다.
void notePointer(QPoint global)
{
	g_lastPointer = global;
}

QByteArray Server::handleWindows(const QJsonObject&, const QJsonValue&, QJsonObject& out)
{
	QJsonArray arr;
	for (QWidget* w : visibleWindows()) arr.append(describeWindow(w));
	out[QStringLiteral("windows")] = arr;
	out[QStringLiteral("activeModal")] = windowId(QApplication::activeModalWidget());
	out[QStringLiteral("activePopup")] = windowId(QApplication::activePopupWidget());
	out[QStringLiteral("activeWindow")] = windowId(QApplication::activeWindow());
	out[QStringLiteral("appVersion")] = QCoreApplication::applicationVersion();
	out[QStringLiteral("appFilePath")] = QCoreApplication::applicationFilePath();
	out[QStringLiteral("pid")] = QCoreApplication::applicationPid();
	return replyJson(out);
}

/**
 * 창 하나를 찍는다. `composite` 면 그 창 위에 겹친 다른 최상위 창(다이얼로그·메뉴·툴팁)을
 * 화면 위치에 겹쳐 그린다 — Windows `shot --mode screen` 에 해당한다. 아니면 그 창만
 * (`printwindow` 에 해당). `logical` 이면 HiDPI 를 논리 크기로 줄인다 — **PNG 좌표 = 클릭 좌표**
 * 를 지키기 위해서다.
 */
QByteArray Server::handleShotWindow(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const qint64 wid = static_cast<qint64>(req.value(QStringLiteral("window")).toDouble());
	QWidget* w = windowById(wid);
	if (w == nullptr) return failJson(id, QStringLiteral("id 가 %1 인 보이는 창이 없다.").arg(wid));

	const QString pngPath = req.value(QStringLiteral("pngPath")).toString();
	const QString rawPath = req.value(QStringLiteral("rawPath")).toString();
	if (pngPath.isEmpty() && rawPath.isEmpty()) return failJson(id, QStringLiteral("pngPath 나 rawPath 가 필요하다."));
	const bool composite = req.value(QStringLiteral("composite")).toBool(true);
	const bool logical = req.value(QStringLiteral("logical")).toBool(true);
	const bool cursor = req.value(QStringLiteral("cursor")).toBool(false);
	const bool fast = req.value(QStringLiteral("fast")).toBool(false);

	QImage img = grabLogical(w, logical, fast);
	if (img.isNull()) return failJson(id, QStringLiteral("창을 그리지 못했다."));
	const double scale = logical ? 1.0 : w->devicePixelRatioF();
	const QPoint origin = w->mapToGlobal(QPoint(0, 0));
	const QRect self(origin, w->size());

	QJsonArray layered;
	if (composite)
	{
		QList<QWidget*> others;
		for (QWidget* o : visibleWindows())
		{
			if (o == w || o->isMinimized()) continue;
			if (!self.intersects(QRect(o->mapToGlobal(QPoint(0, 0)), o->size()))) continue;
			others.append(o);
		}
		std::stable_sort(others.begin(), others.end(), [](QWidget* a, QWidget* b) { return layerOf(a) < layerOf(b); });
		QPainter p(&img);
		for (QWidget* o : others)
		{
			const QImage oi = grabLogical(o, logical, fast);
			const QPoint d = o->mapToGlobal(QPoint(0, 0)) - origin;
			p.drawImage(QPointF(d.x() * scale, d.y() * scale), oi);
			layered.append(describeWindow(o));
		}
	}
	if (cursor && g_lastPointer.x() >= 0)
	{
		const QPoint at = g_lastPointer - origin;
		if (QRect(QPoint(0, 0), w->size()).contains(at)) drawPointer(img, at, scale);
	}

	QString err;
	if (!writeImage(img, pngPath, rawPath, &err)) return failJson(id, err);

	out[QStringLiteral("window")] = describeWindow(w);
	out[QStringLiteral("layered")] = layered;
	out[QStringLiteral("width")] = img.width();
	out[QStringLiteral("height")] = img.height();
	if (!pngPath.isEmpty()) out[QStringLiteral("pngPath")] = pngPath;
	if (!rawPath.isEmpty()) out[QStringLiteral("rawPath")] = rawPath;
	return replyJson(out);
}

/**
 * 창 기준 좌표 한 점을 누른다. 위젯을 고르는 것은 Qt 다 — 실제 클릭처럼 그 점 아래 위젯이 받는다.
 *
 * **누르기 전에 그 점에 무엇이 있는지 답한다**(`hit`·`root`). zwwin 의 `hwndAtPoint`·
 * `rootAtPoint` 에 해당하고, 다른 창이 덮고 있으면 root 가 대상 창과 다르다.
 */
QByteArray Server::handleClickWindow(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const qint64 wid = static_cast<qint64>(req.value(QStringLiteral("window")).toDouble());
	QWidget* w = windowById(wid);
	if (w == nullptr) return failJson(id, QStringLiteral("id 가 %1 인 보이는 창이 없다.").arg(wid));
	QWindow* win = w->windowHandle();

	const QJsonValue xv = req.value(QStringLiteral("x"));
	const QJsonValue yv = req.value(QStringLiteral("y"));
	if (!xv.isDouble() || !yv.isDouble()) return failJson(id, QStringLiteral("x·y(숫자)가 필요하다."));
	const QPoint local(qRound(xv.toDouble()), qRound(yv.toDouble()));
	if (!w->rect().contains(local))
	{
		return failJson(id, QStringLiteral("(%1,%2) 이 창 밖이다 — 창은 %3x%4")
		                        .arg(local.x()).arg(local.y()).arg(w->width()).arg(w->height()));
	}

	const QString button = req.value(QStringLiteral("button")).toString(QStringLiteral("left"));
	Qt::MouseButton b;
	if (button == QStringLiteral("left")) b = Qt::LeftButton;
	else if (button == QStringLiteral("right")) b = Qt::RightButton;
	else if (button == QStringLiteral("middle")) b = Qt::MiddleButton;
	else return failJson(id, QStringLiteral("button 은 left·right·middle 이다: \"%1\"").arg(button));
	const bool dbl = req.value(QStringLiteral("double")).toBool(false);
	const int holdMs = qMax(0, req.value(QStringLiteral("holdMs")).toInt(0));
	const Qt::KeyboardModifiers mods = modsFrom(req.value(QStringLiteral("modifiers")).toObject());

	const QPoint global = w->mapToGlobal(local);
	QWidget* hit = QApplication::widgetAt(global);
	QWidget* root = QApplication::topLevelAt(global);

	out[QStringLiteral("window")] = describeWindow(w);
	out[QStringLiteral("x")] = local.x();
	out[QStringLiteral("y")] = local.y();
	out[QStringLiteral("screenX")] = global.x();
	out[QStringLiteral("screenY")] = global.y();
	out[QStringLiteral("hit")] = idName(hit);
	out[QStringLiteral("root")] = idName(root);
	out[QStringLiteral("blocked")] = isBlocked(w);
	out[QStringLiteral("queued")] = true;

	// **그 점의 맨 위 창이 받는다** — 실제 클릭과 같다. 소유 다이얼로그가 메인 위에 떠 있으면 다이얼로그가
	// 받는다(Windows zwwin 의 클릭도 화면 좌표라 그렇다). 메인 창에 그대로 넣으면 모달에 막혀 버려진다.
	QWidget* dest = (root != nullptr && root->isVisible() && root->windowHandle() != nullptr) ? root : w;
	if (dest != w) win = dest->windowHandle();
	const QPoint pt = dest->mapFromGlobal(global);
	out[QStringLiteral("deliveredTo")] = idName(dest);

	// 응답 뒤에 넣는다. 누름이 모달을 exec 하면 그 안에서 루프가 돈다 — 뗌은 그 루프가 처리한다
	QPointer<QWindow> pw(win);
	const auto press = [pw, pt, global, b, mods](Qt::MouseButtons state, QEvent::Type t) {
		if (!pw) return;
		QWindowSystemInterface::handleMouseEvent<QWindowSystemInterface::SynchronousDelivery>(
		    pw, QPointF(pt), QPointF(global), state, b, t, mods);
	};
	g_lastPointer = global;
	QTimer::singleShot(0, [press, pw, pt, global, mods, dbl, holdMs, b]() {
		if (!pw) return;
		// 먼저 그 자리로 옮긴다 — hover·enter 를 받는 위젯이 있다
		QWindowSystemInterface::handleMouseEvent<QWindowSystemInterface::SynchronousDelivery>(
		    pw, QPointF(pt), QPointF(global), Qt::NoButton, Qt::NoButton, QEvent::MouseMove, mods);
		press(b, QEvent::MouseButtonPress);
		const auto release = [press, dbl, b]() {
			press(Qt::NoButton, QEvent::MouseButtonRelease);
			if (dbl)
			{
				// 두 번째 누름은 Qt 가 간격·거리로 더블클릭으로 바꾼다 — 실제 입력과 같은 규칙이다
				press(b, QEvent::MouseButtonPress);
				press(Qt::NoButton, QEvent::MouseButtonRelease);
			}
		};
		if (holdMs > 0) QTimer::singleShot(holdMs, release);
		else release();
	});
	return replyJson(out);
}

/**
 * 창에 키 하나(누름·뗌)를 넣는다. **단축키가 Qt 의 규칙대로 처리된다** — QWindowSystemInterface
 * 는 키를 위젯보다 먼저 단축키 맵에 보여준다(실제 키와 같은 길). 위젯에 직접 보내는 `key` op 는
 * 그 길을 안 거친다.
 */
QByteArray Server::handleKeyWindow(const QJsonObject& req, const QJsonValue& id, QJsonObject& out)
{
	const qint64 wid = static_cast<qint64>(req.value(QStringLiteral("window")).toDouble());
	QWidget* w = windowById(wid);
	if (w == nullptr) return failJson(id, QStringLiteral("id 가 %1 인 보이는 창이 없다.").arg(wid));
	// **모달이 막고 있으면 키는 모달이 받는다** — 실제 키보드와 같다(막힌 창을 활성화하면 OS 가 모달을
	// 앞으로 올린다). 막힌 창에 그대로 넣으면 Qt 가 버린다. 어디로 갔는지는 응답의 window 가 말한다.
	if (isBlocked(w) && QApplication::activeModalWidget() != nullptr) w = QApplication::activeModalWidget();
	const QJsonValue kv = req.value(QStringLiteral("key"));
	if (!kv.isDouble() || kv.toDouble() <= 0) return failJson(id, QStringLiteral("key(Qt::Key 값, 양수)가 필요하다."));
	const int key = static_cast<int>(kv.toDouble());
	const Qt::KeyboardModifiers mods = modsFrom(req.value(QStringLiteral("modifiers")).toObject());
	const QString text = req.value(QStringLiteral("text")).toString();
	const int holdMs = qMax(0, req.value(QStringLiteral("holdMs")).toInt(0));
	const bool activate = req.value(QStringLiteral("activate")).toBool(true);

	// **창을 활성으로 만든다.** 창 범위 단축키(Qt::WindowShortcut)는 활성 창에서만 맞는다 —
	// 사람이 다른 앱을 쓰고 있으면 앱 전체가 비활성이라 단축키가 조용히 버려진다. Windows 의
	// zwwin key 가 창을 포그라운드로 올리는 것과 같다.
	// macOS 의 활성화는 창 서버를 거쳐 **비동기로** 온다 — 부르고 바로 보면 아직 비활성이다(2026-10-12 실측:
	// 키는 들어갔는데 "포그라운드 실패" 로 보고됐다). 상한을 두고 기다린다.
	if (activate && !w->isActiveWindow())
	{
		w->raise();
		w->activateWindow();
		QElapsedTimer t;
		t.start();
		while (!w->isActiveWindow() && t.elapsed() < 1500) QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
	}

	QObject* focus = QGuiApplication::focusObject();
	out[QStringLiteral("window")] = describeWindow(w);
	out[QStringLiteral("activeAfter")] = w->isActiveWindow();
	out[QStringLiteral("focusClass")] = focus == nullptr ? QString() : QString::fromUtf8(focus->metaObject()->className());
	out[QStringLiteral("focusObjectName")] = focus == nullptr ? QString() : focus->objectName();
	out[QStringLiteral("key")] = key;
	out[QStringLiteral("queued")] = true;

	QPointer<QWindow> pw(w->windowHandle());
	QTimer::singleShot(0, [pw, key, mods, text, holdMs]() {
		if (!pw) return;
		bool shortcut = false;
#if defined(Q_OS_MACOS)
		// **macOS 에서는 단축키를 플랫폼 플러그인이 먼저 본다.** Qt 6 의 processKeyEvent 는 macOS 에서
		// 단축키 맵을 건너뛰고, QNSView::keyDown 이 키를 넘기기 전에 handleShortcutEvent 를 부른다.
		// 그 순서를 그대로 따른다 — 안 그러면 메뉴 단축키(Shift+P 등)가 조용히 무시된다(2026-10-12 실측).
		const ulong ts = static_cast<ulong>(QDateTime::currentMSecsSinceEpoch());
		shortcut = QWindowSystemInterface::handleShortcutEvent(pw, ts, key, mods, 0, 0, 0, text);
#endif
		if (!shortcut) QWindowSystemInterface::handleKeyEvent<QWindowSystemInterface::SynchronousDelivery>(pw, QEvent::KeyPress, key, mods, text);
		const auto up = [pw, key, mods, text]() {
			if (pw) QWindowSystemInterface::handleKeyEvent<QWindowSystemInterface::SynchronousDelivery>(pw, QEvent::KeyRelease, key, mods, text);
		};
		if (holdMs > 0) QTimer::singleShot(holdMs, up);
		else up();
	});
	return replyJson(out);
}
} // namespace zwagent
