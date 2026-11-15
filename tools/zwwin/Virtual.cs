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
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(N.POINT pt, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

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
    public const int MK_LBUTTON = 0x1, MK_RBUTTON = 0x2, MK_SHIFT = 0x4, MK_CONTROL = 0x8, MK_MBUTTON = 0x10;
    // 버튼 없는 WM_MOUSEMOVE 에 싣는 정의되지 않은 비트. Qt 는 wParam==0 인 이동을 "마우스가 창 위에 없으면" 버린다
    // (qwindowsmousehandler — 실제 커서가 딴 데 있으니 늘 버려진다, 2026-11-15 Qt 픽스처 실측). 0 이 아니게만 만들고
    // 버튼·수식키 비트는 건드리지 않는다 — Qt 는 정의된 비트만 버튼으로 읽는다.
    public const int MK_VIRTUAL_HOVER = 0x80;
    public const int GCL_STYLE = -26, CS_DBLCLKS = 0x8;
    public const uint WDA_NONE = 0, WDA_EXCLUDEFROMCAPTURE = 0x11;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
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
        public KeyState(Win w, bool ctrl, bool shift, bool alt, bool always)
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
    }

    private static string VInit(Dictionary<string, string> a, out VCtx ctx)
    {
        ctx = null;
        var wins = Filter(Enumerate(), a);
        if (wins.Count == 0) return "조건에 맞는 창을 찾지 못했다.";
        ctx = new VCtx { W = wins[0], Ctrl = a.ContainsKey("ctrl"), Shift = a.ContainsKey("shift"), Alt = a.ContainsKey("alt") };
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
        bool applied;
        using (var ks = new KeyState(c.W, c.Ctrl, c.Shift, c.Alt, false))
        {
            applied = ks.Applied;
            PostMouse(h, V.WM_MOUSEMOVE, mods | V.MK_VIRTUAL_HOVER);
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
            PostMouse(h, V.WM_MOUSEMOVE, mods | V.MK_VIRTUAL_HOVER);
            PostMouse(h, down, mk | mods);
            ks.Drain();
            Hit last = h;
            for (int i = 1; i <= steps; i++)
            {
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
            int px = fx + (int)Math.Round((double)(x - fx) * i / steps);
            int py = fy + (int)Math.Round((double)(y - fy) * i / steps);
            sx = c.W.Rect.Left + px; sy = c.W.Rect.Top + py;
            h = HitAt(c.W, sx, sy);
            c.Frame = NotifyFrame(c.W, sx, sy);
            PostMouse(h, V.WM_MOUSEMOVE, V.MK_VIRTUAL_HOVER);
            System.Threading.Thread.Sleep(15);
        }
        try { Process.GetProcessById((int)c.W.Pid).WaitForInputIdle(1000); } catch { }
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
        int vk;
        if (!int.TryParse(Get(a, "vk") ?? "", out vk) || vk < 1 || vk > 255) return Fail("--vk 는 1~255 정수여야 한다.");
        var h = KeyTarget(c.W);
        bool applied;
        // 수식키가 없어도 키 상태를 맞춘다 — 대상 스레드에 남아 있던 Ctrl 같은 것이 새면 다른 명령이 된다
        using (var ks = new KeyState(c.W, c.Ctrl, c.Shift, c.Alt, true))
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
        foreach (char ch in text.ToString())
        {
            short scan = V.VkKeyScan(ch);
            int vk = scan & 0xFF, shiftState = (scan >> 8) & 0xFF;
            if (scan == -1 || vk == 0xFF || (shiftState & 0x6) != 0)
            {
                // 키보드 배치로 못 치는 글자(한글 등)는 글자 메시지로 넣는다
                V.PostMessage(h.Hwnd, V.WM_CHAR, new IntPtr(ch), new IntPtr(1));
                System.Threading.Thread.Sleep(5);
                continue;
            }
            using (var ks = new KeyState(c.W, false, (shiftState & 1) != 0, false, true))
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

        string reason = "stop";
        var t = new System.Threading.Thread(() =>
        {
            var form = new FrameForm(target, stop, exclude);
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

/// 클릭이 통과하고, 활성화되지 않고, 캡처에 안 찍히는 맨 위 창. 대상 창보다 테두리 두께만큼 크게 덮는다.
internal sealed class FrameForm : Form
{
    private const int Border = 3;
    private static readonly Color Key = Color.FromArgb(255, 0, 255);
    private readonly Win mTarget;
    private readonly string mStop;
    private readonly bool mExclude;
    private readonly Timer mTimer = new Timer { Interval = 50 };
    private Point? mCursor; // 화면 물리 픽셀
    public string EndReason = "stop";

    public FrameForm(Win target, string stop, bool exclude)
    {
        mTarget = target; mStop = stop; mExclude = exclude;
        Text = "zwprobe-vcursor:" + target.Hwnd.ToInt64();
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        BackColor = Key;
        TransparencyKey = Key;
        TopMost = true;
        DoubleBuffered = true;
        Follow();
        mTimer.Tick += (s, e) => Tick();
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            // TOPMOST | TRANSPARENT | TOOLWINDOW | LAYERED | NOACTIVATE
            cp.ExStyle |= 0x8 | 0x20 | 0x80 | 0x80000 | 0x08000000;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        V.SetWindowDisplayAffinity(Handle, mExclude ? V.WDA_EXCLUDEFROMCAPTURE : V.WDA_NONE);
        mTimer.Start();
    }

    private void Follow()
    {
        N.RECT r;
        if (!Program.RectOf(mTarget.Hwnd, out r)) return;
        var b = new Rectangle(r.Left - Border, r.Top - Border, r.Right - r.Left + 2 * Border, r.Bottom - r.Top + 2 * Border);
        if (Bounds != b) Bounds = b;
    }

    private void Tick()
    {
        if (File.Exists(mStop)) { EndReason = "stop"; Close(); return; }
        if (!V.IsWindow(mTarget.Hwnd)) { EndReason = "target-gone"; Close(); return; }
        bool min = N.IsIconic(mTarget.Hwnd);
        if (min == Visible) Visible = !min;
        Follow();
        V.SetWindowPos(Handle, V.HWND_TOPMOST, 0, 0, 0, 0, 0x1 | 0x2 | V.SWP_NOACTIVATE); // 크기·위치 유지, 맨 위로
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == (int)V.WM_APP_VCURSOR)
        {
            mCursor = new Point(m.WParam.ToInt32(), m.LParam.ToInt32());
            Invalidate();
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        using (var pen = new Pen(Color.FromArgb(255, 170, 0), Border))
        {
            pen.Alignment = PenAlignment.Inset;
            g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        }
        if (!mCursor.HasValue) return;
        int x = mCursor.Value.X - Left, y = mCursor.Value.Y - Top;
        // 화살표 커서 — 끝점이 누른 자리다. 사람 커서와 헷갈리지 않게 주황 채움 + 검은 테두리
        var pts = new[]
        {
            new Point(x, y), new Point(x, y + 18), new Point(x + 4, y + 14), new Point(x + 7, y + 20),
            new Point(x + 10, y + 19), new Point(x + 7, y + 13), new Point(x + 13, y + 13),
        };
        g.SmoothingMode = SmoothingMode.None;
        using (var fill = new SolidBrush(Color.FromArgb(255, 200, 0))) g.FillPolygon(fill, pts);
        using (var outline = new Pen(Color.Black, 1)) g.DrawPolygon(outline, pts);
    }
}
