// 가상 커서 — 실제 커서·포그라운드를 건드리지 않고 대상 창에 입력을 넣는다 (2026-11-15).
//
// 사용 (좌표는 shot 캡처 픽셀, 창 왼쪽 위 기준. 창 필터 --process/--pid/--title 은 다른 동사와 같다):
//   zwwin.exe vclick --x N --y N [--button left|right|middle] [--double] [--hold ms] [--ctrl] [--shift] [--alt]
//   zwwin.exe vdrag  --x N --y N --to-x N --to-y N [--steps 10] [--button ...] [--ctrl] [--shift] [--alt]
//   zwwin.exe vwheel --x N --y N --delta N(120 = 한 칸 위, 음수 아래) [--ctrl] [--shift] [--alt]
//   zwwin.exe vkey   --vk N [--ctrl] [--shift] [--alt]
//   zwwin.exe vtype  --text-hex <UTF-16 코드 단위마다 16진 4자리>
//   zwwin.exe frame  --stop 파일 --result 파일 [--no-exclude]      (백그라운드로 돈다)
//
// 판단하지 않는다(절대 규칙 5). 입력을 받은 창·좌표·전후 커서와 포그라운드를 사실로 싣고, 맞았는지는
// TS(src/input/virtual.ts judgeVirtual)가 따진다.
//
// **넣는 방법.** 그 점에 있는 대상 프로세스의 맨 위 창(대상이거나 그 소유 다이얼로그)을 고르고, 그 안의
// 가장 깊은 자식 창에 WM_MOUSEMOVE·WM_xBUTTONDOWN/UP·WM_MOUSEWHEEL·WM_KEYDOWN/UP 을 PostMessage 한다.
// 실제 입력 스트림을 거치지 않으므로 커서가 움직이지 않고 포그라운드도 바뀌지 않는다.
//
// **수식키.** 앱은 Ctrl·Shift 를 메시지가 아니라 GetKeyState 로 읽는다(Qt 도 그렇다). 그래서 대상 GUI
// 스레드에 입력 큐를 붙이고(AttachThreadInput) 키 상태 표를 바꾼 뒤(SetKeyboardState) 메시지를 넣고,
// 대상이 다 처리할 때까지(WaitForInputIdle) 기다렸다가 되돌린다. AutoHotkey ControlSend 와 같은 방법이다.
// 사람의 실제 키보드 상태(GetAsyncKeyState)는 건드리지 않는다.
//
// **DPI.** v* 와 frame 은 모니터별 DPI 인식(PMv2)으로 돈다(Main 이 고른다). 캡처 사각형(DWM 경계)과 클릭
// 좌표가 같은 물리 픽셀이 된다 — 시스템 DPI 인식인 기존 click 이 보조 모니터에서 어긋나던 원인이다.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class V
{
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr parent, N.POINT pt, uint flags);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref N.POINT pt);
    // **W 판이어야 한다.** 기본(A 판)이면 WM_CHAR 의 유니코드 글자를 ANSI 로 보고 바꿔서 한글이 깨진다
    // (2026-11-15 실앱: "가상커서_확인" → "?좆按_Ux").
    [DllImport("user32.dll", EntryPoint = "PostMessageW")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern bool GetKeyboardState(byte[] state);
    [DllImport("user32.dll")] public static extern bool SetKeyboardState(byte[] state);
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(N.POINT pt, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public N.RECT rcMonitor; public N.RECT rcWork; public uint dwFlags; }

    // 프레임 — 픽셀마다 투명도가 있는 레이어드 창 (테두리 안쪽 옅어지는 띠, 2026-11-17)
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref N.POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref N.POINT pptSrc, uint crKey, ref BLENDFUNCTION pblend, uint dwFlags);
    // 그림은 그대로 두고 창 전체 투명도만 바꾼다 (빛 숨쉬기) — hdcSrc 등을 NULL 로
    [DllImport("user32.dll", EntryPoint = "UpdateLayeredWindow")] public static extern bool UpdateLayeredWindowAlpha(IntPtr hwnd, IntPtr hdcDst, IntPtr pptDst, IntPtr psize, IntPtr hdcSrc, IntPtr pptSrc, uint crKey, ref BLENDFUNCTION pblend, uint dwFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx, cy; }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize; public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public N.RECT rcCaret;
    }

    public static readonly IntPtr PMV2 = new IntPtr(-4);
    public const uint CWP_SKIPINVISIBLE = 0x1, CWP_SKIPTRANSPARENT = 0x4;
    public const uint WM_MOUSEMOVE = 0x200, WM_MOUSEWHEEL = 0x20A, WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102;
    public const uint WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    public const uint WM_APP_VCURSOR = 0x8000 + 0x5A1; // 프레임에 커서 위치를 알린다 (wParam=x, lParam=y, 화면 물리 픽셀)
    public const uint WM_APP_VACTIVE = 0x8000 + 0x5A3; // 프레임에 가상 입력이 있었다고 알린다 — 작업 중(사람 클릭 막기) 시계를 다시 잰다
    public const uint WM_APP_VCLICK = 0x8000 + 0x5A2;  // 프레임에 눌렀다고 알린다 — 그 자리에 클릭 원 (같은 좌표계, 2026-11-17)
    public const int MK_LBUTTON = 0x1, MK_RBUTTON = 0x2, MK_SHIFT = 0x4, MK_CONTROL = 0x8, MK_MBUTTON = 0x10;
    // 버튼 없는 WM_MOUSEMOVE 에 싣는 정의되지 않은 비트. Qt 는 wParam==0 인 이동을 "마우스가 창 위에 없으면" 버린다
    // (qwindowsmousehandler — 실제 커서가 딴 데 있으니 늘 버려진다, 2026-11-15 Qt 픽스처 실측). 0 이 아니게만 만들고
    // 버튼·수식키 비트는 건드리지 않는다 — Qt 는 정의된 비트만 버튼으로 읽는다.
    public const int MK_VIRTUAL_HOVER = 0x80;
    public const int GCL_STYLE = -26, CS_DBLCLKS = 0x8;
    public const uint WDA_NONE = 0, WDA_EXCLUDEFROMCAPTURE = 0x11;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public const uint GW_HWNDPREV = 3;
    public const int GWL_EXSTYLE = -20, WS_EX_TOPMOST = 0x8;
    public const uint SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
}

internal static partial class Program
{
    /// v* 와 frame 은 PMv2 로 돈다 — 프로세스 DPI 인식은 한 번만 정할 수 있으므로 Main 이 동사를 보고 고른다.
    internal static bool UsesPerMonitorDpi(string verb)
    {
        return verb == "vclick" || verb == "vdrag" || verb == "vwheel" || verb == "vkey" || verb == "vtype" || verb == "vmove" || verb == "frame";
    }

    /// 캡처와 같은 사각형(DWM 경계) — 프레임이 대상 창을 따라갈 때 쓴다
    internal static bool RectOf(IntPtr hwnd, out N.RECT r) { return BestRect(hwnd, out r); }

    internal static void SetPerMonitorDpi()
    {
        try { if (V.SetProcessDpiAwarenessContext(V.PMV2)) return; } catch (EntryPointNotFoundException) { }
        N.SetProcessDPIAware();
    }

    // ---- 받을 창 고르기 ---------------------------------------------------------

    private sealed class Hit
    {
        public IntPtr Hwnd, Root;
        public uint Pid;
        public int ClientX, ClientY;
        public uint WindowDpi, MonitorDpi;
    }

    /// 그 점이 있는 모니터의 실제 DPI. 못 읽으면 0.
    private static uint MonitorDpiAt(int sx, int sy)
    {
        try
        {
            IntPtr mon = V.MonitorFromPoint(new N.POINT { X = sx, Y = sy }, 2 /* MONITOR_DEFAULTTONEAREST */);
            uint dx, dy;
            return V.GetDpiForMonitor(mon, 0 /* MDT_EFFECTIVE_DPI */, out dx, out dy) == 0 ? dx : 0;
        }
        catch { return 0; }
    }

    /// 화면 물리 픽셀을 그 창의 클라이언트 좌표(PMv2 로 본 물리 픽셀)로. **배율 환산을 하지 않는다** — DPI 를 모르는 앱에
    /// 들어가는 마우스 메시지 좌표는 Windows 가 그 창의 좌표계로 바꿔 준다. 직접 환산하면 두 번 줄어든다
    /// (2026-11-15 실측: 200% 모니터의 DPI 모르는 WinForms 픽스처 — 환산하면 오른쪽 위가 왼쪽 위로 눌렸고, 빼니 네 칸 다 맞았다).
    /// 창 DPI·모니터 DPI 는 결과에 사실로만 싣는다.
    private static void ToClient(IntPtr h, int sx, int sy, out int cx, out int cy, out uint winDpi, out uint monDpi)
    {
        var p = new N.POINT { X = sx, Y = sy };
        V.ScreenToClient(h, ref p);
        winDpi = 0; monDpi = MonitorDpiAt(sx, sy);
        try { winDpi = V.GetDpiForWindow(h); } catch (EntryPointNotFoundException) { }
        cx = p.X; cy = p.Y;
    }

    /// WM_MOUSEWHEEL 은 lParam 이 화면 좌표다. 다른 마우스 메시지와 같은 규칙으로 물리 픽셀을 그대로 보낸다
    /// (DPI 를 모르는 앱의 휠은 시험하지 않았다 — 열린 항목).
    private static IntPtr WheelScreenLParam(IntPtr h, int sx, int sy)
    {
        return MakeLParam(sx, sy);
    }

