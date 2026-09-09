// zwwin.exe — 창을 찾고 캡처해서 JSON 을 뱉는다. 아무것도 판단하지 않는다.
//
// CLAUDE.md 절대 규칙 5: 판단은 전부 zwprobe(TS)에, I/O는 가장자리에.
// 이 프로그램은 "검은 화면인가", "버그인가" 를 묻지 않는다. 찾고, 찍고, 사실만 보고한다.
//
// 빌드: tools/zwwin/build.sh (csc.exe, .NET Framework 4.x 내장)
//
// 사용:
//   zwwin.exe shot --process z-weave --png out/shot.png [--raw out/shot.bgra] [--mode printwindow|screen]
//   zwwin.exe windows [--process z-weave]

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class N
{
    public delegate bool EnumProc(IntPtr hwnd, IntPtr lparam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder buf, int max);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT val, int size);

    // 입력
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    public const int SW_RESTORE = 9;
    public const uint KEYEVENTF_KEYUP = 0x2;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_MENU = 0x12; // Alt
    public const byte VK_SHIFT = 0x10;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const uint GA_ROOT = 2;
    public const uint PW_RENDERFULLCONTENT = 0x2;
    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
}

internal sealed class Win
{
    public IntPtr Hwnd;
    public uint Pid;
    public string Title = "";
    public string ClassName = "";
    public bool Minimized;
    /// 프로세스 실행 파일의 버전. 읽지 못하면 빈 문자열.
    /// 어느 버전의 설정 디렉토리를 읽어야 하는지 TS 가 판단하는 데 쓴다.
    public string FileVersion = "";
    public string ExePath = "";
    public N.RECT Rect;
    public int Width { get { return Rect.Right - Rect.Left; } }
    public int Height { get { return Rect.Bottom - Rect.Top; } }
    public long Area { get { return (long)Width * Height; } }
}

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            N.SetProcessDPIAware();
            var a = ParseArgs(args);
            string verb = args.Length > 0 && !args[0].StartsWith("--") ? args[0] : "";

            switch (verb)
            {
                case "windows": return CmdWindows(a);
                case "shot": return CmdShot(a);
                case "key": return CmdKey(a);
                default:
                    return Fail("알 수 없는 명령: '" + verb + "'. shot 또는 windows 를 쓴다.");
            }
        }
        catch (Exception ex)
        {
            return Fail(ex.GetType().Name + ": " + ex.Message);
        }
    }

    // ---- 창 찾기 -------------------------------------------------------------

    private static List<Win> Enumerate()
    {
        var found = new List<Win>();
        N.EnumWindows((hwnd, _) =>
        {
            if (!N.IsWindowVisible(hwnd)) return true;
            if (N.GetAncestor(hwnd, N.GA_ROOT) != hwnd) return true; // 최상위만

            uint pid;
            N.GetWindowThreadProcessId(hwnd, out pid);

            int len = N.GetWindowTextLengthW(hwnd);
            var title = new StringBuilder(len + 1);
            N.GetWindowTextW(hwnd, title, title.Capacity);

            var cls = new StringBuilder(256);
            N.GetClassNameW(hwnd, cls, cls.Capacity);

            N.RECT rect;
            if (!BestRect(hwnd, out rect)) return true;

            string exePath = "", fileVersion = "";
            // 다른 프로세스의 모듈 정보는 권한·비트수 차이로 못 읽을 수 있다.
            // 실패는 빈 문자열로 보고하고 판단은 하지 않는다.
            try
            {
                var proc = Process.GetProcessById((int)pid);
                exePath = proc.MainModule.FileName;
                fileVersion = FileVersionInfo.GetVersionInfo(exePath).FileVersion ?? "";
            }
            catch { }

            found.Add(new Win
            {
                Hwnd = hwnd,
                Pid = pid,
                Title = title.ToString(),
                ClassName = cls.ToString(),
                Minimized = N.IsIconic(hwnd),
                FileVersion = fileVersion,
                ExePath = exePath,
                Rect = rect,
            });
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // DWM 확장 프레임 경계가 실제 보이는 픽셀에 맞다. 실패하면 GetWindowRect 로 떨어진다.
    private static bool BestRect(IntPtr hwnd, out N.RECT rect)
    {
        if (N.DwmGetWindowAttribute(hwnd, N.DWMWA_EXTENDED_FRAME_BOUNDS, out rect, Marshal.SizeOf(typeof(N.RECT))) == 0
            && rect.Right > rect.Left && rect.Bottom > rect.Top)
        {
            return true;
        }
        return N.GetWindowRect(hwnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top;
    }

    // 프로세스 이름·pid·제목으로 걸러내고, 남은 것 중 가장 큰 창을 고른다.
    // "가장 큰 것이 메인 창" 은 판단이 아니라 선택 규칙이며, 후보 전체를 JSON 에 함께 실어
    // TS 쪽에서 다르게 고를 수 있게 한다.
    private static List<Win> Filter(List<Win> all, Dictionary<string, string> a)
    {
        var outp = new List<Win>();
        string proc = Get(a, "process");
        string pidS = Get(a, "pid");
        string title = Get(a, "title");

        var pidsOfProc = new HashSet<uint>();
        if (proc != null)
        {
            string want = proc.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? proc.Substring(0, proc.Length - 4) : proc;
            foreach (var p in Process.GetProcessesByName(want)) pidsOfProc.Add((uint)p.Id);
        }

        foreach (var w in all)
        {
            if (proc != null && !pidsOfProc.Contains(w.Pid)) continue;
            if (pidS != null && w.Pid.ToString(CultureInfo.InvariantCulture) != pidS) continue;
            if (title != null && w.Title.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
            outp.Add(w);
        }
        outp.Sort((x, y) => y.Area.CompareTo(x.Area));
        return outp;
    }

    // ---- 명령 ---------------------------------------------------------------

    private static int CmdWindows(Dictionary<string, string> a)
    {
        var wins = Filter(Enumerate(), a);
        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"windows\":[");
        for (int i = 0; i < wins.Count; i++)
        {
            if (i > 0) sb.Append(',');
            AppendWin(sb, wins[i]);
        }
        sb.Append("]}");
        Console.Out.Write(sb.ToString());
        return 0;
    }

    private static int CmdShot(Dictionary<string, string> a)
    {
        string png = Get(a, "png");
        if (png == null) return Fail("--png <경로> 가 필요하다.");
        string raw = Get(a, "raw");
        string mode = Get(a, "mode") ?? "printwindow";

        var wins = Filter(Enumerate(), a);
        if (wins.Count == 0) return Fail("조건에 맞는 창을 찾지 못했다.");
        var w = wins[0];

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(png)));

        using (var bmp = new Bitmap(w.Width, w.Height, PixelFormat.Format32bppArgb))
        {
            bool captured;
            using (var g = Graphics.FromImage(bmp))
            {
                if (mode == "screen")
                {
                    // 화면에서 직접 긁는다. 창이 가려져 있으면 가린 것이 찍힌다.
                    g.CopyFromScreen(w.Rect.Left, w.Rect.Top, 0, 0, new Size(w.Width, w.Height));
                    captured = true;
                }
                else
                {
                    IntPtr hdc = g.GetHdc();
                    try { captured = N.PrintWindow(w.Hwnd, hdc, N.PW_RENDERFULLCONTENT); }
                    finally { g.ReleaseHdc(hdc); }
                }
            }

            if (!captured) return Fail("PrintWindow 가 실패했다 (mode=" + mode + ").");

            bmp.Save(png, ImageFormat.Png);
            if (raw != null) SaveRaw(bmp, raw);

            var sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"mode\":");
            AppendStr(sb, mode);
            sb.Append(",\"png\":");
            AppendStr(sb, Path.GetFullPath(png));
            sb.Append(",\"raw\":");
            if (raw == null) sb.Append("null"); else AppendStr(sb, Path.GetFullPath(raw));
            sb.Append(",\"format\":\"bgra8\",\"window\":");
            AppendWin(sb, w);
            sb.Append(",\"candidates\":").Append(wins.Count).Append('}');
            Console.Out.Write(sb.ToString());
        }
        return 0;
    }

    // 창을 포그라운드로 올린다. SendInput/keybd_event 는 시스템 전역이라
    // 포커스된 창으로 가기 때문에, 입력에는 캡처와 달리 활성화가 필요하다.
    //
    // SetForegroundWindow 는 호출한 프로세스가 포그라운드가 아니면 조용히 실패한다.
    // 대상 창의 입력 스레드에 붙는 통상적인 우회를 쓰고, 실패 여부를 사실로 보고한다
    // (판단하지 않는다 — 몇 번 재시도했고 결과가 무엇인지만 알린다).
    private static bool Activate(IntPtr hwnd, int attempts, int waitMs)
    {
        if (N.IsIconic(hwnd)) N.ShowWindow(hwnd, N.SW_RESTORE);

        uint targetPid;
        uint targetThread = N.GetWindowThreadProcessId(hwnd, out targetPid);
        uint ownThread = N.GetCurrentThreadId();

        for (int i = 0; i < attempts; i++)
        {
            if (N.GetForegroundWindow() == hwnd) return true;

            bool attached = N.AttachThreadInput(ownThread, targetThread, true);
            N.SetForegroundWindow(hwnd);
            if (attached) N.AttachThreadInput(ownThread, targetThread, false);

            System.Threading.Thread.Sleep(waitMs);
        }
        return N.GetForegroundWindow() == hwnd;
    }

    private static int CmdKey(Dictionary<string, string> a)
    {
        string vkS = Get(a, "vk");
        if (vkS == null) return Fail("--vk <가상키코드> 가 필요하다. 키 문자열 해석은 zwprobe(TS) 가 한다.");

        int vk;
        if (!int.TryParse(vkS, out vk) || vk <= 0 || vk > 255) return Fail("--vk 는 1~255 정수여야 한다: " + vkS);

        bool ctrl = a.ContainsKey("ctrl");
        bool alt = a.ContainsKey("alt");
        bool shift = a.ContainsKey("shift");
        string method = Get(a, "method") ?? "send";
        int holdMs = 0;
        int.TryParse(Get(a, "hold") ?? "0", out holdMs);

        var wins = Filter(Enumerate(), a);
        if (wins.Count == 0) return Fail("조건에 맞는 창을 찾지 못했다.");
        var w = wins[0];

        bool activated = false;
        if (method == "send")
        {
            activated = Activate(w.Hwnd, 10, 40);
            if (activated) System.Threading.Thread.Sleep(60); // 포커스 전환이 앉도록

            if (ctrl) N.keybd_event(N.VK_CONTROL, 0, 0, UIntPtr.Zero);
            if (alt) N.keybd_event(N.VK_MENU, 0, 0, UIntPtr.Zero);
            if (shift) N.keybd_event(N.VK_SHIFT, 0, 0, UIntPtr.Zero);

            N.keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
            if (holdMs > 0) System.Threading.Thread.Sleep(holdMs);
            N.keybd_event((byte)vk, 0, N.KEYEVENTF_KEYUP, UIntPtr.Zero);

            if (shift) N.keybd_event(N.VK_SHIFT, 0, N.KEYEVENTF_KEYUP, UIntPtr.Zero);
            if (alt) N.keybd_event(N.VK_MENU, 0, N.KEYEVENTF_KEYUP, UIntPtr.Zero);
            if (ctrl) N.keybd_event(N.VK_CONTROL, 0, N.KEYEVENTF_KEYUP, UIntPtr.Zero);
        }
        else if (method == "post")
        {
            // 창을 지정할 수 있어 포커스가 필요 없지만, 수식키 상태가 실리지 않는다.
            // GetKeyState 로 Ctrl/Shift 를 읽는 앱에서는 수식키 조합이 통하지 않는다.
            N.PostMessage(w.Hwnd, N.WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
            N.PostMessage(w.Hwnd, N.WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
        }
        else
        {
            return Fail("--method 는 send 또는 post 여야 한다: " + method);
        }

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"method\":");
        AppendStr(sb, method);
        sb.Append(",\"vk\":").Append(vk);
        sb.Append(",\"ctrl\":").Append(ctrl ? "true" : "false");
        sb.Append(",\"alt\":").Append(alt ? "true" : "false");
        sb.Append(",\"shift\":").Append(shift ? "true" : "false");
        sb.Append(",\"activated\":").Append(activated ? "true" : "false");
        sb.Append(",\"foregroundAfter\":").Append(N.GetForegroundWindow().ToInt64());
        sb.Append(",\"window\":");
        AppendWin(sb, w);
        sb.Append('}');
        Console.Out.Write(sb.ToString());
        return 0;
    }

    // 판정용 원시 픽셀. PNG 는 사람이 보는 것이고, 이 파일은 TS 가 읽는 것이다.
    // 위에서 아래로, 행당 width*4 바이트, BGRA 순서.
    private static void SaveRaw(Bitmap bmp, string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
        var data = bmp.LockBits(new Rectangle(0, 0, bmp.Width, bmp.Height),
            ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            int stride = Math.Abs(data.Stride);
            int rowBytes = bmp.Width * 4;
            var row = new byte[stride];
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write))
            {
                for (int y = 0; y < bmp.Height; y++)
                {
                    Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, stride);
                    fs.Write(row, 0, rowBytes);
                }
            }
        }
        finally { bmp.UnlockBits(data); }
    }

    // ---- 잡동사니 -----------------------------------------------------------

    private static void AppendWin(StringBuilder sb, Win w)
    {
        sb.Append("{\"hwnd\":").Append(w.Hwnd.ToInt64());
        sb.Append(",\"pid\":").Append(w.Pid);
        sb.Append(",\"title\":"); AppendStr(sb, w.Title);
        sb.Append(",\"class\":"); AppendStr(sb, w.ClassName);
        sb.Append(",\"minimized\":").Append(w.Minimized ? "true" : "false");
        sb.Append(",\"fileVersion\":"); AppendStr(sb, w.FileVersion);
        sb.Append(",\"exePath\":"); AppendStr(sb, w.ExePath);
        sb.Append(",\"x\":").Append(w.Rect.Left).Append(",\"y\":").Append(w.Rect.Top);
        sb.Append(",\"width\":").Append(w.Width).Append(",\"height\":").Append(w.Height);
        sb.Append('}');
    }

    private static void AppendStr(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (char c in s ?? "")
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--")) continue;
            string k = args[i].Substring(2);
            string v = (i + 1 < args.Length && !args[i + 1].StartsWith("--")) ? args[++i] : "";
            d[k] = v;
        }
        return d;
    }

    private static string Get(Dictionary<string, string> d, string k)
    {
        string v;
        if (!d.TryGetValue(k, out v)) return null;
        return v.Length == 0 ? null : v;
    }

    private static int Fail(string message)
    {
        var sb = new StringBuilder();
        sb.Append("{\"ok\":false,\"error\":");
        AppendStr(sb, message);
        sb.Append('}');
        Console.Out.Write(sb.ToString());
        return 1;
    }
}
