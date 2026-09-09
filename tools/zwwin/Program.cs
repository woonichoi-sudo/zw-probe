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

            found.Add(new Win
            {
                Hwnd = hwnd,
                Pid = pid,
                Title = title.ToString(),
                ClassName = cls.ToString(),
                Minimized = N.IsIconic(hwnd),
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