    /// 그 화면 점에서 받을 **대상 프로세스의 최상위 창**을 고르고, 그 안의 가장 깊은 자식을 찾는다. 판정은 TS 가 한다.
    /// ① OS 의 실제 판정(WindowFromPoint)이 대상 프로세스의 창이면 그것 — 투명 레이어드 창·클릭 통과 창을 OS 가 건너뛴다.
    ///    2026-11-15 CLO 실측: 메뉴 막대 위의 투명 팝업(200x60, WS_EX_LAYERED, 소유자 없음, 맨 위)을 ②만으로는 골랐다.
    /// ② 다른 앱 창이 그 점을 덮고 있으면(가상 커서는 가려진 창에도 넣는다) 대상 프로세스 창을 z 순서로 — 클릭 통과
    ///    (WS_EX_TRANSPARENT) 창은 건너뛴다. 소유 다이얼로그가 메인 위에 떠 있으면 다이얼로그가 받는다 — 실제 클릭과 같다.
    private static Hit HitAt(Win target, int sx, int sy)
    {
        IntPtr root = IntPtr.Zero;
        IntPtr os = N.WindowFromPoint(new N.POINT { X = sx, Y = sy });
        if (os != IntPtr.Zero)
        {
            IntPtr osRoot = N.GetAncestor(os, N.GA_ROOT);
            uint osPid;
            N.GetWindowThreadProcessId(osRoot, out osPid);
            if (osPid == target.Pid) root = osRoot;
        }
        if (root == IntPtr.Zero)
        {
            foreach (var w in Enumerate())
            {
                if (w.Pid != target.Pid || w.Minimized || (w.ExStyle & 0x20) != 0) continue;
                if (sx >= w.Rect.Left && sx < w.Rect.Right && sy >= w.Rect.Top && sy < w.Rect.Bottom) { root = w.Hwnd; break; }
            }
        }
        if (root == IntPtr.Zero) root = target.Hwnd;

        IntPtr h = root;
        for (int i = 0; i < 64; i++)
        {
            var p = new N.POINT { X = sx, Y = sy };
            V.ScreenToClient(h, ref p);
            IntPtr c = V.ChildWindowFromPointEx(h, p, V.CWP_SKIPINVISIBLE | V.CWP_SKIPTRANSPARENT);
            if (c == IntPtr.Zero || c == h) break;
            h = c;
        }
        int cx, cy; uint wd, md;
        ToClient(h, sx, sy, out cx, out cy, out wd, out md);
        uint pid;
        N.GetWindowThreadProcessId(h, out pid);
        return new Hit { Hwnd = h, Root = N.GetAncestor(h, N.GA_ROOT), Pid = pid, ClientX = cx, ClientY = cy, WindowDpi = wd, MonitorDpi = md };
    }

    private static IntPtr MakeLParam(int lo, int hi)
    {
        return new IntPtr((int)(((uint)(ushort)(short)lo) | ((uint)(ushort)(short)hi << 16)));
    }

    // ---- 수식키: 대상 스레드의 키 상태를 잠깐 바꾼다 --------------------------------

    private sealed class KeyState : IDisposable
    {
        private readonly uint mOwn, mTarget;
        private readonly bool mAttached;
        private readonly byte[] mSaved = new byte[256];
        private readonly Process mProc;
        public readonly bool Applied;

        /// ctrl·shift·alt 를 **요청대로** 둔다 — 요청하지 않은 것은 뗀 상태로 둔다(이전 상태가 새지 않게).
        public KeyState(Win w, bool ctrl, bool shift, bool alt, bool always) : this(w, ctrl, shift, alt, always, false) { }

        /// testCapsOn: 시험 전용 — 사람이 Caps Lock 을 켜 둔 상태를 흉내 낸다 (--test-caps-on, 2026-11-17)
        public KeyState(Win w, bool ctrl, bool shift, bool alt, bool always, bool testCapsOn)
        {
            uint pid;
            mTarget = N.GetWindowThreadProcessId(w.Hwnd, out pid);
            try { mProc = Process.GetProcessById((int)pid); } catch { mProc = null; }
            if (!(ctrl || shift || alt || always)) return;
            mOwn = N.GetCurrentThreadId();
            mAttached = N.AttachThreadInput(mOwn, mTarget, true);
            if (!mAttached) return;
            V.GetKeyboardState(mSaved);
            var s = (byte[])mSaved.Clone();
            if (testCapsOn) s[0x14] |= 0x01; // 사람 키보드의 Caps Lock 토글 흉내
            // 사람 키보드의 Caps Lock 이 새지 않게 끈다 — 켜져 있으면 보낸 글자의 대소문자가 뒤집힌다 (2026-11-17).
            // 이 표는 넣는 동안만 쓰고 Dispose 에서 되돌린다. SetKeyboardState 는 키보드 표시등을 바꾸지 않는다
            s[0x14] = 0;
            Set(s, 0x11, ctrl); Set(s, 0xA2, ctrl); Set(s, 0xA3, false);
            Set(s, 0x10, shift); Set(s, 0xA0, shift); Set(s, 0xA1, false);
            Set(s, 0x12, alt); Set(s, 0xA4, alt); Set(s, 0xA5, false);
            Applied = V.SetKeyboardState(s);
        }

        private static void Set(byte[] s, int vk, bool down) { s[vk] = down ? (byte)0x80 : (byte)0; }

        /// 넣은 메시지를 대상이 다 처리할 때까지 기다린다. 처리 전에 키 상태를 되돌리면 수식키가 빠진다.
        public void Drain()
        {
            System.Threading.Thread.Sleep(30);
            try { if (mProc != null) mProc.WaitForInputIdle(2000); } catch { }
            System.Threading.Thread.Sleep(30);
        }

        public void Dispose()
        {
            if (mAttached)
            {
                if (Applied) V.SetKeyboardState(mSaved);
                N.AttachThreadInput(mOwn, mTarget, false);
            }
        }
    }

    private static int MkFlags(bool ctrl, bool shift)
    {
        return (ctrl ? V.MK_CONTROL : 0) | (shift ? V.MK_SHIFT : 0);
    }

    // ---- 공통 틀 -------------------------------------------------------------------

    private sealed class VCtx
    {
        public Win W;
        public N.POINT CursorBefore;
        public long FgBefore;
        public bool Ctrl, Shift, Alt;
        public bool Frame;
        public bool TestCapsOn;
        /// 사람이 알약의 「중지」 를 누르면 생기는 파일 (2026-11-17). 있으면 입력하지 않고, 끌기·이동·글자는 단계마다 보고 끊는다
        public string HaltFile;
        public bool Halted;
        public int StepsDone = -1;
        public bool HaltNow() { return HaltFile != null && File.Exists(HaltFile); }
        /// 좌표의 기준이 된 창 크기 (--expect-size w,h, 2026-11-17). 마우스 입력 전과 끌기·이동 단계마다 지금 크기와 견주고,
        /// 다르면 넣지 않거나 끊는다 — 사람이 그사이 창 크기를 바꾸면 같은 좌표에 다른 것이 있다
        public int ExpectW = -1, ExpectH = -1;
        public bool Resized;
        public bool SizeChanged()
        {
            if (ExpectW < 0) return false;
            N.RECT r;
            if (!Program.RectOf(W.Hwnd, out r)) return false;
            return r.Right - r.Left != ExpectW || r.Bottom - r.Top != ExpectH;
        }
    }

    private static string VInit(Dictionary<string, string> a, out VCtx ctx)
    {
        ctx = null;
        var wins = Filter(Enumerate(), a);
        if (wins.Count == 0) return "조건에 맞는 창을 찾지 못했다.";
        ctx = new VCtx { W = wins[0], Ctrl = a.ContainsKey("ctrl"), Shift = a.ContainsKey("shift"), Alt = a.ContainsKey("alt"), HaltFile = Get(a, "halt-file"), TestCapsOn = a.ContainsKey("test-caps-on") };
        string es = Get(a, "expect-size");
        if (es != null)
        {
            var p = es.Split(',');
            if (p.Length != 2 || !int.TryParse(p[0], out ctx.ExpectW) || !int.TryParse(p[1], out ctx.ExpectH)) return "--expect-size 는 너비,높이 다: " + es;
        }
        if (ctx.HaltNow()) { ctx.Halted = true; ctx.StepsDone = 0; }
        else if (ctx.SizeChanged()) { ctx.Resized = true; ctx.StepsDone = 0; }
        else NotifyActive(ctx.W);
        N.GetCursorPos(out ctx.CursorBefore);
        ctx.FgBefore = N.GetForegroundWindow().ToInt64();
        return null;
    }

    private static string Point(Dictionary<string, string> a, string kx, string ky, Win w, out int x, out int y)
    {
        x = y = 0;
        string xs = Get(a, kx), ys = Get(a, ky);
        if (xs == null || ys == null) return "--" + kx + " 와 --" + ky + " 가 필요하다 (창 왼쪽 위 기준 캡처 픽셀).";
        if (!int.TryParse(xs, out x) || !int.TryParse(ys, out y)) return "--" + kx + ", --" + ky + " 는 정수여야 한다.";
        if (x < 0 || y < 0 || x >= w.Width || y >= w.Height)
            return "창 밖 좌표다: (" + x + "," + y + ") 는 " + w.Width + "x" + w.Height + " 밖이다.";
        return null;
    }

    /// 프레임에 가상 커서 위치를 알린다. 프레임이 없으면 false — 입력은 그대로 된다.
    private static bool NotifyFrame(Win w, int sx, int sy)
    {
        IntPtr f = V.FindWindowW(null, "zwprobe-vcursor:" + w.Hwnd.ToInt64());
        if (f == IntPtr.Zero) return false;
        return V.PostMessage(f, V.WM_APP_VCURSOR, new IntPtr(sx), new IntPtr(sy));
    }

