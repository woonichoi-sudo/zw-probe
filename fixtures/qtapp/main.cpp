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

#include <QApplication>
#include <QDialog>
#include <QGridLayout>
#include <QLabel>
#include <QMainWindow>
#include <QProgressBar>
#include <QPushButton>
#include <QVBoxLayout>
#include <QWidget>

namespace
{
// 캡처 검증용 사분면 색. WinForms 픽스처와 같은 배치로 두어 같은 판정을 쓸 수 있다.
// 팔레트로 칠한다 — 스타일시트는 스타일 플러그인에 영향을 받을 수 있고,
// 여기서는 **플러그인과 무관하게 고정된 픽셀**이 필요하다.
QLabel* colorCell(const QString& name, const QColor& c)
{
	auto* cell = new QLabel();
	cell->setObjectName(name);
	cell->setAutoFillBackground(true);
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
} // namespace

int main(int argc, char** argv)
{
	QApplication app(argc, argv);

	bool wantModal = false;
	bool wantModeless = false;
	for (int i = 1; i < argc; i++)
	{
		const QString a = QString::fromLocal8Bit(argv[i]);
		if (a == "--modal") wantModal = true;
		if (a == "--modeless") wantModeless = true;
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
	// 사분면을 정확히 반씩 나눈다. QLabel 은 크기 힌트가 없고 QPushButton 은 있어서
	// 그대로 두면 행 높이가 277/23 으로 갈린다 (2026-09-09 실측). 픽셀 판정을
	// 사분면 중심으로 하려면 균등해야 한다.
	grid->setRowStretch(0, 1);
	grid->setRowStretch(1, 1);
	grid->setColumnStretch(0, 1);
	grid->setColumnStretch(1, 1);
	grid->addWidget(colorCell("cellTopLeft", QColor(255, 0, 0)), 0, 0);
	grid->addWidget(colorCell("cellTopRight", QColor(0, 255, 0)), 0, 1);
	grid->addWidget(colorCell("cellBottomLeft", QColor(0, 0, 255)), 1, 0);

	// 이름으로 찾아 누르는 경로(zwprobe click --name)를 검증할 버튼.
	// 눌리면 오른쪽 아래가 검게 바뀌므로 화면으로 확인된다.
	auto* target = new QPushButton("fixture-target");
	target->setObjectName("fixtureTarget");
	grid->addWidget(target, 1, 1);

	auto* black = colorCell("cellBottomRight", QColor(0, 0, 0));
	QObject::connect(target, &QPushButton::clicked, [&, black, target]() {
		grid->replaceWidget(target, black);
		target->hide();
		black->show();
	});

	window.setCentralWidget(central);
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
