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
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProxyStyle>
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

/// 보이는 최상위 위젯이 하나라도 있는가. UI 가 실제로 떴는지의 기준이다.
bool haveVisibleUi()
{
	for (const QWidget* w : QApplication::topLevelWidgets())
	{
		if (w->isVisible()) return true;
	}
	return false;
}

/// 로드됐다는 사실과 위젯 트리를 파일로 남긴다.
void writeHello(const QString& styleKey, int attempts, bool sawUi)
{
	QJsonObject root;
	root[QStringLiteral("loaded")] = true;
	root[QStringLiteral("styleKey")] = styleKey;
	// 몇 번째 시도에 썼는지, 그때 UI 가 실제로 떠 있었는지. 대상 앱은 스타일이
	// 만들어진 뒤에도 한참 뒤에 메인 창이 생기므로 이 둘이 있어야 트리를 믿을 수 있다.
	root[QStringLiteral("attempts")] = attempts;
	root[QStringLiteral("sawUi")] = sawUi;
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
	int budget = 500; // 위젯 수 상한. 대상 앱은 트리가 크다
	const QWidgetList list = QApplication::topLevelWidgets();
	for (QWidget* w : list)
	{
		if (budget <= 0) break;
		budget--;
		tops.append(describeWidget(w, 0, 6, &budget));
	}
	root[QStringLiteral("topLevelCount")] = list.size();
	root[QStringLiteral("topLevelWidgets")] = tops;
	root[QStringLiteral("widgetBudgetLeft")] = budget;

	const QString path = helloPath();
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

/// 최대 시도 횟수 × 간격 = 기다리는 시간. 대상 앱은 시작이 느리다.
constexpr int kPollIntervalMs = 250;
constexpr int kMaxAttempts = 60; // 15초

/**
 * UI 가 뜰 때까지 기다렸다가 보고한다.
 *
 * **한 번만 보면 안 된다.** 스타일은 QApplication 초기화 중에 만들어지고, 대상 앱은
 * 그 뒤에도 메인 창이 생기기 전까지 이벤트 루프를 여러 번 돌린다
 * (`zwAppZWeave.cpp:234` 주석이 그 사실을 말한다). 0ms 단발로 보면 빈 트리를 잡는다.
 *
 * 보이는 최상위 위젯이 생기면 즉시, 안 생기면 상한에서 그대로 보고한다 — **못 봤다는
 * 사실도 보고해야 한다.** 아무 파일도 안 쓰면 밖에서는 "로드 실패" 와 구분되지 않는다.
 */
void scheduleHello(const QString& styleKey)
{
	auto* timer = new QTimer(QCoreApplication::instance());
	timer->setInterval(kPollIntervalMs);
	QObject::connect(timer, &QTimer::timeout, timer, [timer, styleKey, attempts = 0]() mutable {
		attempts++;
		const bool sawUi = haveVisibleUi();
		if (!sawUi && attempts < kMaxAttempts) return;
		writeHello(styleKey, attempts, sawUi);
		timer->stop();
		timer->deleteLater();
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