    /// 프레임 커서가 새 자리로 미끄러지는 시간(FrameForm.GlideMs) 만큼 기다린다 — 사람이 보는 커서가 도착한 뒤 누른다
    /// (Claude in Chrome 도 커서 이동이 끝난 뒤 누른다). 프레임이 없으면 기다리지 않는다.
    private static void WaitGlide(bool frame)
    {
        if (frame) System.Threading.Thread.Sleep(FrameForm.GlideMs + 20);
    }

    /// 프레임에 가상 입력이 있었다고 알린다 — 작업 중으로 보고 사람 클릭을 막는다 (키·글자는 커서 알림이 없어서 따로)
    private static void NotifyActive(Win w)
    {
        IntPtr f = V.FindWindowW(null, "zwprobe-vcursor:" + w.Hwnd.ToInt64());
        if (f != IntPtr.Zero) V.PostMessage(f, V.WM_APP_VACTIVE, IntPtr.Zero, IntPtr.Zero);
    }

    /// 프레임에 눌렀다고 알린다 — 그 자리에 클릭 원이 퍼진다
    private static void NotifyClick(Win w, int sx, int sy)
    {
        IntPtr f = V.FindWindowW(null, "zwprobe-vcursor:" + w.Hwnd.ToInt64());
        if (f != IntPtr.Zero) V.PostMessage(f, V.WM_APP_VCLICK, new IntPtr(sx), new IntPtr(sy));
    }

    private static void ButtonMsgs(string button, out uint down, out uint up, out uint dbl, out int mk)
    {
        switch (button)
        {
            case "right": down = 0x204; up = 0x205; dbl = 0x206; mk = V.MK_RBUTTON; return;
            case "middle": down = 0x207; up = 0x208; dbl = 0x209; mk = V.MK_MBUTTON; return;
            default: down = 0x201; up = 0x202; dbl = 0x203; mk = V.MK_LBUTTON; return;
        }
    }

    private static void PostMouse(Hit h, uint msg, int wParam)
    {
        V.PostMessage(h.Hwnd, msg, new IntPtr(wParam), MakeLParam(h.ClientX, h.ClientY));
    }

