# zwagent — Qt 스타일 플러그인. **디버그 구성으로 빌드한다.**
# 대상 앱이 Qt5Cored.dll 을 쓰고, Windows 에서 디버그/릴리스 CRT 는 섞이지 않는다.
# Qt 는 플러그인 메타데이터의 디버그 플래그가 안 맞으면 로드를 건너뛴다.

# network 는 명령 채널(QLocalServer = Windows named pipe) 때문이다. 대상 앱 배포
# 폴더에 Qt5Networkd.dll 이 이미 있어서 새 의존성이 생기지 않는다 (2026-09-09 확인).
QT += widgets network
# gui-private 는 mouse op 의 QWindowSystemInterface 때문이다 — 플랫폼 플러그인이 OS 입력을
# 넘기는 바로 그 입구라 전역 버튼·수정키 상태까지 실제 입력과 같게 바뀐다. 헤더만 쓰고
# 심볼은 이미 있는 Qt5Guid.dll 에서 온다.
QT += gui-private
TEMPLATE = lib
CONFIG += plugin debug c++17
TARGET = zwagent

# Qt 는 `<QT_PLUGIN_PATH의 한 경로>/styles/` 에서 스타일 플러그인을 찾는다.
# 대상 앱 리포 안(Qt 의 plugins/styles)에 두지 않는다 — 절대 규칙 2.
DESTDIR = $$PWD/../../bin/plugins/styles
OBJECTS_DIR = $$PWD/../../build/zwagent
MOC_DIR = $$PWD/../../build/zwagent

# 한국어 주석이 UTF-8 이다. 없으면 MSVC 가 코드 페이지 949 로 읽어 C4819 를 낸다.
win32: QMAKE_CXXFLAGS += /utf-8

# **macOS (Qt 6.5.3, 2026-10-12).** 대상 앱 디버그 빌드는 프레임워크의 `_debug` 변형
# (`QtCore.framework/.../QtCore_debug`)에 링크돼 있다. qmake 는 프레임워크에 그 접미사를
# 안 붙이므로 그냥 두면 릴리스 QtCore 를 함께 로드해 **QtCore 가 두 벌이 된다.** 링크 뒤에
# 의존 이름을 `_debug` 로 바꾼다. 경로는 앱과 같은 `@rpath` 라 앱의 Qt 를 그대로 쓴다.
#
# **파일 이름도 `_debug` 로 끝나야 한다.** 디버그 Qt 의 플러그인 로더는 macOS 에서 이름이
# `_debug.dylib` 가 아닌 플러그인을 **보지도 않고 건너뛴다** — `QT_DEBUG_PLUGINS=1` 에도
# "checking directory" 만 찍히고 파일 이름이 안 나온다 (2026-10-12 실측).
macx {
	TARGET = zwagent_debug
	OBJECTS_DIR = $$PWD/../../build/zwagent-mac/obj
	MOC_DIR = $$PWD/../../build/zwagent-mac/obj
	for(m, $$list(Core Gui Widgets Network)) {
		QMAKE_POST_LINK += install_name_tool -change \
			@rpath/Qt$${m}.framework/Versions/A/Qt$${m} \
			@rpath/Qt$${m}.framework/Versions/A/Qt$${m}_debug $(DESTDIR)$(TARGET) ;
	}
}

HEADERS += actions.h server.h tree.h
SOURCES += zwagent.cpp actions.cpp server.cpp tree.cpp windows.cpp
DISTFILES += zwagent.json
