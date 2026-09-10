#include "server.h"

#include "tree.h"

#include <QCoreApplication>
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

	return fail(id, QStringLiteral("모르는 op: \"%1\"").arg(op));
}
} // namespace zwagent
