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

namespace
{
/// 응답 봉투. **성공과 실패가 같은 모양이어야** 밖에서 한 번에 읽는다.
QByteArray reply(const QJsonObject& body)
{
	// Compact 로 쓴다 — 실앱 트리가 6MB 이고 들여쓰기가 그걸 더 키운다.
	return QJsonDocument(body).toJson(QJsonDocument::Compact);
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

	if (op == QStringLiteral("grab"))
	{
		return handleGrab(req, id, out);
	}

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

	const QImage img = w->grab().toImage().convertToFormat(QImage::Format_ARGB32);
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
