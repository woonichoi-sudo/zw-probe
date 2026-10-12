# 최소 Qt 픽스처 앱. **디버그 구성으로 빌드한다** — 대상 앱이 Qt5Cored.dll 을 쓰므로
# 플러그인도 디버그여야 하고, 픽스처도 같은 구성이어야 플러그인을 얹을 수 있다.

QT += widgets
TEMPLATE = app
TARGET = zwqtfixture
CONFIG += debug console c++17
CONFIG -= app_bundle

# 산출물은 이 리포의 bin/ 에 모은다. 중간 파일은 build/ 로 빼서 소스와 섞지 않는다.
DESTDIR = $$PWD/../../bin
OBJECTS_DIR = $$PWD/../../build/qtapp
MOC_DIR = $$PWD/../../build/qtapp
RCC_DIR = $$PWD/../../build/qtapp
UI_DIR = $$PWD/../../build/qtapp

# 한국어 주석이 UTF-8 이므로 명시한다. 없으면 MSVC 가 코드 페이지 949 로 읽어
# C4819 경고를 낸다 (2026-09-09 실측).
win32: QMAKE_CXXFLAGS += /utf-8

# **macOS (Qt 6.5.3, 2026-10-12).** zwagent 와 같은 디버그 Qt(`_debug` 프레임워크)를 써야 한 프로세스에
# QtCore 가 두 벌 안 뜬다. 링크 뒤 의존 이름을 `_debug` 로 바꾼다(tools/zwagent/zwagent.pro 와 같은 이유).
macx {
	OBJECTS_DIR = $$PWD/../../build/qtapp-mac
	MOC_DIR = $$PWD/../../build/qtapp-mac
	for(m, $$list(Core Gui Widgets)) {
		QMAKE_POST_LINK += install_name_tool -change \
			@rpath/Qt$${m}.framework/Versions/A/Qt$${m} \
			@rpath/Qt$${m}.framework/Versions/A/Qt$${m}_debug $(TARGET) ;
	}
}

SOURCES += main.cpp