    private static int VReply(VCtx c, string op, int x, int y, int sx, int sy, Hit h, bool modsApplied)
    {
        N.POINT after;
        N.GetCursorPos(out after);
        if (!c.Halted && !c.Resized) NotifyActive(c.W);
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"op\":"); AppendStr(sb, op);
        if (h != null)
        {
            sb.Append(",\"x\":").Append(x).Append(",\"y\":").Append(y);
            sb.Append(",\"screenX\":").Append(sx).Append(",\"screenY\":").Append(sy);
        }
        sb.Append(",\"target\":{\"hwnd\":").Append(h == null ? 0 : h.Hwnd.ToInt64());
        sb.Append(",\"root\":").Append(h == null ? 0 : h.Root.ToInt64());
        sb.Append(",\"pid\":").Append(h == null ? 0 : h.Pid);
        sb.Append(",\"clientX\":").Append(h == null ? 0 : h.ClientX);
        sb.Append(",\"clientY\":").Append(h == null ? 0 : h.ClientY);
        sb.Append(",\"windowDpi\":").Append(h == null ? 0 : h.WindowDpi);
        sb.Append(",\"monitorDpi\":").Append(h == null ? 0 : h.MonitorDpi).Append('}');
        sb.Append(",\"cursorBefore\":{\"x\":").Append(c.CursorBefore.X).Append(",\"y\":").Append(c.CursorBefore.Y).Append('}');
        sb.Append(",\"cursorAfter\":{\"x\":").Append(after.X).Append(",\"y\":").Append(after.Y).Append('}');
        sb.Append(",\"foregroundBefore\":").Append(c.FgBefore);
        sb.Append(",\"foregroundAfter\":").Append(N.GetForegroundWindow().ToInt64());
        sb.Append(",\"modsApplied\":").Append(modsApplied ? "true" : "false");
        sb.Append(",\"frame\":").Append(c.Frame ? "true" : "false");
        if (c.Halted) sb.Append(",\"halted\":true,\"stepsDone\":").Append(c.StepsDone);
        else if (c.Resized) sb.Append(",\"resized\":true,\"stepsDone\":").Append(c.StepsDone);
        sb.Append(",\"window\":"); AppendWin(sb, c.W);
        sb.Append('}');
        Console.Out.Write(sb.ToString());
        return 0;
    }

    // ---- 동사 ----------------------------------------------------------------------

    private static int CmdVClick(Dictionary<string, string> a)
    {
        VCtx c;
        string err = VInit(a, out c);
        if (err != null) return Fail(err);
        if (c.Halted || c.Resized) return VReply(c, "click", 0, 0, 0, 0, null, false); // 사람이 멈춤·창 크기가 바뀜 — 입력하지 않는다
        int x, y;
        err = Point(a, "x", "y", c.W, out x, out y);
        if (err != null) return Fail(err);
        string button = Get(a, "button") ?? "left";
        if (button != "left" && button != "right" && button != "middle") return Fail("--button 은 left, right, middle 중 하나여야 한다: " + button);
        int hold = 0;
        int.TryParse(Get(a, "hold") ?? "0", out hold);
        bool dblClick = a.ContainsKey("double");

        int sx = c.W.Rect.Left + x, sy = c.W.Rect.Top + y;
        var h = HitAt(c.W, sx, sy);
        uint down, up, dbl; int mk;
        ButtonMsgs(button, out down, out up, out dbl, out mk);
        int mods = MkFlags(c.Ctrl, c.Shift);
        bool hasDblClk = (V.GetClassLongPtr(h.Hwnd, V.GCL_STYLE).ToInt64() & V.CS_DBLCLKS) != 0;

        c.Frame = NotifyFrame(c.W, sx, sy);
        WaitGlide(c.Frame);
        bool applied;
        using (var ks = new KeyState(c.W, c.Ctrl, c.Shift, c.Alt, false))
        {
            applied = ks.Applied;
            PostMouse(h, V.WM_MOUSEMOVE, mods | V.MK_VIRTUAL_HOVER);
            if (c.Frame) NotifyClick(c.W, sx, sy);
            PostMouse(h, down, mk | mods);
            if (hold > 0) { ks.Drain(); System.Threading.Thread.Sleep(hold); }
            PostMouse(h, up, mods);
            if (dblClick)
            {
                PostMouse(h, hasDblClk ? dbl : down, mk | mods);
                PostMouse(h, up, mods);
            }
            ks.Drain();
        }
        return VReply(c, "click", x, y, sx, sy, h, applied);
    }

    private static int CmdVDrag(Dictionary<string, string> a)
    {
        VCtx c;
        string err = VInit(a, out c);
        if (err != null) return Fail(err);
        if (c.Halted || c.Resized) return VReply(c, "drag", 0, 0, 0, 0, null, false); // 사람이 멈춤·창 크기가 바뀜 — 입력하지 않는다
        int x, y, tx, ty;
        err = Point(a, "x", "y", c.W, out x, out y);
        if (err != null) return Fail(err);
        err = Point(a, "to-x", "to-y", c.W, out tx, out ty);
        if (err != null) return Fail(err);
        string button = Get(a, "button") ?? "left";
        if (button != "left" && button != "right" && button != "middle") return Fail("--button 은 left, right, middle 중 하나여야 한다: " + button);
        int steps = 10;
        int.TryParse(Get(a, "steps") ?? "10", out steps);
        if (steps < 1) return Fail("--steps 는 1 이상이어야 한다.");

        int sx = c.W.Rect.Left + x, sy = c.W.Rect.Top + y;
        // 누른 창이 끌기 내내 받는다 — 실제 끌기에서 SetCapture 가 하는 일과 같다
        var h = HitAt(c.W, sx, sy);
        uint down, up, dbl; int mk;
        ButtonMsgs(button, out down, out up, out dbl, out mk);
        int mods = MkFlags(c.Ctrl, c.Shift);

        bool applied;
        using (var ks = new KeyState(c.W, c.Ctrl, c.Shift, c.Alt, false))
        {
            applied = ks.Applied;
            c.Frame = NotifyFrame(c.W, sx, sy);
            WaitGlide(c.Frame);
            PostMouse(h, V.WM_MOUSEMOVE, mods | V.MK_VIRTUAL_HOVER);
            if (c.Frame) NotifyClick(c.W, sx, sy);
            PostMouse(h, down, mk | mods);
            ks.Drain();
            Hit last = h;
            for (int i = 1; i <= steps; i++)
            {
                // 사람이 멈추면 다음 단계에서 끊는다 — 아래에서 지금 자리에서 버튼을 뗀다
                if (c.HaltNow()) { c.Halted = true; c.StepsDone = i - 1; break; }
                if (c.SizeChanged()) { c.Resized = true; c.StepsDone = i - 1; break; } // 창 크기가 바뀜 — 지금 자리에서 뗀다
                int px = sx + (int)Math.Round((double)(tx - x) * i / steps);
                int py = sy + (int)Math.Round((double)(ty - y) * i / steps);
                int cx, cy; uint wd, md;
                ToClient(h.Hwnd, px, py, out cx, out cy, out wd, out md);
                last = new Hit { Hwnd = h.Hwnd, Root = h.Root, Pid = h.Pid, ClientX = cx, ClientY = cy, WindowDpi = wd, MonitorDpi = md };
                NotifyFrame(c.W, px, py);
                PostMouse(last, V.WM_MOUSEMOVE, mk | mods);
                System.Threading.Thread.Sleep(15);
            }
            PostMouse(last, up, mods);
            ks.Drain();
        }
        return VReply(c, "drag", x, y, sx, sy, h, applied);
    }

    private static int CmdVWheel(Dictionary<string, string> a)
    {
        VCtx c;
        string err = VInit(a, out c);
        if (err != null) return Fail(err);
        if (c.Halted || c.Resized) return VReply(c, "wheel", 0, 0, 0, 0, null, false); // 사람이 멈춤·창 크기가 바뀜 — 입력하지 않는다
        int x, y, delta;
        err = Point(a, "x", "y", c.W, out x, out y);
        if (err != null) return Fail(err);
        if (!int.TryParse(Get(a, "delta") ?? "", out delta) || delta == 0) return Fail("--delta 는 0 이 아닌 정수여야 한다 (120 = 한 칸 위).");

        int sx = c.W.Rect.Left + x, sy = c.W.Rect.Top + y;
        var h = HitAt(c.W, sx, sy);
        int mods = MkFlags(c.Ctrl, c.Shift);
        c.Frame = NotifyFrame(c.W, sx, sy);
        bool applied;
        using (var ks = new KeyState(c.W, c.Ctrl, c.Shift, c.Alt, false))
        {
            applied = ks.Applied;
            PostMouse(h, V.WM_MOUSEMOVE, mods | V.MK_VIRTUAL_HOVER);
            // WM_MOUSEWHEEL 의 lParam 은 화면 좌표다 (다른 마우스 메시지와 다르다)
            V.PostMessage(h.Hwnd, V.WM_MOUSEWHEEL, new IntPtr((int)((uint)(ushort)(short)delta << 16) | mods), WheelScreenLParam(h.Hwnd, sx, sy));
            ks.Drain();
        }
        return VReply(c, "wheel", x, y, sx, sy, h, applied);
    }

    /// 버튼 없이 옮긴다. 점마다 그 자리의 맨 위 창을 다시 고른다 — 마우스를 올려 연 팝업 메뉴 위로 넘어가면
    /// 그 팝업이 받아야 한다(실제 커서와 같다).
    private static int CmdVMove(Dictionary<string, string> a)
    {
        VCtx c;
        string err = VInit(a, out c);
        if (err != null) return Fail(err);
        if (c.Halted || c.Resized) return VReply(c, "move", 0, 0, 0, 0, null, false); // 사람이 멈춤·창 크기가 바뀜 — 입력하지 않는다
        int x, y;
        err = Point(a, "x", "y", c.W, out x, out y);
        if (err != null) return Fail(err);
        int fx = x, fy = y;
        bool hasFrom = Get(a, "from-x") != null || Get(a, "from-y") != null;
        if (hasFrom)
        {
            err = Point(a, "from-x", "from-y", c.W, out fx, out fy);
            if (err != null) return Fail(err);
        }
        int steps = hasFrom ? 10 : 1;
        int.TryParse(Get(a, "steps") ?? steps.ToString(), out steps);
        if (steps < 1) return Fail("--steps 는 1 이상이어야 한다.");

        Hit h = null;
        int sx = 0, sy = 0;
        for (int i = hasFrom ? 0 : steps; i <= steps; i++)
        {
            if (c.HaltNow()) { c.Halted = true; c.StepsDone = i; break; }
            if (c.SizeChanged()) { c.Resized = true; c.StepsDone = i; break; }
            int px = fx + (int)Math.Round((double)(x - fx) * i / steps);
            int py = fy + (int)Math.Round((double)(y - fy) * i / steps);
            sx = c.W.Rect.Left + px; sy = c.W.Rect.Top + py;
            h = HitAt(c.W, sx, sy);
            c.Frame = NotifyFrame(c.W, sx, sy);
            PostMouse(h, V.WM_MOUSEMOVE, V.MK_VIRTUAL_HOVER);
            System.Threading.Thread.Sleep(15);
        }
        try { Process.GetProcessById((int)c.W.Pid).WaitForInputIdle(1000); } catch { }
        if (h == null) return VReply(c, "move", 0, 0, 0, 0, null, false);
        return VReply(c, "move", x, y, sx, sy, h, false);
    }

    /// 키를 받을 창 — 대상 GUI 스레드의 포커스 창(그 창이 대상의 자손일 때). 없으면 대상 최상위 창.
    private static Hit KeyTarget(Win w)
    {
        uint pid;
        uint thread = N.GetWindowThreadProcessId(w.Hwnd, out pid);
        var gi = new V.GUITHREADINFO { cbSize = Marshal.SizeOf(typeof(V.GUITHREADINFO)) };
        IntPtr h = w.Hwnd;
        if (V.GetGUIThreadInfo(thread, ref gi) && gi.hwndFocus != IntPtr.Zero && (gi.hwndFocus == w.Hwnd || V.IsChild(w.Hwnd, gi.hwndFocus)))
            h = gi.hwndFocus;
        return new Hit { Hwnd = h, Root = N.GetAncestor(h, N.GA_ROOT), Pid = pid };
    }

    private static void PostKey(IntPtr hwnd, int vk, bool alt)
    {
        uint scan = V.MapVirtualKey((uint)vk, 0);
        bool ext = vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || (vk >= 0x25 && vk <= 0x28) || vk == 0x2D || vk == 0x2E;
        int baseL = 1 | (int)(scan << 16) | (ext ? 1 << 24 : 0) | (alt ? 1 << 29 : 0);
        V.PostMessage(hwnd, alt ? V.WM_SYSKEYDOWN : V.WM_KEYDOWN, new IntPtr(vk), new IntPtr(baseL));
        V.PostMessage(hwnd, alt ? V.WM_SYSKEYUP : V.WM_KEYUP, new IntPtr(vk), new IntPtr(baseL | (1 << 30) | unchecked((int)0x80000000)));
    }

    private static int CmdVKey(Dictionary<string, string> a)
    {
        VCtx c;
        string err = VInit(a, out c);
        if (err != null) return Fail(err);
        if (c.Halted) return VReply(c, "key", 0, 0, 0, 0, null, false); // 사람이 멈춤 — 입력하지 않는다
        int vk;
        if (!int.TryParse(Get(a, "vk") ?? "", out vk) || vk < 1 || vk > 255) return Fail("--vk 는 1~255 정수여야 한다.");
        var h = KeyTarget(c.W);
        bool applied;
        // 수식키가 없어도 키 상태를 맞춘다 — 대상 스레드에 남아 있던 Ctrl 같은 것이 새면 다른 명령이 된다
        using (var ks = new KeyState(c.W, c.Ctrl, c.Shift, c.Alt, true, c.TestCapsOn))
        {
            applied = ks.Applied;
            PostKey(h.Hwnd, vk, c.Alt);
            ks.Drain();
        }
        return VReply(c, "key", 0, 0, 0, 0, h, applied);
    }

    private static int CmdVType(Dictionary<string, string> a)
    {
        VCtx c;
        string err = VInit(a, out c);
        if (err != null) return Fail(err);
        if (c.Halted) return VReply(c, "type", 0, 0, 0, 0, null, false); // 사람이 멈춤 — 입력하지 않는다
        string hex = Get(a, "text-hex");
        if (hex == null || hex.Length == 0 || hex.Length % 4 != 0) return Fail("--text-hex 는 UTF-16 코드 단위마다 16진 4자리여야 한다.");
        var text = new StringBuilder();
        for (int i = 0; i < hex.Length; i += 4)
        {
            int u;
            if (!int.TryParse(hex.Substring(i, 4), System.Globalization.NumberStyles.HexNumber, null, out u)) return Fail("--text-hex 가 16진수가 아니다: " + hex.Substring(i, 4));
            text.Append((char)u);
        }
        var h = KeyTarget(c.W);
        bool allApplied = true;
        int typed = 0;
        foreach (char ch in text.ToString())
        {
            if (c.HaltNow()) { c.Halted = true; c.StepsDone = typed; break; }
            typed++;
            short scan = V.VkKeyScan(ch);
            int vk = scan & 0xFF, shiftState = (scan >> 8) & 0xFF;
            if (scan == -1 || vk == 0xFF || (shiftState & 0x6) != 0)
            {
                // 키보드 배치로 못 치는 글자(한글 등)는 글자 메시지로 넣는다
                V.PostMessage(h.Hwnd, V.WM_CHAR, new IntPtr(ch), new IntPtr(1));
                System.Threading.Thread.Sleep(5);
                continue;
            }
            using (var ks = new KeyState(c.W, false, (shiftState & 1) != 0, false, true, c.TestCapsOn))
            {
                allApplied &= ks.Applied;
                PostKey(h.Hwnd, vk, false);
                ks.Drain();
            }
        }
        return VReply(c, "type", 0, 0, 0, 0, h, allApplied);
    }

    // ---- 프레임: 대상 창을 따라다니는 테두리와 가상 커서 -------------------------------

    private static int CmdFrame(Dictionary<string, string> a)
    {
        string stop = Get(a, "stop"), result = Get(a, "result");
        if (stop == null || result == null) return Fail("--stop 과 --result 가 필요하다.");
        var wins = Filter(Enumerate(), a);
        if (wins.Count == 0) return Fail("조건에 맞는 창을 찾지 못했다.");
        var target = wins[0];
        bool exclude = !a.ContainsKey("no-exclude");
        string labelFile = Get(a, "label-file");
        string haltFile = Get(a, "halt-file");
        int idleMs = 10000;
        int.TryParse(Get(a, "idle-ms") ?? "10000", out idleMs);
        string busyDir = Get(a, "busy-dir");
        int busyFallbackMs = 300000;
        int.TryParse(Get(a, "busy-fallback-ms") ?? "300000", out busyFallbackMs);

        string reason = "stop";
        var t = new System.Threading.Thread(() =>
        {
            var form = new FrameForm(target, stop, exclude, labelFile, haltFile, idleMs, busyDir, busyFallbackMs);
            Application.Run(form);
            reason = form.EndReason;
        });
        t.SetApartmentState(System.Threading.ApartmentState.STA);
        t.Start();
        t.Join();

        File.WriteAllText(result, "{\"ok\":true,\"reason\":\"" + reason + "\",\"target\":" + target.Hwnd.ToInt64() + "}");
        return 0;
    }
}

