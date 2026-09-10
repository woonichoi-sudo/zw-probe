// zwagent — Qt 스타일 플러그인. 대상 앱 프로세스 안의 발판이다.
//
// 왜 스타일 플러그인인가: 앱 프로세스 안에 들어가려면 진입점이 필요하고, Qt 는
// `-style <키>` 로 임의의 DLL 을 불러준다. 대상 앱 소스를 0줄도 고치지 않고
// 프로세스 안에 들어가는 유일한 공식 경로다 (설계문서 §5, 절대 규칙 1).
//
// **밖으로 내보내는 길이 둘이다.**
//   ① hello 파일 — 로드·ABI·정착 시점 위젯 트리. 1회 스냅샷이고 **없으면 안 된다**:
//      파이프가 안 열렸을 때 "로드 실패" 와 구분할 유일한 근거다
//   ② 명령 채널 (server.h) — named pipe. 온디맨드 조회와 조작
//
// 결과를 파일로 남기는 이유: stdout 은 대상 앱이 이미 쓰고 있고 콘솔 없는 앱에서는
// 사라진다. 파일이면 밖에서 확실히 읽는다.
//   ZWAGENT_HELLO 환경변수 = 쓸 경로. 없으면 %TEMP%/zwagent-hello.json
//
// 빌드: bash tools/zwagent/build.sh

#include "server.h"
#include "tree.h"

#include <QtGlobal>
#include <QApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProxyStyle>
#include <QSharedPointer>
#include <QStyleFactory>
#include <QStylePlugin>
#include <QTimer>

namespace
{
QString helloPath()
{
	const QString fromEnv = qEnvironmentVariable("ZWAGENT_HELLO");
	if (!fromEnv.isEmpty()) return fromEnv;
	return QDir::temp().filePath(QStringLiteral("zwagent-hello.json"));
}

/// 명령 채널. qApp 소유라 스타일 객체가 버려져도 산다 — 대상 앱은
/// `QApplication::setStyle(new zwStyle)` 로 우리 스타일을 덮어쓴다.
zwagent::Server* g_server = nullptr;

/// 한 번의 보고에 실을 관찰값. **해석하지 않고 숫자만 넘긴다** (절대 규칙 5).
struct HelloFacts
{
	QString styleKey;
	int attempts = 0;
	bool sawUi = false;
	/// 위젯 총 개수 (상한 없음). JSON 트리가 잘렸는지와 무관하게 규모를 말해준다
	int widgetTotal = 0;
	/// 개수가 멈춘 뒤에 썼는가. false 면 마감에 쫓겨 쓴 것이고 과도 상태일 수 있다
	bool settled = false;
	/// 몇 번째 보고인가. 2 이상이면 앞의 (스플래시 시절) 스냅샷을 덮어썼다는 뜻
	int writeCount = 0;
	/// 스타일이 만들어진 뒤 경과 시간
	qint64 elapsedMs = 0;
};

/// 로드됐다는 사실과 위젯 트리를 파일로 남긴다.
void writeHello(const HelloFacts& facts)
{
	QJsonObject root;
	root[QStringLiteral("loaded")] = true;
	root[QStringLiteral("styleKey")] = facts.styleKey;
	// 몇 번째 시도에 썼는지, 그때 UI 가 실제로 떠 있었는지. 대상 앱은 스타일이
	// 만들어진 뒤에도 한참 뒤에 메인 창이 생기므로 이 둘이 있어야 트리를 믿을 수 있다.
	root[QStringLiteral("attempts")] = facts.attempts;
	root[QStringLiteral("sawUi")] = facts.sawUi;
	root[QStringLiteral("widgetTotal")] = facts.widgetTotal;
	root[QStringLiteral("settled")] = facts.settled;
	root[QStringLiteral("writeCount")] = facts.writeCount;
	root[QStringLiteral("elapsedMs")] = facts.elapsedMs;
	root[QStringLiteral("pid")] = static_cast<qint64>(QCoreApplication::applicationPid());
	// **컴파일 시점과 런타임 Qt 버전을 둘 다 싣는다.** 다르면 ABI 가 어긋난 것이고,
	// 지금은 동작해도 나중에 조용히 깨진다.
	root[QStringLiteral("qtCompiled")] = QStringLiteral(QT_VERSION_STR);
	root[QStringLiteral("qtRuntime")] = QString::fromLatin1(qVersion());
	root[QStringLiteral("writtenAt")] = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);

