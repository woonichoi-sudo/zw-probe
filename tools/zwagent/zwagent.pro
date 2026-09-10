# zwagent — Qt 스타일 플러그인. **디버그 구성으로 빌드한다.**
# 대상 앱이 Qt5Cored.dll 을 쓰고, Windows 에서 디버그/릴리스 CRT 는 섞이지 않는다.
# Qt 는 플러그인 메타데이터의 디버그 플래그가 안 맞으면 로드를 건너뛴다.

# network 는 명령 채널(QLocalServer = Windows named pipe) 때문이다. 대상 앱 배포
# 폴더에 Qt5Networkd.dll 이 이미 있어서 새 의존성이 생기지 않는다 (2026-09-09 확인).
QT += widgets network
TEMPLATE = lib
CONFIG += plugin debug c++17
TARGET = zwagent

# Qt 는 `<QT_PLUGIN_PATH의 한 경로>/styles/` 에서 스타일 플러그인을 찾는다.
# 대상 앱 리포 안(Qt 의 plugins/styles)에 두지 않는다 — 절대 규칙 2.
DESTDIR = $$PWD/../../bin/plugins/styles
OBJECTS_DIR = $$PWD/../../build/zwagent
MOC_DIR = $$PWD/../../build/zwagent

# 한국어 주석이 UTF-8 이다. 없으면 MSVC 가 코드 페이지 949 로 읽어 C4819 를 낸다.
QMAKE_CXXFLAGS += /utf-8

HEADERS += server.h tree.h
SOURCES += zwagent.cpp server.cpp tree.cpp
DISTFILES += zwagent.json
