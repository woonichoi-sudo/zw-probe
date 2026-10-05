// zwprobe 용 최소 Qt 픽스처 앱. Z-Weave 없이 초 단위로 반복하기 위한 것이다.
//
// **왜 필요한가.** `zwagent.dll`(Qt 스타일 플러그인) 개발 중에 Z-Weave 를 띄우지
// 않는다 — 앱 로딩·로그인·샘플이 전부 불필요하다(CLAUDE.md "테스트 방식").
// WinForms 픽스처는 캡처·클릭·창 구조를 검증하지만 **Qt 의 동작은 재현하지 못한다.**
//
// 이 앱이 답해야 하는 것 셋.
//   ① 스타일 플러그인이 로드되는가 (`-style zwagent`) — M4 의 본질
//   ② Qt 의 모달 다이얼로그가 소유자 창을 Win32 수준에서 비활성화하는가
//      — CLAUDE.md 열린 항목. WinForms 는 EnableWindow(FALSE) 를 걸지만 Qt 는
//      자체 이벤트 루프로 처리할 수도 있고, Qt 소스가 없어 읽어서 확인할 수 없다
//   ③ Qt 위젯이 UIA 에 어떻게 나오는가 (objectName → AutomationId)
//
// 위젯에 objectName 을 붙이는 이유는 대상 앱과 같은 조건을 만들기 위해서다 —
// Z-Weave 도 `setObjectName` 으로 붙인 이름이 UIA AutomationId 경로로 나온다.
//
// 빌드: bash fixtures/qtapp/build.sh

#include <QAction>
#include <QApplication>
#include <QDialog>
#include <QGuiApplication>
#include <QMouseEvent>
#include <QGridLayout>
#include <QLabel>
#include <QMainWindow>
#include <QMenu>
#include <QMenuBar>
#include <QProgressBar>
#include <QPushButton>
#include <QVBoxLayout>
#include <QWidget>