// ---- 가상 커서 프레임 그림 — Claude in Chrome 디자인 (2026-11-17) ---------------------------
//
// 사용자 요청으로 Claude in Chrome 확장(1.0.107 `assets/agent-visual-indicator.js`)의 CSS 값을 옮겼다.
//   빛   : inset 0 0 22px/44px/66px rgba(B, .8/.5/.25), 2초 주기 0.6↔1 숨쉬기 (claude-pulse)
//   선   : inset 3px 단색 B — 숨쉬지 않는다 (알약과 한 몸으로 보이게)
//   알약 : 위 가운데에 붙은 B 바탕 + 흰 글자. 문구는 --label-file 을 0.5초마다 읽는다 — CLI 가 "<AI 이름> 작업 중" 을 쓴다
//          (없으면 「AI Agent 작업 중」, Claude 로고는 사용자 요청으로 뺐다, Stop 버튼도 뺐다 — 멈추는 장치가 따로 필요)
//   커서 : 22px 칸(viewBox 18)의 삼각 화살표 B 채움 + 흰 외곽선 1.5, 그림자 0 1px 2px rgba(0,0,0,.28), 0.2초 미끄러짐
//   클릭 : 34px 원 3px B 테두리 + B 30% 바탕, 0.22→1 로 커지며 0.65초 동안 사라진다
// B = rgb(198, 97, 63). 길이는 모두 96 dpi 기준이고 대상 모니터 배율을 곱한다.
//
// 창은 셋이다 — 모두 클릭 통과·비활성·맨 위·캡처 제외. 숨쉬기는 그림을 다시 만들지 않고 창 투명도만 바꾸므로
// (UpdateLayeredWindow 의 SourceConstantAlpha) 빛 창을 따로 둔다. 커서는 4K 그림을 매번 올리지 않게 작은 창으로 뗐다.
//   FrameForm  — 빛. 제목 "zwprobe-vcursor:<대상 hwnd>" (NotifyFrame·zwprobe frame 이 이 제목으로 찾는다). 나머지 둘을 소유한다
//   EdgeForm   — 선 + 알약
//   CursorForm — 화살표 + 클릭 원

internal static class Layered
{
    public static readonly Color B = Color.FromArgb(198, 97, 63);

    /// 픽셀마다 투명도가 있는 그림을 창에 올린다 (GetHbitmap 이 미리 곱한 알파로 바꿔 준다)
    public static void Push(Form f, Bitmap bmp, Point at, byte alpha)
    {
        IntPtr screen = V.GetDC(IntPtr.Zero), mem = V.CreateCompatibleDC(screen);
        IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0)), old = V.SelectObject(mem, hbmp);
        try
        {
            var size = new V.SIZE { cx = bmp.Width, cy = bmp.Height };
            var src = new N.POINT { X = 0, Y = 0 };
            var dst = new N.POINT { X = at.X, Y = at.Y };
            var blend = Blend(alpha);
            V.UpdateLayeredWindow(f.Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, 2 /* ULW_ALPHA */);
        }
        finally
        {
            V.SelectObject(mem, old);
            V.DeleteObject(hbmp);
            V.DeleteDC(mem);
            V.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    /// 그림은 그대로 두고 창 전체 투명도만 바꾼다
    public static void Alpha(Form f, byte alpha)
    {
        var blend = Blend(alpha);
        V.UpdateLayeredWindowAlpha(f.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref blend, 2);
    }

    private static V.BLENDFUNCTION Blend(byte alpha)
    {
        return new V.BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = alpha, AlphaFormat = 1 /* AC_SRC_ALPHA */ };
    }

    /// 클릭 통과·비활성·맨 위·도구 창·레이어드
    public const int ExStyle = 0x8 | 0x20 | 0x80 | 0x80000 | 0x08000000;

    /// CSS ease-out = cubic-bezier(0, 0, 0.58, 1). t 에 대한 y 를 이분법으로 푼다
    public static double EaseOut(double t)
    {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        double lo = 0, hi = 1, u = t;
        for (int i = 0; i < 24; i++)
        {
            u = (lo + hi) / 2;
            double x = 3 * (1 - u) * u * u * 0.58 + u * u * u; // x(u), P1.x=0, P2.x=0.58
            if (x < t) lo = u; else hi = u;
        }
        return 3 * (1 - u) * (1 - u) * u * 0 + 3 * (1 - u) * u * u * 1 + u * u * u; // y(u), P1.y=0, P2.y=1
    }

    /// 표준 정규 누적분포 (빛 번짐 = 가우스 흐림)
    public static double Phi(double z)
    {
        // Abramowitz-Stegun 7.1.26
        double t = 1 / (1 + 0.3275911 * Math.Abs(z) / Math.Sqrt(2));
        double y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.Exp(-z * z / 2);
        return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
    }
}

