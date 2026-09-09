// zwagent — Qt 스타일 플러그인. M4 의 목적은 **이것이 로드되는지 태우는 것**이다.
//
// 왜 스타일 플러그인인가: 앱 프로세스 안에 들어가려면 진입점이 필요하고, Qt 는
// `-style <키>` 로 임의의 DLL 을 불러준다. 대상 앱 소스를 0줄도 고치지 않고
// 프로세스 안에 들어가는 유일한 공식 경로다 (설계문서 §5, 절대 규칙 1).
//
// **이 단계에서 확인하는 것 셋.**
//   ① DLL 이 로드되고 `create("zwagent")` 가 불리는가 — ABI 가 맞는가
//   ② 런타임 Qt 버전이 컴파일 시점과 같은가 — 다르면 나중에 조용히 깨진다
//   ③ **살아 있는 위젯 트리를 볼 수 있는가** — M5 의 핵심 능력이다
//
// ③이 M4 를 "DLL 이 떴다" 이상으로 만든다. 스타일이 만들어지는 시점에는 위젯이
// 아직 없으므로, 이벤트 루프가 돌기 시작한 뒤로 미뤄서 본다.
//
// 결과는 파일로 남긴다. stdout 은 대상 앱이 이미 쓰고 있고, 콘솔 없는 앱에서는
// 사라진다. 파일이면 밖에서 확실히 읽는다.
//   ZWAGENT_HELLO 환경변수 = 쓸 경로. 없으면 %TEMP%/zwagent-hello.json
//
// 빌드: bash tools/zwagent/build.sh

#include <QtGlobal>
#include <QApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProxyStyle>
#include <QSharedPointer>
#include <QStyleFactory>
#include <QStylePlugin>
#include <QTimer>
#include <QWidget>

namespace
{
QString helloPath()
{
	const QString fromEnv = qEnvironmentVariable("ZWAGENT_HELLO");
	if (!fromEnv.isEmpty()) return fromEnv;
	return QDir::temp().filePath(QStringLiteral("zwagent-hello.json"));
}

/// 위젯 하나를 JSON 으로. 깊이 제한을 둬서 큰 앱에서 폭주하지 않게 한다.
QJsonObject describeWidget(const QWidget* w, int depth, int maxDepth, int* budget)
{
	QJsonObject o;
	o[QStringLiteral("class")] = QString::fromUtf8(w->metaObject()->className());
	o[QStringLiteral("objectName")] = w->objectName();
	o[QStringLiteral("visible")] = w->isVisible();
	o[QStringLiteral("enabled")] = w->isEnabled();
	const QRect g = w->geometry();
	o[QStringLiteral("x")] = g.x();
	o[QStringLiteral("y")] = g.y();
	o[QStringLiteral("width")] = g.width();
	o[QStringLiteral("height")] = g.height();

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

/// 보이는 최상위 위젯이 하나라도 있는가.
///
/// **이것만으로는 "UI 가 떴다" 가 아니다.** 대상 앱은 메인 창보다 한참 먼저
/// 540x370 스플래시를 띄우고 30초 넘게 패널을 만든다 (2026-09-09 실측). 첫 폴링에서
/// 이 함수가 true 를 돌려주므로, 여기서 바로 보고하면 **레이아웃도 안 된 스플래시
/// 시절 트리**를 잡는다 — 실제로 그랬다: 위젯이 대부분 `640x480`(Qt 기본 크기)에
/// 숨김 상태였다. Qt 픽스처에는 스플래시가 없어서 이 문제가 드러날 수 없었다.
/// 그래서 아래 countAllWidgets 로 **개수가 멈추는 것**을 함께 본다.
bool haveVisibleUi()
{
	for (const QWidget* w : QApplication::topLevelWidgets())
	{
		if (w->isVisible()) return true;
	}
	return false;
}

/// 위젯 하나와 그 후손의 개수. **깊이·개수 상한이 없다.**
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

/// 프로세스 안의 위젯 총 개수.
///
/// 두 곳에 쓴다. ① JSON 트리가 상한에 잘려도 **몇 개인지는 알 수 있다** — "없다 를
/// 단정할 수 없다" 는 경고가 숫자로 바뀐다. ② 이 값이 멈추는 것이 UI 가 정착했다는
/// 신호다. 클래스 이름을 찾지 않으므로 **대상 앱에 대한 지식이 0이다** (절대 규칙 5).
int countAllWidgets()
{
	int n = 0;
	for (const QWidget* w : QApplication::topLevelWidgets()) n += countWidgets(w);
	return n;
}

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

	if (QCoreApplication::instance() != nullptr)
	{
		root[QStringLiteral("appFilePath")] = QCoreApplication::applicationFilePath();
	}

	QJsonArray tops;
	// 위젯 수·깊이 상한. **실측에서 500·6 이 둘 다 모자랐다** — 대상 앱은 스플래시
	// 시절에도 500 을 넘겼고, dock 안쪽은 6단보다 깊다. 상한은 폭주 방지용이고
	// 정상 규모를 자르는 값이면 안 된다. 잘렸는지는 widgetBudgetLeft 로 알 수 있고,
	// 잘려도 widgetTotal 이 실제 규모를 말해준다.
	int budget = 12000;
	const QWidgetList list = QApplication::topLevelWidgets();
	for (QWidget* w : list)
	{
		if (budget <= 0) break;
		budget--;
		tops.append(describeWidget(w, 0, 40, &budget));
	}
	root[QStringLiteral("topLevelCount")] = list.size();
	root[QStringLiteral("topLevelWidgets")] = tops;
	root[QStringLiteral("widgetBudgetLeft")] = budget;

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
/// 폴링을 완전히 그만두는 시점. **대상 앱은 메인 창까지 35초쯤 걸린다** (실측).
/// 15초였을 때는 스플래시만 보고 끝났다. 영구히 돌리지 않는 이유는 대상 앱에
/// 상시 부하를 남기지 않기 위해서다 — 온디맨드 조회는 M5 의 named pipe 가 한다.
constexpr int kMaxAttempts = 720; // 180초

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
		const bool sawUi = haveVisibleUi();
		const int count = countAllWidgets();

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

		// **화면을 바꾸지 않는다.** 프로브가 대상 앱의 외관을 바꾸면 픽셀 baseline 이
		// 전부 무효가 된다. 구체적인 기본 스타일을 감싼 프록시를 돌려준다 —
		//
		// 대상 앱에서는 이것조차 쓰이지 않는다: zwAppZWeave.cpp:259 가
		// `QApplication::setStyle(new zwStyle)` 로 스타일을 무조건 덮어쓴다. 진입은
		// 되고(Qt 가 초기화 중에 create 를 부른다) 우리 스타일 객체만 버려지므로,
		// 보고를 스타일 객체 수명에 묶지 않은 것이 중요하다 — 타이머는 qApp 소유다.
		// 여기서 우리 키로 QStyleFactory::create 를 부르면 무한 재귀가 된다.
		QStyle* base = QStyleFactory::create(QStringLiteral("windowsvista"));
		if (base == nullptr) base = QStyleFactory::create(QStringLiteral("windows"));
		return new QProxyStyle(base);
	}
};

#include "zwagent.moc"