	// 명령 채널 상태. **파이프 이름을 파일로 알려야 밖에서 찾을 수 있다** — 이름에
	// pid 가 들어가고, 못 열렸으면 그 이유까지 여기서만 보인다.
	if (g_server != nullptr)
	{
		root[QStringLiteral("pipeName")] = g_server->name();
		root[QStringLiteral("pipeListening")] = g_server->listening();
		if (!g_server->lastError().isEmpty())
		{
			root[QStringLiteral("pipeError")] = g_server->lastError();
		}
	}

	if (QCoreApplication::instance() != nullptr)
	{
		root[QStringLiteral("appFilePath")] = QCoreApplication::applicationFilePath();
	}

	zwagent::putTopLevelWidgets(root, zwagent::kDefaultBudget, zwagent::kDefaultMaxDepth);

	const QString path = helloPath();
	// 상위 폴더를 만들어 둔다. `ZWAGENT_HELLO` 로 `runs/…` 같은 경로를 받는 것이
	// 자연스러운데 그 폴더는 커밋되지 않아 없을 수 있다. 없어서 못 쓰면 밖에서는
	// **"로드 실패" 와 구분되지 않는다** — 원인이 전혀 다른데도 같아 보인다.
	QDir().mkpath(QFileInfo(path).absolutePath());

	QFile f(path);
	if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
	{
		// 여기서 실패하면 밖에서 알 방법이 없다. 앱을 죽이지는 않는다 —
		// 프로브가 대상 앱을 망가뜨리는 것이 가장 나쁘다.
		qWarning("zwagent: %s 를 쓸 수 없다", qUtf8Printable(path));
		return;
	}
	f.write(QJsonDocument(root).toJson(QJsonDocument::Indented));
	f.close();
}

constexpr int kPollIntervalMs = 250;
/// 개수가 이만큼 연속으로 안 바뀌면 정착으로 본다 (12 × 250ms = 3초).
constexpr int kSettleTicks = 12;
/// 폴링을 완전히 그만두는 시점. **대상 앱은 메인 창까지 90초쯤 걸린다** (실측).
/// 15초였을 때는 스플래시만 보고 끝났다. 영구히 돌리지 않는 이유는 대상 앱에
/// 상시 부하를 남기지 않기 위해서다 — 온디맨드 조회는 명령 채널이 한다.
///
/// **틱 수이지 초가 아니다.** 이벤트 루프가 바쁘면 타이머가 밀리므로 실시간은 더
/// 길어진다 — 2026-09-10 에 프로젝트를 여는 동안 720틱이 308초 걸렸다. 앱이 바쁠수록
/// 더 오래 지켜보는 셈이라 여기서는 그것이 옳다(그 덕에 문서를 연 뒤의 트리로 스스로
/// 갱신됐다). 다만 "180초" 로 읽으면 안 된다.
constexpr int kMaxAttempts = 720; // 250ms × 720틱. 한가하면 180초, 바쁘면 더

/// 폴링 사이에 들고 가는 상태.
struct PollState
{
	QString styleKey;
	int attempts = 0;
	int lastCount = -1;
	int stableTicks = 0;
	int writtenCount = -1;
	int writeCount = 0;
	QElapsedTimer clock;
};

/**
 * UI 가 **정착할 때까지** 기다렸다가 보고한다.
 *
 * **한 번만 보면 안 되고, 보이자마자 봐도 안 된다.** 스타일은 QApplication 초기화
 * 중에 만들어지고, 대상 앱은 그 뒤에도 메인 창이 생기기 전까지 이벤트 루프를 여러 번
 * 돌린다 (`zwAppZWeave.cpp:234` 주석). 게다가 그 사이에 **스플래시 창이 떠 있다** —
 * "보이는 위젯이 있다" 는 첫 폴링부터 참이 되므로 그것만으로 보고하면 진다.
 *
 * 그래서 기준을 **위젯 개수가 멈추는 것**으로 바꿨다. 개수가 3초간 안 변하고 보이는
 * 창이 있으면 그 시점을 하나의 정착 상태로 보고 쓴다. **정착이 또 오면 덮어쓴다** —
 * 스플래시 시절에 한 번 쓰더라도 메인 창이 뜨면 스스로 교정된다. 마지막 쓰기가 답이다.
 *
 * 마감까지 한 번도 못 썼으면 그때 그대로 쓴다 — **못 봤다는 사실도 보고해야 한다.**
 * 아무 파일도 안 쓰면 밖에서는 "로드 실패" 와 구분되지 않는다. 이미 정착본을 썼으면
 * 마감에서 덮어쓰지 않는다 (과도 상태로 좋은 스냅샷을 망치지 않는다).
 *
 * 개수를 세는 것뿐이므로 대상 앱의 클래스 이름을 하나도 모른다 (절대 규칙 5).
 */