/// 빛 창 — 대상 창 중 그 모니터 안에 든 부분을 덮는다 (2026-11-17 전에는 3px 크게 덮고 바깥에 그려서
/// 최대화된 창이면 모니터 밖으로 나가 안 보였다). 선·알약 창과 커서 창을 소유하고, 50ms 마다 대상 창을 따라간다.
internal sealed class FrameForm : Form
{
    public const int GlideMs = 200;
    private static readonly double[] GlowBlur = { 22, 44, 66 };
    private static readonly double[] GlowAlpha = { 0.8, 0.5, 0.25 };
    private const double PulseMs = 2000;
    private readonly Win mTarget;
    private readonly string mStop;
    private readonly bool mExclude;
    private readonly string mLabelFile;
    private readonly string mHaltFile;
    private double mLabelReadAt = -1e9;
    private bool mHalted;
    private readonly StopForm mStopBtn; // 멈춤 파일 경로가 없으면 null — 버튼을 안 띄운다
    private readonly BlockForm mBlock;
    private readonly int mIdleMs;
    private double mActiveAt = NowMs(); // 마지막 가상 입력 (벽시계 unix ms — 훅이 쓴 시각과 견준다). 띄운 순간부터 작업 중
    private readonly string mBusyDir;      // Claude Code 훅이 세션마다 작업 시작 시각을 쓰는 폴더 (tools/claude-hooks)
    private readonly int mBusyFallbackMs;  // 작업 표시가 남아 있어도 마지막 입력 뒤 이만큼 지나면 걷는다 (세션이 죽은 경우)
    private bool mBusyMarked;              // 마지막으로 읽은: 이 창에 입력한 뒤에도 이어지는 작업이 있는가
    private static double NowMs() { return (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
    private bool mBusy = true;
    private readonly Timer mTimer = new Timer { Interval = 33 };
    private readonly System.Diagnostics.Stopwatch mClock = System.Diagnostics.Stopwatch.StartNew();
    private readonly EdgeForm mEdge;
    private readonly CursorForm mCursor;
    private float mScale = 1f;
    private Rectangle mRect = Rectangle.Empty;
    /// 막을 창 자리 — 대상 창 + 크기 조절 띠(보이지 않는 바깥 테두리), 모니터 안. 최대화면 mRect (2026-11-17)
    private Rectangle mBlockRect = Rectangle.Empty;
    private bool mDirty = true;
    public string EndReason = "stop";

    public FrameForm(Win target, string stop, bool exclude, string labelFile, string haltFile, int idleMs, string busyDir, int busyFallbackMs)
    {
        mBusyDir = busyDir; mBusyFallbackMs = Math.Max(1000, busyFallbackMs);
        mTarget = target; mStop = stop; mExclude = exclude; mLabelFile = labelFile; mHaltFile = haltFile;
        mIdleMs = Math.Max(100, idleMs);
        Text = "zwprobe-vcursor:" + target.Hwnd.ToInt64();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        // 맨 위(TOPMOST)로 두지 않는다 — Tick 이 대상 창 바로 위 한 칸에 둔다 (FrameForm.Restack, 2026-11-17)
        mEdge = new EdgeForm(target.Hwnd, exclude);
        mBlock = new BlockForm(target.Hwnd, exclude);
        mEdge.WithButton = !string.IsNullOrEmpty(haltFile);
        if (mEdge.WithButton) mStopBtn = new StopForm(target.Hwnd, exclude, haltFile, () => { if (ReadHalt()) RenderEdge(); });
        ReadLabel();
        ReadHalt();
        mCursor = new CursorForm(target.Hwnd, exclude);
        Measure();
        if (!mRect.IsEmpty) Bounds = mRect;
        mTimer.Tick += (s, e) => Tick();
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= Layered.ExStyle; return cp; }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        V.SetWindowDisplayAffinity(Handle, mExclude ? V.WDA_EXCLUDEFROMCAPTURE : V.WDA_NONE);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        mBlock.Show(this);
        mEdge.Show(this);
        if (mStopBtn != null) mStopBtn.Show(this);
        mCursor.Show(this);
        mCursor.Visible = false;
        Render();
        mTimer.Start();
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    /// 대상 창 ∩ 그 모니터, 모니터 배율
    private void Measure()
    {
        N.RECT r;
        if (!Program.RectOf(mTarget.Hwnd, out r)) return;
        var b = Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
        IntPtr mon = V.MonitorFromWindow(mTarget.Hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
        var mi = new V.MONITORINFO { cbSize = Marshal.SizeOf(typeof(V.MONITORINFO)) };
        if (mon != IntPtr.Zero && V.GetMonitorInfo(mon, ref mi))
        {
            var m = Rectangle.FromLTRB(mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right, mi.rcMonitor.Bottom);
            var clipped = Rectangle.Intersect(b, m);
            if (clipped.Width > 0 && clipped.Height > 0) b = clipped;
            uint dx, dy;
            try
            {
                if (V.GetDpiForMonitor(mon, 0 /* MDT_EFFECTIVE_DPI */, out dx, out dy) == 0 && dx > 0 && dx / 96f != mScale)
                {
                    mScale = dx / 96f;
                    mDirty = true;
                }
            }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }
        }
        if (b != mRect) { mRect = b; mDirty = true; }
        // 작업 중에는 사람이 테두리를 끌어 창 크기를 못 바꾸게 막을 창을 크기 조절 띠까지 넓힌다 (2026-11-17 사용자).
        // 최대화면 띠가 없고 GetWindowRect 가 모니터 밖·작업 표시줄로 8px 나가므로 보이는 사각형 그대로 둔다
        var outer = b;
        N.RECT wr;
        if (!V.IsZoomed(mTarget.Hwnd) && N.GetWindowRect(mTarget.Hwnd, out wr))
        {
            var o = Rectangle.FromLTRB(wr.Left, wr.Top, wr.Right, wr.Bottom);
            if (mon != IntPtr.Zero && V.GetMonitorInfo(mon, ref mi)) o = Rectangle.Intersect(o, Rectangle.FromLTRB(mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right, mi.rcMonitor.Bottom));
            if (o.Width > 0 && o.Height > 0) outer = Rectangle.Union(o, b);
        }
        if (outer != mBlockRect) { mBlockRect = outer; mBlock.Place(outer); }
    }

    private void Tick()
    {
        if (File.Exists(mStop)) { EndReason = "stop"; Close(); return; }
        if (!V.IsWindow(mTarget.Hwnd)) { EndReason = "target-gone"; Close(); return; }
        bool min = N.IsIconic(mTarget.Hwnd);
        if (min == Visible)
        {
            Visible = !min; mEdge.Visible = !min;
            if (min) mBlock.Visible = false;
            if (mStopBtn != null) mStopBtn.Visible = !min;
            if (min) mCursor.Visible = false;
            mDirty = true;
        }
        if (min) return;
        Measure();
        if (mDirty) Render();
        // 문구가 바뀌면 선·알약 창만 다시 그린다 (4K 빛 그림은 그대로)
        else if (mClock.Elapsed.TotalMilliseconds - mLabelReadAt >= 500)
        {
            ReadBusy();
            if (ReadLabel() | ReadHalt()) RenderEdge();
        }
        // 숨쉬기 — 0.6 ↔ 1, 2초 주기 (CSS ease-in-out 에 가까운 코사인)
        double ph = (mClock.Elapsed.TotalMilliseconds % PulseMs) / PulseMs;
        double o = mHalted ? 0.6 : 0.8 - 0.2 * Math.Cos(2 * Math.PI * ph); // 멈춤이면 숨쉬지 않는다
        // 작업 중 = 마지막 가상 입력 뒤 idle-ms 안. 아니면 빛을 끄고 알약을 「대기 중」 으로, 사람 클릭을 막지 않는다
        // 작업 중 = 마지막 가상 입력 뒤 idle-ms 안, 또는 그 입력 전에 시작된 Claude Code 작업이 아직 이어진다(훅 표시, 안전장치 안)
        double since = NowMs() - mActiveAt;
        bool busy = since < mIdleMs || (mBusyMarked && since < mBusyFallbackMs);
        if (busy != mBusy) { mBusy = busy; mEdge.SetIdle(!busy); RenderEdge(); }
        bool block = busy && !mHalted;
        if (block != mBlock.Visible) mBlock.Visible = block;
        if (!busy) o = 0;
        Layered.Alpha(this, (byte)Math.Round(255 * o));
        Restack();
    }

    private static readonly uint MyPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    private static bool IsMine(IntPtr h) { uint pid; V.GetWindowThreadProcessId(h, out pid); return pid == MyPid; }
    private static bool IsTopmost(IntPtr h) { return (V.GetWindowLong(h, V.GWL_EXSTYLE) & V.WS_EX_TOPMOST) != 0; }

    /// 덮개를 대상 창 바로 위 한 칸에 둔다 (2026-11-17 사용자): [사람이 연 창] > [빛 < 막을 창 < 선·알약 < 중지 버튼 < 커서] > [대상].
    /// 전에는 늘 맨 위(TOPMOST)로 33ms 마다 다시 올려서, 사람이 대상 위로 연 다른 창까지 덮고 작업 중엔 그 창을 못 누르게 했다.
    /// - 대상 위에 남의 보통 창이 있으면: 그 창 바로 밑(= 대상 바로 위)에 넣는다.
    /// - 대상이 보통 창 띠의 맨 위(사람이 앞으로 가져옴)이거나 대상이 맨 위 창이면: 덮개를 맨 위로 둔다. 백그라운드 프로세스는
    ///   창을 보통 창 띠 맨 위로 못 올린다(HWND_TOP 은 성공을 돌려주고도 무시된다, 2026-11-17 실측) — 맨 위로는 된다.
    ///   그래서 이때는 다른 프로그램의 「항상 위」 창 위에도 그려진다. 사람이 새 창을 열면 다음 Tick(33ms) 에 그 밑으로 내려간다.
    private void Restack()
    {
        const uint keep = 0x1 | 0x2 | V.SWP_NOACTIVATE; // NOSIZE | NOMOVE
        var mine = new List<IntPtr> { Handle, mBlock.Handle, mEdge.Handle };
        if (mStopBtn != null) mine.Add(mStopBtn.Handle);
        mine.Add(mCursor.Handle); // 아래 → 위
        // 대상 위의 첫 남의 보이는 창 (우리 창은 건너뜀). 맨 위 창이거나 없으면 대상이 보통 창 띠의 맨 위다
        IntPtr above = V.GetWindow(mTarget.Hwnd, V.GW_HWNDPREV);
        while (above != IntPtr.Zero && (IsMine(above) || !V.IsWindowVisible(above))) above = V.GetWindow(above, V.GW_HWNDPREV);
        if (IsTopmost(mTarget.Hwnd) || above == IntPtr.Zero || IsTopmost(above))
        {
            foreach (var h in mine) V.SetWindowPos(h, V.HWND_TOPMOST, 0, 0, 0, 0, keep);
            return;
        }
        // 이미 제자리면 건드리지 않는다 — 대상 위로 올라가며 보이는 창이 우리 창(보이는 것)을 순서대로 다 만나야 한다
        var shown = mine.FindAll(V.IsWindowVisible);
        IntPtr w = mTarget.Hwnd;
        int i = 0;
        while (i < shown.Count)
        {
            w = V.GetWindow(w, V.GW_HWNDPREV);
            if (w == IntPtr.Zero) break;
            if (!V.IsWindowVisible(w)) continue;
            if (w != shown[i]) break;
            i++;
        }
        if (i == shown.Count && !IsTopmost(Handle)) return;
        // 아래 것부터 같은 자리(above 바로 밑)에 넣으면 나중 것이 위로 쌓인다. 맨 위였던 창도 보통 창 밑에 넣으면 맨 위가 풀린다
        foreach (var h in mine) V.SetWindowPos(h, above, 0, 0, 0, 0, keep);
    }

    /// 작업 표시 폴더를 읽는다 — 시작 시각이 마지막 가상 입력 이전인 표시가 하나라도 있으면 그 작업이 이 창을 건드렸다.
    /// 입력 뒤에 시작된 작업(다른 요청)은 이 창을 건드리기 전까지 막지 않는다
    private void ReadBusy()
    {
        bool marked = false;
        if (!string.IsNullOrEmpty(mBusyDir))
        {
            try
            {
                if (Directory.Exists(mBusyDir))
                    foreach (var f in Directory.GetFiles(mBusyDir))
                    {
                        double t;
                        string txt;
                        try { txt = File.ReadAllText(f).Trim(); } catch (IOException) { continue; }
                        if (double.TryParse(txt, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out t) && t <= mActiveAt) { marked = true; break; }
                    }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        mBusyMarked = marked;
    }

    /// 멈춤 파일이 있는가. 바뀌었으면 true — 버튼(사람)이나 CLI frame resume 이 바꾼다
    private bool ReadHalt()
    {
        if (string.IsNullOrEmpty(mHaltFile)) return false;
        bool h;
        try { h = File.Exists(mHaltFile); } catch (IOException) { return false; }
        if (h == mHalted) return false;
        mHalted = h;
        mEdge.SetHalted(h);
        return true;
    }

    /// 선·알약과 그 위 버튼을 다시 그린다 (4K 빛 그림은 그대로)
    private void RenderEdge()
    {
        if (mRect.Width <= 0 || mRect.Height <= 0) return;
        mEdge.Render(mRect, mScale);
        if (mStopBtn != null) mStopBtn.Place(mEdge.ButtonRect, mScale, mHalted);
    }

    /// 알약 문구 파일을 읽는다. 바뀌었으면 true. 못 읽으면(없음·쓰는 중) 그대로 둔다
    private bool ReadLabel()
    {
        mLabelReadAt = mClock.Elapsed.TotalMilliseconds;
        if (string.IsNullOrEmpty(mLabelFile)) return false;
        try
        {
            if (!File.Exists(mLabelFile)) return mEdge.SetWords(null);
            return mEdge.SetWords(File.ReadAllText(mLabelFile, Encoding.UTF8));
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private void Render()
    {
        if (mRect.Width <= 0 || mRect.Height <= 0) return;
        if (Bounds != mRect) Bounds = mRect;
        using (var bmp = BuildGlow(mRect.Width, mRect.Height, mScale)) Layered.Push(this, bmp, mRect.Location, 255);
        RenderEdge();
        mBlock.Place(mBlockRect.IsEmpty ? mRect : mBlockRect);
        mCursor.SetScale(mScale);
        mDirty = false;
    }

    /// inset box-shadow 세 겹. 사각형 안쪽 그림자 = 바깥(사각형의 여집합)을 가우스로 흐린 것이라
    /// 덮임 = 1 - Px·Py (Px = 가로로 사각형 안에 남을 확률). σ = 흐림 반경 / 2 (CSS). 겹은 "위에 덮기" 로 합친다.
    private static Bitmap BuildGlow(int w, int h, float scale)
    {
        int n = GlowBlur.Length;
        var px = new double[n][]; var py = new double[n][];
        for (int k = 0; k < n; k++)
        {
            double sigma = GlowBlur[k] * scale / 2;
            px[k] = Inside(w, sigma); py[k] = Inside(h, sigma);
        }
        var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.WriteOnly, bmp.PixelFormat);
        try
        {
            int rgb = (Layered.B.R << 16) | (Layered.B.G << 8) | Layered.B.B;
            var row = new int[w];
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    double keep = 1;
                    for (int k = 0; k < n; k++) keep *= 1 - GlowAlpha[k] * (1 - px[k][x] * py[k][y]);
                    int a = (int)Math.Round(255 * (1 - keep));
                    row[x] = a <= 0 ? 0 : (a << 24) | rgb;
                }
                Marshal.Copy(row, 0, data.Scan0 + y * data.Stride, w);
            }
        }
        finally { bmp.UnlockBits(data); }
        return bmp;
    }

    /// 길이 len 인 구간에서 픽셀 가운데가 가우스 흐림 뒤에도 구간 안에 남을 확률
    private static double[] Inside(int len, double sigma)
    {
        var v = new double[len];
        for (int i = 0; i < len; i++)
        {
            double a = i + 0.5, b = len - i - 0.5;
            v[i] = Math.Max(0, Layered.Phi(a / sigma) + Layered.Phi(b / sigma) - 1);
        }
        return v;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == (int)V.WM_APP_VACTIVE)
        {
            mActiveAt = NowMs();
            return;
        }
        if (m.Msg == (int)V.WM_APP_VCURSOR)
        {
            mActiveAt = NowMs();
            if (Visible) mCursor.MoveTo(new Point(m.WParam.ToInt32(), m.LParam.ToInt32()));
            return;
        }
        if (m.Msg == (int)V.WM_APP_VCLICK)
        {
            if (Visible) mCursor.Ring(new Point(m.WParam.ToInt32(), m.LParam.ToInt32()));
            return;
        }
        base.WndProc(ref m);
    }
}

/// 선 + 알약 — 숨쉬지 않는다
internal sealed class EdgeForm : Form
{
    private const int BaseLine = 3;
    public const string DefaultWords = "AI Agent 작업 중"; // src/input/frameLabel.ts DEFAULT_FRAME_LABEL 과 같게
    public const string HaltedWords = "사람이 멈춤";
    private string mWords = DefaultWords;
    private bool mHalted;
    private readonly bool mExclude;
    /// 중지 버튼이 놓일 자리 (화면 좌표). Render 가 정한다 — StopForm 이 여기에 선다
    public Rectangle ButtonRect = Rectangle.Empty;
    /// 버튼 자리를 비워 두는가 (멈춤 파일 경로가 주어졌을 때만)
    public bool WithButton;

    public EdgeForm(IntPtr target, bool exclude)
    {
        mExclude = exclude;
        Text = "zwprobe-vcursor-edge:" + target.ToInt64();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        // 맨 위(TOPMOST)로 두지 않는다 — Tick 이 대상 창 바로 위 한 칸에 둔다 (FrameForm.Restack, 2026-11-17)
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= Layered.ExStyle; return cp; }
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        V.SetWindowDisplayAffinity(Handle, mExclude ? V.WDA_EXCLUDEFROMCAPTURE : V.WDA_NONE);
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    /// 알약 문구를 바꾼다. 비거나 null 이면 기본. 바뀌었으면 true (다시 그려야 한다)
    public bool SetWords(string words)
    {
        string w = string.IsNullOrWhiteSpace(words) ? DefaultWords : words.Trim();
        if (w.Length > 40) w = w.Substring(0, 40);
        if (w == mWords) return false;
        mWords = w;
        return true;
    }

    private bool mIdle;

    /// 대기 중(가상 입력이 한동안 없음)이면 「… 작업 중」 을 「… 대기 중」 으로
    public void SetIdle(bool idle) { mIdle = idle; }

    private string Shown()
    {
        if (mHalted) return HaltedWords;
        if (!mIdle) return mWords;
        return mWords.EndsWith("작업 중") ? mWords.Substring(0, mWords.Length - 4) + "대기 중" : mWords + " · 대기 중";
    }

    /// 멈춤이면 알약 글자가 「사람이 멈춤」. 바뀌었으면 true
    public bool SetHalted(bool halted)
    {
        if (halted == mHalted) return false;
        mHalted = halted;
        return true;
    }

    public void Render(Rectangle r, float s)
    {
        if (Bounds != r) Bounds = r;
        using (var bmp = new Bitmap(r.Width, r.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                int t = Math.Max(1, (int)Math.Round(BaseLine * s, MidpointRounding.AwayFromZero));
                t = Math.Min(t, Math.Min(r.Width, r.Height) / 2);
                using (var band = new SolidBrush(Layered.B))
                {
                    g.FillRectangle(band, 0, 0, r.Width, t);
                    g.FillRectangle(band, 0, r.Height - t, r.Width, t);
                    g.FillRectangle(band, 0, 0, t, r.Height);
                    g.FillRectangle(band, r.Width - t, 0, t, r.Height);
                }
                var btn = DrawPill(g, r.Width, s, Shown(), WithButton);
                ButtonRect = btn.IsEmpty ? Rectangle.Empty : Rectangle.Round(new RectangleF(r.X + btn.X, r.Y + btn.Y, btn.Width, btn.Height));
            }
            Layered.Push(this, bmp, r.Location, 255);
        }
    }

    /// 위 가운데에 붙은 알약: 아래 두 모서리만 둥글다(14px), 글자 600 14px. 버튼이 있으면 오른쪽에 그 자리를
    /// 비워 두고(StopForm 이 그 위에 선다) 그 자리(이 그림 좌표)를 돌려준다
    private static RectangleF DrawPill(Graphics g, int width, float s, string words, bool withButton)
    {
        var btn = RectangleF.Empty;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        using (var font = new Font("Malgun Gothic", 14 * s, FontStyle.Bold, GraphicsUnit.Pixel))
        {
            SizeF ts = g.MeasureString(words, font, PointF.Empty, StringFormat.GenericTypographic);
            float padL = 16 * s, padR = 16 * s, h = 32 * s, rad = 14 * s;
            float bw = withButton ? StopForm.Width(s) : 0, bh = StopForm.Height(s), gap = 10 * s;
            float w = padL + ts.Width + (withButton ? gap + bw + 6 * s : padR);
            float x0 = (width - w) / 2;
            if (withButton) btn = new RectangleF(x0 + padL + ts.Width + gap, (h - bh) / 2 + 1 * s, bw, bh);
            using (var shape = new GraphicsPath())
            {
                shape.AddLine(x0, 0, x0 + w, 0);
                shape.AddLine(x0 + w, 0, x0 + w, h - rad);
                shape.AddArc(x0 + w - 2 * rad, h - 2 * rad, 2 * rad, 2 * rad, 0, 90);
                shape.AddArc(x0, h - 2 * rad, 2 * rad, 2 * rad, 90, 90);
                shape.CloseFigure();
                // 아래로 옅은 그림자 (drop-shadow 0 2px 5px rgba(0,0,0,.22) 에 가깝게)
                using (var m = new Matrix()) using (var sh = (GraphicsPath)shape.Clone())
                {
                    m.Translate(0, 2 * s);
                    sh.Transform(m);
                    using (var sb = new SolidBrush(Color.FromArgb(40, 0, 0, 0))) g.FillPath(sb, sh);
                }
                using (var fill = new SolidBrush(Layered.B)) g.FillPath(fill, shape);
            }
            float cy = h / 2 + 1 * s;
            using (var white = new SolidBrush(Color.White))
                g.DrawString(words, font, white, x0 + padL, cy - ts.Height / 2, StringFormat.GenericTypographic);
        }
        return btn;
    }
}

/// 작업 중 막을 창 — 대상 창 전체를 덮어 사람의 클릭·휠을 받아 버린다 (2026-11-17 사용자 "작업하는 동안은 내가 클릭할 수 없게").
/// 클릭 통과가 아니고(TRANSPARENT 없음) 눌려도 활성화되지 않는다(NOACTIVATE). 눈에 안 보이게 픽셀 투명도 1/255 로 채운다
/// — 0 이면 레이어드 창은 그 픽셀을 클릭 통과시킨다. 가상 입력은 대상 창에 직접 넣으므로 막히지 않는다.
/// 프레임이 작업 중(마지막 가상 입력 뒤 idle-ms 안)이고 멈춤이 아닐 때만 보인다.
internal sealed class BlockForm : Form
{
    private readonly bool mExclude;

    public BlockForm(IntPtr target, bool exclude)
    {
        mExclude = exclude;
        Text = "zwprobe-vcursor-block:" + target.ToInt64();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        // 맨 위(TOPMOST)로 두지 않는다 — Tick 이 대상 창 바로 위 한 칸에 둔다 (FrameForm.Restack, 2026-11-17)
        Cursor = Cursors.No;
        Size = new Size(1, 1);
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= Layered.ExStyle & ~0x20; return cp; }
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        V.SetWindowDisplayAffinity(Handle, mExclude ? V.WDA_EXCLUDEFROMCAPTURE : V.WDA_NONE);
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    public void Place(Rectangle r)
    {
        if (r.Width <= 0 || r.Height <= 0) return;
        if (Bounds != r) Bounds = r;
        using (var bmp = new Bitmap(r.Width, r.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp)) g.Clear(Color.FromArgb(1, 0, 0, 0));
            Layered.Push(this, bmp, r.Location, 255);
        }
    }
}

/// 알약 오른쪽 「■ 중지 / ▶ 재개」 버튼 — 프레임에서 **클릭을 받는 유일한 창**이다 (WS_EX_TRANSPARENT 없음).
/// 눌러도 활성화되지 않는다(NOACTIVATE). 누르면 멈춤 파일을 만들거나 지우고 프레임에 알린다 (2026-11-17).
/// 멈춤 파일이 있으면 그 창으로 가는 가상 입력은 거절되고(CLI 종료 코드 4) 진행 중인 끌기는 끊긴다.
internal sealed class StopForm : Form
{
    private readonly bool mExclude;
    private readonly string mHaltFile;
    private readonly Action mChanged;