namespace
{
// 캡처 검증용 사분면 색. WinForms 픽스처와 같은 배치로 두어 같은 판정을 쓸 수 있다.
// 팔레트로 칠한다 — 스타일시트는 스타일 플러그인에 영향을 받을 수 있고,
// 여기서는 **플러그인과 무관하게 고정된 픽셀**이 필요하다.
QLabel* colorCell(const QString& name, const QColor& c, QWidget* parent)
{
	// **부모를 반드시 준다.** 부모 없는 QWidget 은 최상위 위젯이 되어
	// `QApplication::topLevelWidgets()` 에 끼어든다 — 아직 화면에 없는 위젯이
	// 최상위로 세어져 창 구조 판정을 흐린다 (2026-09-09 실측: topLevelCount 가 2).
	auto* cell = new QLabel(parent);
	cell->setObjectName(name);
	cell->setAutoFillBackground(true);
	// 네 칸이 다 자랄 수 있어야 사분면이 균등해진다. 아래 fixtureTarget 주석 참고.
	cell->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
	QPalette p = cell->palette();
	p.setColor(QPalette::Window, c);
	cell->setPalette(p);
	return cell;
}

/// 다이얼로그를 하나 만든다. 모달 여부는 호출자가 정한다.
QDialog* makeDialog(QWidget* parent, bool modal)
{
	auto* d = new QDialog(parent);
	d->setObjectName(modal ? "zwqtfixtureModalDialog" : "zwqtfixtureModelessDialog");
	d->setWindowTitle(modal ? "zwqtfixture-modal" : "zwqtfixture-modeless");
	d->setFixedSize(240, 100);
	d->setModal(modal);

	auto* layout = new QVBoxLayout(d);
	auto* text = new QLabel(modal ? "modal" : "modeless", d);
	text->setObjectName("dialogText");
	layout->addWidget(text);

	// 진행 다이얼로그를 닮게 둔다. 진행 다이얼로그와 입력 대기 다이얼로그를
	// 외부에서 구분할 근거를 찾는 것이 M3 에서 남은 문제다.
	auto* bar = new QProgressBar(d);
	bar->setObjectName("dialogProgress");
	bar->setRange(0, 100);
	bar->setValue(42);
	layout->addWidget(bar);

	return d;
}

/**
 * `--mousepad` 모드의 중앙 위젯 — **받은 마우스 이벤트를 라벨에 적는다.**
 *
 * zwagent 의 `mouse` op 을 대상 앱 없이 검증하기 위한 것이다. 한 줄에 이벤트 하나:
 *   `press 10,20 b=L bs=L m=S kb=S`
 *   b  = 이 이벤트의 버튼(button())   bs = 눌린 버튼 전체(buttons())
 *   m  = 이벤트의 수정키(modifiers()) kb = **그 순간의 전역 수정키**
 *        (QGuiApplication::keyboardModifiers()). 대상 앱의 스냅·사각형 도구가 이것을
 *        읽으므로 이벤트에만 실린 수정키로는 부족하다 — 둘 다 맞아야 실제 입력과 같다.
 * 라벨은 마우스를 받지 않게 둔다 — 받으면 라벨 영역의 이벤트가 라벨 좌표로 바뀐다.
 */
QString buttonLetters(Qt::MouseButtons b)
{
	QString s;
	if (b & Qt::LeftButton) s += 'L';
	if (b & Qt::MiddleButton) s += 'M';
	if (b & Qt::RightButton) s += 'R';
	return s.isEmpty() ? QStringLiteral("-") : s;
}

QString modifierLetters(Qt::KeyboardModifiers m)
{
	QString s;
	if (m & Qt::ShiftModifier) s += 'S';
	if (m & Qt::ControlModifier) s += 'C';
	if (m & Qt::AltModifier) s += 'A';
	return s.isEmpty() ? QStringLiteral("-") : s;
}

class MousePad : public QWidget
{
public:
	explicit MousePad(QWidget* parent) : QWidget(parent)
	{
		setObjectName("mousePad");
		setMouseTracking(true);
		m_log = new QLabel(this);
		m_log->setObjectName("mouseLog");
		m_log->setAttribute(Qt::WA_TransparentForMouseEvents);
		m_log->setGeometry(0, 0, 10, 10);
	}

protected:
	void mousePressEvent(QMouseEvent* e) override { note("press", e); }
	void mouseMoveEvent(QMouseEvent* e) override { note("move", e); }
	void mouseReleaseEvent(QMouseEvent* e) override { note("release", e); }

private:
	void note(const char* kind, QMouseEvent* e)
	{
		m_lines << QStringLiteral("%1 %2,%3 b=%4 bs=%5 m=%6 kb=%7")
		               .arg(QLatin1String(kind))
		               .arg(e->x())
		               .arg(e->y())
		               .arg(buttonLetters(e->button()))
		               .arg(buttonLetters(e->buttons()))
		               .arg(modifierLetters(e->modifiers()))
		               .arg(modifierLetters(QGuiApplication::keyboardModifiers()));
		m_log->setText(m_lines.join('\n'));
	}

	QLabel* m_log = nullptr;
	QStringList m_lines;
};
} // namespace

