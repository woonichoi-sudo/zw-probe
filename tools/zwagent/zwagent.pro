# zwagent — Qt 스타일 플러그인. **디버그 구성으로 빌드한다.**
# 대상 앱이 Qt5Cored.dll 을 쓰고, Windows 에서 디버그/릴리스 CRT 는 섞이지 않는다.
# Qt 는 플러그인 메타데이터의 디버그 플래그가 안 맞으면 로드를 건너뛴다.

QT += widgets
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

SOURCES += zwagent.cpp
DISTFILES += zwagent.json