    public static float Height(float s) { return 22 * s; }
    public static float Width(float s)
    {
        using (var bmp = new Bitmap(1, 1)) using (var g = Graphics.FromImage(bmp)) using (var f = LabelFont(s))
        {
            float a = g.MeasureString(Label(false), f, PointF.Empty, StringFormat.GenericTypographic).Width;
            float b = g.MeasureString(Label(true), f, PointF.Empty, StringFormat.GenericTypographic).Width;
            return (float)Math.Ceiling(Math.Max(a, b) + 20 * s);
        }
    }
    private static Font LabelFont(float s) { return new Font("Malgun Gothic", 12.5f * s, FontStyle.Bold, GraphicsUnit.Pixel); }
    private static string Label(bool halted) { return halted ? "\u25B6 재개" : "\u25A0 중지"; }

    public StopForm(IntPtr target, bool exclude, string haltFile, Action changed)
    {
        mExclude = exclude; mHaltFile = haltFile; mChanged = changed;
        Text = "zwprobe-vcursor-stop:" + target.ToInt64();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        // 맨 위(TOPMOST)로 두지 않는다 — Tick 이 대상 창 바로 위 한 칸에 둔다 (FrameForm.Restack, 2026-11-17)
        Cursor = Cursors.Hand;
        Size = new Size(1, 1);
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        // 클릭 통과(TRANSPARENT)만 뺀다 — 맨 위·도구 창·레이어드·비활성
        get { var cp = base.CreateParams; cp.ExStyle |= Layered.ExStyle & ~0x20; return cp; }
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        V.SetWindowDisplayAffinity(Handle, mExclude ? V.WDA_EXCLUDEFROMCAPTURE : V.WDA_NONE);
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (e.Button != MouseButtons.Left) return;
        try
        {
            if (File.Exists(mHaltFile)) File.Delete(mHaltFile);
            else
            {
                string dir = Path.GetDirectoryName(mHaltFile);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(mHaltFile, "사람이 알약의 중지를 눌렀다 " + DateTime.Now.ToString("s"), Encoding.UTF8);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        mChanged();
    }

    public void Place(Rectangle r, float s, bool halted)
    {
        if (r.IsEmpty) return;
        Bounds = r;
        using (var bmp = new Bitmap(r.Width, r.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                float rad = 7 * s;
                using (var shape = new GraphicsPath())
                {
                    shape.AddArc(0, 0, 2 * rad, 2 * rad, 180, 90);
                    shape.AddArc(r.Width - 1 - 2 * rad, 0, 2 * rad, 2 * rad, 270, 90);
                    shape.AddArc(r.Width - 1 - 2 * rad, r.Height - 1 - 2 * rad, 2 * rad, 2 * rad, 0, 90);
                    shape.AddArc(0, r.Height - 1 - 2 * rad, 2 * rad, 2 * rad, 90, 90);
                    shape.CloseFigure();
                    using (var bg = new SolidBrush(Color.FromArgb(250, 249, 245))) g.FillPath(bg, shape);
                }
                using (var f = LabelFont(s))
                {
                    string t = Label(halted);
                    SizeF ts = g.MeasureString(t, f, PointF.Empty, StringFormat.GenericTypographic);
                    using (var fg = new SolidBrush(Layered.B))
                        g.DrawString(t, f, fg, (r.Width - ts.Width) / 2, (r.Height - ts.Height) / 2, StringFormat.GenericTypographic);
                }
            }
            Layered.Push(this, bmp, r.Location, 255);
        }
    }
}

/// 화살표 + 클릭 원 — 작은 창이 커서를 따라다닌다. 새 자리로는 0.2초 ease-out 으로 미끄러진다.
internal sealed class CursorForm : Form
{
    private const int RingMs = 650;
    private readonly bool mExclude;
    private readonly Timer mAnim = new Timer { Interval = 15 };
    private readonly System.Diagnostics.Stopwatch mClock = System.Diagnostics.Stopwatch.StartNew();
    private float mScale = 1f;
    private PointF mPos, mFrom; private Point mTo; private double mGlideAt = -1e9;
    private bool mHasPos;
    private Point mRingAt; private double mRingStart = -1e9;

    public CursorForm(IntPtr target, bool exclude)
    {
        mExclude = exclude;
        Text = "zwprobe-vcursor-pointer:" + target.ToInt64();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        // 맨 위(TOPMOST)로 두지 않는다 — Tick 이 대상 창 바로 위 한 칸에 둔다 (FrameForm.Restack, 2026-11-17)
        Size = new Size(1, 1);
        mAnim.Tick += (s, e) => Step();
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= Layered.ExStyle; return cp; }
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        V.SetWindowDisplayAffinity(Handle, mExclude ? V.WDA_EXCLUDEFROMCAPTURE : V.WDA_NONE);
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) { }

    private double Now { get { return mClock.Elapsed.TotalMilliseconds; } }

    public void SetScale(float s)
    {
        if (s == mScale) return;
        mScale = s;
        if (mHasPos) Draw();
    }

    public void MoveTo(Point p)
    {
        if (!mHasPos) { mPos = p; mFrom = p; mTo = p; mHasPos = true; }
        else { mFrom = mPos; mTo = p; mGlideAt = Now; }
        if (!Visible) Visible = true;
        Draw();
        mAnim.Start();
    }

    public void Ring(Point p)
    {
        mRingAt = p; mRingStart = Now;
        if (!mHasPos) MoveTo(p);
        mAnim.Start();
        Draw();
    }

    private void Step()
    {
        double now = Now;
        bool gliding = now - mGlideAt < FrameForm.GlideMs, ringing = now - mRingStart < RingMs;
        if (gliding)
        {
            double e = Layered.EaseOut((now - mGlideAt) / FrameForm.GlideMs);
            mPos = new PointF((float)(mFrom.X + (mTo.X - mFrom.X) * e), (float)(mFrom.Y + (mTo.Y - mFrom.Y) * e));
        }
        else mPos = mTo;
        Draw();
        if (!gliding && !ringing) mAnim.Stop();
    }

    /// 창은 커서 끝점을 가운데에 둔 정사각형 — 원이 다 펼쳐져도(지름 34) 들어가는 크기
    private void Draw()
    {
        float s = mScale;
        int size = (int)Math.Ceiling(64 * s);
        var origin = new Point((int)Math.Round(mPos.X) - size / 2, (int)Math.Round(mPos.Y) - size / 2);
        using (var bmp = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                double rt = (Now - mRingStart) / RingMs;
                if (rt >= 0 && rt < 1) DrawRing(g, mRingAt.X - origin.X, mRingAt.Y - origin.Y, rt, s);
                DrawArrow(g, mPos.X - origin.X, mPos.Y - origin.Y, s);
            }
            Layered.Push(this, bmp, origin, 255);
        }
    }