int main(int argc, char** argv)
{
	QApplication app(argc, argv);

	bool wantModal = false;
	bool wantModeless = false;
	bool wantMousePad = false;
	for (int i = 1; i < argc; i++)
	{
		const QString a = QString::fromLocal8Bit(argv[i]);
		if (a == "--modal") wantModal = true;
		if (a == "--modeless") wantModeless = true;
		if (a == "--mousepad") wantMousePad = true;
	}

	QMainWindow window;
	window.setObjectName("zwqtfixtureMainWindow");
	window.setWindowTitle("zwqtfixture");
	window.resize(400, 300);

	auto* central = new QWidget(&window);
	central->setObjectName("centralArea");
	auto* grid = new QGridLayout(central);
	grid->setContentsMargins(0, 0, 0, 0);
	grid->setSpacing(0);
	grid->addWidget(colorCell("cellTopLeft", QColor(255, 0, 0), central), 0, 0);
	grid->addWidget(colorCell("cellTopRight", QColor(0, 255, 0), central), 0, 1);
	grid->addWidget(colorCell("cellBottomLeft", QColor(0, 0, 255), central), 1, 0);

	// 이름으로 찾아 누르는 경로(zwprobe click --name)를 검증할 버튼.
	// 눌리면 오른쪽 아래가 검게 바뀌므로 화면으로 확인된다.
	auto* target = new QPushButton("fixture-target", central);
	target->setObjectName("fixtureTarget");
	// **QPushButton 의 수직 정책이 Fixed 라 그 행이 자라지 못한다.** 그대로 두면
	// 행 높이가 277/23 으로 갈린다 (2026-09-09 실측). `setRowStretch` 로는 안 고쳐진다 —
	// stretch 는 **자랄 수 있는 항목끼리** 남는 공간을 나누는 것이고, Fixed 항목이
	// 유일한 행은 애초에 대상이 아니다. 정책을 바꿔야 사분면이 반씩 나뉜다.
	target->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
	grid->addWidget(target, 1, 1);

	auto* black = colorCell("cellBottomRight", QColor(0, 0, 0), central);
	black->hide();
	QObject::connect(target, &QPushButton::clicked, [&, black, target]() {
		grid->replaceWidget(target, black);
		target->hide();
		black->show();
	});

	// 메뉴 — `zwagent` 의 `QAction::trigger()` 를 대상 앱 없이 검증하기 위한 것.
	//
	// **대상 앱의 메뉴 모양을 흉내낸다.** 실앱은 File 안에 Recent files 서브메뉴가
	// 있고, 서로 다른 메뉴에 **같은 이름의 항목**이 있다(Import 와 Export 둘 다 OBJ).
	// 그 두 가지가 여기서 검증할 것이다 — 경로로 좁히는 것과, 이름이 겹칠 때
	// 조용히 첫 번째를 고르지 않는 것.
	auto* fileMenu = window.menuBar()->addMenu("Fixture");
	auto* markAction = fileMenu->addAction("Mark");
	markAction->setObjectName("actionMark");
	QObject::connect(markAction, &QAction::triggered, [&, black, target]() {
		// 버튼을 누른 것과 같은 결과를 낸다 — 화면으로 확인된다.
		if (!black->isVisible())
		{
			grid->replaceWidget(target, black);
			target->hide();
			black->show();
		}
	});

	// **켜고 끄는 항목.** `setAction` 을 검증하려면 이것이 필요하다 — 대상 앱의
	// `Window > UI panels > *` 가 이 모양이고, **무턱대고 trigger 하면 원하는 상태에서
	// 벗어난다.** 켜면 왼쪽 위가 노랗게 바뀌므로 화면으로도 확인된다.
	auto* toggle = fileMenu->addAction("Highlight");
	toggle->setObjectName("actionHighlight");
	toggle->setCheckable(true);
	auto* topLeft = central->findChild<QLabel*>("cellTopLeft");
	QObject::connect(toggle, &QAction::toggled, [topLeft](bool on) {
		if (topLeft == nullptr) return;
		QPalette p = topLeft->palette();
		p.setColor(QPalette::Window, on ? QColor(255, 255, 0) : QColor(255, 0, 0));
		topLeft->setPalette(p);
	});

	auto* recent = fileMenu->addMenu("Recent");
	recent->addAction("Ambiguous");
	// 같은 이름을 다른 메뉴에도 둔다. **경로 없이 이름만으로는 갈리지 않아야 한다.**
	auto* other = window.menuBar()->addMenu("Other");
	other->addAction("Ambiguous");

	auto* disabled = other->addAction("Disabled");
	disabled->setEnabled(false);

	if (wantMousePad)
	{
		// 사분면 대신 마우스 받는 판 하나. 사분면 시험(캡처·grab)과 섞지 않으려고 따로 둔다.
		central->hide();
		window.setCentralWidget(new MousePad(&window));
	}
	else
	{
		window.setCentralWidget(central);
	}
	window.show();

	if (wantModal || wantModeless)
	{
		QDialog* d = makeDialog(&window, wantModal);
		if (wantModal)
		{
			// exec() 는 자체 이벤트 루프를 돌린다. show() 뒤에 부르므로 메인 창은
			// 이미 떠 있고, 외부에서 두 창을 함께 관찰할 수 있다.
			d->exec();
			return 0;
		}
		d->show();
	}

	return app.exec();
}