void scheduleHello(const QString& styleKey)
{
	auto* timer = new QTimer(QCoreApplication::instance());
	auto state = QSharedPointer<PollState>::create();
	state->styleKey = styleKey;
	state->clock.start();

	timer->setInterval(kPollIntervalMs);
	QObject::connect(timer, &QTimer::timeout, timer, [timer, state]() {
		state->attempts++;
		const bool sawUi = zwagent::haveVisibleUi();
		const int count = zwagent::countAllWidgets();

		if (count != state->lastCount)
		{
			state->lastCount = count;
			state->stableTicks = 0;
		}
		else
		{
			state->stableTicks++;
		}

		const bool deadline = state->attempts >= kMaxAttempts;
		// 같은 개수로 두 번 쓰지 않는다 — 정착이 유지되는 동안 매번 쓰면 낭비다
		const bool settled = sawUi && state->stableTicks >= kSettleTicks && count != state->writtenCount;

		if (settled || (deadline && state->writeCount == 0))
		{
			state->writeCount++;
			state->writtenCount = count;
			HelloFacts facts;
			facts.styleKey = state->styleKey;
			facts.attempts = state->attempts;
			facts.sawUi = sawUi;
			facts.widgetTotal = count;
			facts.settled = settled;
			facts.writeCount = state->writeCount;
			facts.elapsedMs = state->clock.elapsed();
			writeHello(facts);
		}

		if (deadline)
		{
			timer->stop();
			timer->deleteLater();
		}
	});
	timer->start();
}

/// 명령 채널을 연다. **실패해도 앱을 죽이지 않는다** — 실패 사실은 hello 에 실린다.
void startServer()
{
	if (g_server != nullptr) return;
	g_server = new zwagent::Server(QCoreApplication::instance());
	if (!g_server->listen())
	{
		qWarning("zwagent: 파이프를 열지 못했다: %s", qUtf8Printable(g_server->lastError()));
	}
}
} // namespace

class ZwAgentStylePlugin : public QStylePlugin
{
	Q_OBJECT
	Q_PLUGIN_METADATA(IID QStyleFactoryInterface_iid FILE "zwagent.json")

public:
	QStyle* create(const QString& key) override
	{
		if (key.compare(QStringLiteral("zwagent"), Qt::CaseInsensitive) != 0)
		{
			return nullptr;
		}

		// 위젯 트리는 지금 없다 — 스타일은 QApplication 초기화 중에 만들어진다.
		// UI 가 뜰 때까지 기다렸다가 본다. 근거는 scheduleHello 주석.
		scheduleHello(key);
		startServer();

		// **화면을 바꾸지 않는다.** 프로브가 대상 앱의 외관을 바꾸면 픽셀 baseline 이
		// 전부 무효가 된다. 구체적인 기본 스타일을 감싼 프록시를 돌려준다 —
		//
		// 대상 앱에서는 이것조차 쓰이지 않는다: zwAppZWeave.cpp:259 가
		// `QApplication::setStyle(new zwStyle)` 로 스타일을 무조건 덮어쓴다. 진입은
		// 되고(Qt 가 초기화 중에 create 를 부른다) 우리 스타일 객체만 버려지므로,
		// 보고를 스타일 객체 수명에 묶지 않은 것이 중요하다 — 타이머와 서버는 qApp 소유다.
		// 여기서 우리 키로 QStyleFactory::create 를 부르면 무한 재귀가 된다.
		QStyle* base = QStyleFactory::create(QStringLiteral("windowsvista"));
		if (base == nullptr) base = QStyleFactory::create(QStringLiteral("windows"));
		return new QProxyStyle(base);
	}
};

#include "zwagent.moc"
