// zwagent 의 명령 채널. Windows 에서 `QLocalServer` 는 named pipe 다.
//
// **왜 필요한가.** hello 파일은 UI 가 정착한 순간의 스냅샷 하나뿐이라 그 뒤에 사람이
// 탭을 바꾸면 낡는다. 그리고 읽기만 한다 — `QAction::trigger()` 같은 조작을 밖에서
// 시킬 길이 없다.
//
// **왜 QLocalServer 인가.** Win32 named pipe 를 직접 다루면 overlapped I/O 와 스레드가
// 붙는데, 조작은 **GUI 스레드에서 해야 한다** (Qt 위젯 규칙). QLocalServer 는 이벤트
// 루프에 얹히므로 콜백이 그대로 GUI 스레드다. 대상 앱 배포 폴더에 `Qt5Networkd.dll` 이
// 이미 있어서 의존성도 새로 안 생긴다 (2026-09-09 확인).
//
// **파이프 이름에 pid 를 넣는다.** 고정 이름이면 테스트가 픽스처를 병렬로 띄울 때
// 서로의 파이프를 잡는다 — `node --test` 가 파일을 병렬로 돌린다는 것을 이미 한 번
// 겪었다. pid 는 유일하고, 밖에서는 hello 파일이 pid 를 알려준다.
//
// **여기도 판정하지 않는다** (절대 규칙 5). 요청을 받아 사실을 JSON 으로 돌려줄 뿐이다.

#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QString>

class QLocalServer;
class QLocalSocket;

namespace zwagent
{
/// 이 프로세스의 파이프 이름. 밖에서는 `\\.\pipe\<이 값>` 으로 연다.
QString pipeNameFor(qint64 pid);

class Server : public QObject
{
	Q_OBJECT

public:
	explicit Server(QObject* parent = nullptr);

	/// 듣기 시작한다. 실패해도 앱을 죽이지 않는다 — 프로브가 대상 앱을 망가뜨리는 것이
	/// 가장 나쁘다. 실패는 `lastError()` 로 남기고 hello 파일에 실린다.
	bool listen();

	QString name() const { return m_name; }
	QString lastError() const { return m_lastError; }
	bool listening() const;

private:
	void onNewConnection();
	void onReadyRead(QLocalSocket* sock);
	/// 요청 한 줄 → 응답 한 줄. 줄바꿈은 붙이지 않는다.
	QByteArray handle(const QByteArray& line);
	/// 유일하게 대상 앱을 바꾸는 곳. 근거는 server.cpp 의 주석.
	QByteArray handleTrigger(const QJsonObject& req, const QJsonValue& id, QJsonObject& out);
	/// 위젯 하나를 파일로 찍는다. 근거는 server.cpp 의 주석.
	QByteArray handleGrab(const QJsonObject& req, const QJsonValue& id, QJsonObject& out);
	/// 위젯 하나에 마우스 이벤트를 차례로 넣는다. 근거는 server.cpp 의 주석.
	QByteArray handleMouse(const QJsonObject& req, const QJsonValue& id, QJsonObject& out);
	/// 위젯 하나에 키 누름·뗌을 보낸다. 근거는 server.cpp 의 주석.
	QByteArray handleKey(const QJsonObject& req, const QJsonValue& id, QJsonObject& out);

	QLocalServer* m_server = nullptr;
	QString m_name;
	QString m_lastError;
};
} // namespace zwagent