    // 34px 원, 3px B 테두리 + B 30% 바탕, scale 0.22→1 · opacity 0.95→0 (ease-out 650ms). 테두리도 같이 줄었다 커진다
    private static void DrawRing(Graphics g, float x, float y, double t, float s)
    {
        double e = Layered.EaseOut(t);
        float sc = (float)(0.22 + 0.78 * e);
        int a = (int)Math.Round(255 * 0.95 * (1 - e));
        if (a <= 0) return;
        float outer = 17 * s * sc, bw = 3 * s * sc, inner = outer - bw;
        using (var bg = new SolidBrush(Color.FromArgb((int)Math.Round(a * 0.3), Layered.B)))
            g.FillEllipse(bg, x - inner, y - inner, 2 * inner, 2 * inner);
        using (var pen = new Pen(Color.FromArgb(a, Layered.B), bw))
            g.DrawEllipse(pen, x - outer + bw / 2, y - outer + bw / 2, 2 * outer - bw, 2 * outer - bw);
    }

    // 끝이 왼쪽 위인 삼각 화살표: viewBox 18 을 22px 칸에, 칸은 끝점에서 (-3, -2) — 경로 끝 (2.2, 1.6) 이 끝점에 온다
    private static void DrawArrow(Graphics g, float x, float y, float s)
    {
        float k = 22f / 18f * s;
        float ox = x - 3 * s, oy = y - 2 * s;
        PointF[] pts =
        {
            new PointF(ox + 2.2f * k, oy + 1.6f * k), new PointF(ox + 15.4f * k, oy + 7.9f * k),
            new PointF(ox + 9.5f * k, oy + 9.8f * k), new PointF(ox + 7.2f * k, oy + 15.8f * k),
        };
        // 그림자 drop-shadow(0 1px 2px rgba(0,0,0,.28)) — 아래로 1px 옮긴 같은 모양을 두 겹으로 흐리게
        for (int i = 1; i <= 2; i++)
        {
            var sh = Array.ConvertAll(pts, p => new PointF(p.X, p.Y + 1 * s + (i - 1) * 0.6f * s));
            using (var sb = new SolidBrush(Color.FromArgb(i == 1 ? 50 : 25, 0, 0, 0))) g.FillPolygon(sb, sh);
        }
        using (var fill = new SolidBrush(Layered.B)) g.FillPolygon(fill, pts);
        using (var pen = new Pen(Color.White, 1.5f * k) { LineJoin = LineJoin.Round }) g.DrawPolygon(pen, pts);
    }
}
