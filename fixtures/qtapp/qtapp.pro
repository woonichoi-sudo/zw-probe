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
QMAKE_CXXFLAGS += /utf-8

SOURCES += main.cpp
