// zwwin.exe record — 창을 일정 간격으로 찍어 H.264 MP4 로 쓴다. 아무것도 판단하지 않는다.
//
//   zwwin.exe record --out x.mp4 --result x.json --stop x.stop [--fps 10] [--max-seconds 600]
//                    [--mode screen|printwindow] [--no-cursor] [--process z-weave] [--pid N] [--title 조각]
//
// 끝나는 조건은 셋이다 — 정지 파일이 생겼다(stop), 최대 시간이 지났다(max-seconds),
// 창이 사라졌다(window-gone). 셋 다 MP4 를 **정상으로 마무리**한다. 프로세스를 죽이면
// SinkWriter 가 moov 를 못 써서 재생되지 않는 파일이 남으므로, 멈추는 쪽은 정지 파일을 만든다.
//
// 인코더는 Windows 내장 Media Foundation 이다. ffmpeg 같은 외부 실행 파일이 없어도 되고,
// csc.exe 만으로 빌드되도록 필요한 COM 인터페이스를 여기서 직접 선언한다. 메서드 순서가
// vtable 순서이므로 **SDK 헤더(mfobjects.h·mfreadwrite.h)의 선언 순서를 그대로 옮겼다** —
// 하나라도 빠지거나 바뀌면 다른 메서드가 불린다.
//
// 결과 JSON 은 --result 파일과 stdout 둘 다에 쓴다. TS 는 백그라운드로 띄우므로 stdout 을 못 받는다.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Mf
{
    public const int MF_VERSION = 0x00020070;
    public const int MFSTARTUP_FULL = 0;
    public const int MFVideoInterlace_Progressive = 2;

    public static readonly Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    public static readonly Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    public static readonly Guid MF_MT_AVG_BITRATE = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    public static readonly Guid MF_MT_INTERLACE_MODE = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    public static readonly Guid MF_MT_FRAME_SIZE = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
    public static readonly Guid MF_MT_FRAME_RATE = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    public static readonly Guid MF_MT_PIXEL_ASPECT_RATIO = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    public static readonly Guid MF_MT_DEFAULT_STRIDE = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
    public static readonly Guid MFMediaType_Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
    public static readonly Guid MFVideoFormat_H264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
    public static readonly Guid MFVideoFormat_RGB32 = new Guid("00000016-0000-0010-8000-00AA00389B71");
    public static readonly Guid MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS = new Guid("a634a91c-822b-41b9-a494-4de4643612b0");

    [DllImport("mfplat.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFStartup(int version, int flags);

    [DllImport("mfplat.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFShutdown();

    [DllImport("mfplat.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFCreateMediaType(out IMFMediaType type);

    [DllImport("mfplat.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFCreateSample(out IMFSample sample);

    [DllImport("mfplat.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFCreateMemoryBuffer(int maxLength, out IMFMediaBuffer buffer);

    [DllImport("mfplat.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFCreateAttributes(out IMFAttributes attributes, int initialSize);

    [DllImport("mfreadwrite.dll", ExactSpelling = true, PreserveSig = false)]
    public static extern void MFCreateSinkWriterFromURL([MarshalAs(UnmanagedType.LPWStr)] string url, IntPtr byteStream,
        IMFAttributes attributes, out IMFSinkWriter writer);

    public static long Pack(int hi, int lo) { return ((long)hi << 32) | (uint)lo; }
}

// mfobjects.h 의 선언 순서 그대로. 쓰지 않는 메서드도 자리를 지키려고 모두 둔다.
[ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFAttributes
{
    void GetItem(); void GetItemType(); void CompareItem(); void Compare(); void GetUINT32(); void GetUINT64();
    void GetDouble(); void GetGUID(); void GetStringLength(); void GetString(); void GetAllocatedString();
    void GetBlobSize(); void GetBlob(); void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem();
    void DeleteAllItems();
    void SetUINT32([In, MarshalAs(UnmanagedType.LPStruct)] Guid key, int value);
    void SetUINT64([In, MarshalAs(UnmanagedType.LPStruct)] Guid key, long value);
    void SetDouble();
    void SetGUID([In, MarshalAs(UnmanagedType.LPStruct)] Guid key, [In, MarshalAs(UnmanagedType.LPStruct)] Guid value);
    void SetString(); void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount();
    void GetItemByIndex(); void CopyAllItems();
}

[ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFMediaType
{
    // IMFAttributes
    void GetItem(); void GetItemType(); void CompareItem(); void Compare(); void GetUINT32(); void GetUINT64();
    void GetDouble(); void GetGUID(); void GetStringLength(); void GetString(); void GetAllocatedString();
    void GetBlobSize(); void GetBlob(); void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem();
    void DeleteAllItems();
    void SetUINT32([In, MarshalAs(UnmanagedType.LPStruct)] Guid key, int value);
    void SetUINT64([In, MarshalAs(UnmanagedType.LPStruct)] Guid key, long value);
    void SetDouble();
    void SetGUID([In, MarshalAs(UnmanagedType.LPStruct)] Guid key, [In, MarshalAs(UnmanagedType.LPStruct)] Guid value);
    void SetString(); void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount();
    void GetItemByIndex(); void CopyAllItems();
    // IMFMediaType
    void GetMajorType(); void IsCompressedFormat(); void IsEqual(); void GetRepresentation(); void FreeRepresentation();
}

[ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFSample
{
    // IMFAttributes
    void GetItem(); void GetItemType(); void CompareItem(); void Compare(); void GetUINT32(); void GetUINT64();
    void GetDouble(); void GetGUID(); void GetStringLength(); void GetString(); void GetAllocatedString();
    void GetBlobSize(); void GetBlob(); void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem();
    void DeleteAllItems(); void SetUINT32(); void SetUINT64(); void SetDouble(); void SetGUID(); void SetString();
    void SetBlob(); void SetUnknown(); void LockStore(); void UnlockStore(); void GetCount(); void GetItemByIndex();
    void CopyAllItems();
    // IMFSample
    void GetSampleFlags(); void SetSampleFlags(); void GetSampleTime();
    void SetSampleTime(long time);
    void GetSampleDuration();
    void SetSampleDuration(long duration);
    void GetBufferCount(); void GetBufferByIndex(); void ConvertToContiguousBuffer();
    void AddBuffer(IMFMediaBuffer buffer);
    void RemoveBufferByIndex(); void RemoveAllBuffers(); void GetTotalLength(); void CopyToBuffer();
}

[ComImport, Guid("045FA593-8799-42b8-BC8D-8968C6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFMediaBuffer
{
    void Lock(out IntPtr buffer, out int maxLength, out int currentLength);
    void Unlock();
    void GetCurrentLength();
    void SetCurrentLength(int length);
    void GetMaxLength();
}

// mfreadwrite.h
[ComImport, Guid("3137f1cd-fe5e-4805-a5d8-fb477448cb3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMFSinkWriter
{
    void AddStream(IMFMediaType targetType, out int streamIndex);
    void SetInputMediaType(int streamIndex, IMFMediaType inputType, IMFAttributes encodingParameters);
    void BeginWriting();
    void WriteSample(int streamIndex, IMFSample sample);
    void SendStreamTick(); void PlaceMarker(); void NotifyEndOfSegment(); void Flush();
    void Finalize_();
    void GetServiceForStream(); void GetStatistics();
}

internal static class CursorN
{
    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public N.POINT ptScreenPos; }

    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

    public const int CURSOR_SHOWING = 0x1;
    public const int DI_NORMAL = 0x3;

    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
    [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO info);
    [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int step, IntPtr brush, int flags);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
}

internal static partial class Program
{
    private static int CmdRecord(Dictionary<string, string> a)
    {
        string outPath = Get(a, "out");
        string resultPath = Get(a, "result");
        string stopPath = Get(a, "stop");
        if (outPath == null || resultPath == null || stopPath == null)
            return Fail("--out <x.mp4> --result <x.json> --stop <x.stop> 가 필요하다.");

        int fps = ParseInt(Get(a, "fps"), 10);
        double maxSeconds = ParseDouble(Get(a, "max-seconds"), 600);
        string mode = Get(a, "mode") ?? "screen";
        bool drawCursor = !a.ContainsKey("no-cursor");
        if (fps < 1 || fps > 60) return Fail("--fps 는 1~60 이다.");

        var wins = Filter(Enumerate(), a);
        if (wins.Count == 0) return FailTo(resultPath, "조건에 맞는 창을 찾지 못했다.");
        var w = wins[0];

        // H.264 는 짝수 크기만 받는다. 홀수면 오른쪽·아래 한 줄을 버린다.
        int width = w.Width & ~1, height = w.Height & ~1;

        outPath = Path.GetFullPath(outPath);
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        if (File.Exists(outPath)) File.Delete(outPath);

        long frameTicks = 10000000L / fps;
        int frames = 0, captureFailures = 0;
        string stopReason = "max-seconds";
        var clock = Stopwatch.StartNew();
        int duplicated = 0;

        Mf.MFStartup(Mf.MF_VERSION, Mf.MFSTARTUP_FULL);
        IMFSinkWriter writer = null;
        try
        {
            IMFAttributes attrs;
            Mf.MFCreateAttributes(out attrs, 1);
            attrs.SetUINT32(Mf.MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, a.ContainsKey("hw") ? 1 : 0);
            Mf.MFCreateSinkWriterFromURL(outPath, IntPtr.Zero, attrs, out writer);

            IMFMediaType outType;
            Mf.MFCreateMediaType(out outType);
            outType.SetGUID(Mf.MF_MT_MAJOR_TYPE, Mf.MFMediaType_Video);
            outType.SetGUID(Mf.MF_MT_SUBTYPE, Mf.MFVideoFormat_H264);
            // 화면 녹화는 대부분 정지해 있다 — 비트레이트는 픽셀 수에 맞춰 넉넉히 잡는다 (1080p 에서 약 8 Mbps).
            outType.SetUINT32(Mf.MF_MT_AVG_BITRATE, Math.Max(2000000, width * height * 4));
            outType.SetUINT32(Mf.MF_MT_INTERLACE_MODE, Mf.MFVideoInterlace_Progressive);
            outType.SetUINT64(Mf.MF_MT_FRAME_SIZE, Mf.Pack(width, height));
            outType.SetUINT64(Mf.MF_MT_FRAME_RATE, Mf.Pack(fps, 1));
            outType.SetUINT64(Mf.MF_MT_PIXEL_ASPECT_RATIO, Mf.Pack(1, 1));
            int stream;
            writer.AddStream(outType, out stream);

            IMFMediaType inType;
            Mf.MFCreateMediaType(out inType);
            inType.SetGUID(Mf.MF_MT_MAJOR_TYPE, Mf.MFMediaType_Video);
            inType.SetGUID(Mf.MF_MT_SUBTYPE, Mf.MFVideoFormat_RGB32);
            inType.SetUINT32(Mf.MF_MT_INTERLACE_MODE, Mf.MFVideoInterlace_Progressive);
            inType.SetUINT64(Mf.MF_MT_FRAME_SIZE, Mf.Pack(width, height));
            inType.SetUINT64(Mf.MF_MT_FRAME_RATE, Mf.Pack(fps, 1));
            inType.SetUINT64(Mf.MF_MT_PIXEL_ASPECT_RATIO, Mf.Pack(1, 1));
            // RGB 는 기본이 아래에서 위(DIB) 순서다. 양수 stride 로 위에서 아래임을 알린다 — 빼면 영상이 뒤집힌다.
            inType.SetUINT32(Mf.MF_MT_DEFAULT_STRIDE, width * 4);
            writer.SetInputMediaType(stream, inType, null);
            writer.BeginWriting();

            using (var bmp = new Bitmap(w.Width, w.Height, PixelFormat.Format32bppArgb))
            {
                // 시간 기준은 첫 프레임이다 — 시계는 인코더를 준비하기 전에 돌기 시작한다.
                long baseTicks = clock.Elapsed.Ticks;
                while (true)
                {
                    if (File.Exists(stopPath)) { stopReason = "stop"; break; }
                    if (clock.Elapsed.TotalSeconds >= maxSeconds) { stopReason = "max-seconds"; break; }

                    long due = baseTicks + (long)frames * frameTicks;
                    long now = clock.Elapsed.Ticks;
                    if (now < due) { Thread.Sleep((int)Math.Max(1, (due - now) / 10000)); continue; }

                    // 창이 사라지면(앱 종료) 멈춘다. 옮겨졌으면 새 위치를 따른다 — 크기는 첫 프레임 것을 유지한다.
                    var again = Filter(Enumerate(), a);
                    if (again.Count == 0) { stopReason = "window-gone"; break; }
                    w = again[0];

                    if (!CaptureFrame(bmp, w, mode, drawCursor)) { captureFailures++; }

                    // 시간은 **고정 간격**(프레임 번호 × 1/fps)으로 매긴다. 실제 캡처 시각을 넣으면 인코더가
                    // 고정 프레임률로 다시 매기면서 예정보다 일찍 온 프레임을 버린다 (실측: 50 개 중 43~47 개만 남았다).
                    // 캡처가 늦어 현실보다 뒤처졌으면 이 화면을 복제해 채운다 — 영상 속 시간이 현실과 같게 흐른다.
                    long owed = (clock.Elapsed.Ticks - baseTicks) / frameTicks + 1 - frames;
                    if (owed < 1) owed = 1;
                    for (long k = 0; k < owed; k++)
                    {
                        WriteFrame(writer, stream, bmp, width, height, (long)frames * frameTicks, frameTicks);
                        frames++;
                        if (k > 0) duplicated++;
                    }
                }
            }

            writer.Finalize_();
        }
        catch (Exception ex)
        {
            return FailTo(resultPath, "녹화 실패: " + ex.GetType().Name + ": " + ex.Message + " (frames=" + frames + ")");
        }
        finally
        {
            if (writer != null) Marshal.ReleaseComObject(writer);
            Mf.MFShutdown();
        }

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"out\":"); AppendStr(sb, outPath);
        sb.Append(",\"bytes\":").Append(File.Exists(outPath) ? new FileInfo(outPath).Length : 0);
        sb.Append(",\"frames\":").Append(frames);
        sb.Append(",\"captureFailures\":").Append(captureFailures);
        sb.Append(",\"duplicated\":").Append(duplicated);
        sb.Append(",\"seconds\":").Append(clock.Elapsed.TotalSeconds.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        sb.Append(",\"fps\":").Append(fps);
        sb.Append(",\"width\":").Append(width).Append(",\"height\":").Append(height);
        sb.Append(",\"mode\":"); AppendStr(sb, mode);
        sb.Append(",\"stopReason\":"); AppendStr(sb, stopReason);
        sb.Append(",\"window\":"); AppendWin(sb, w);
        sb.Append('}');
        WriteResult(resultPath, sb.ToString());
        Console.Out.Write(sb.ToString());
        return 0;
    }

    // 한 프레임을 SinkWriter 에 넣는다. 버퍼는 샘플마다 새로 만든다 — 인코더가 비동기로 붙잡고 있을 수 있다.
    private static void WriteFrame(IMFSinkWriter writer, int stream, Bitmap bmp, int width, int height, long time, long duration)
    {
        int bytes = width * height * 4;
        IMFMediaBuffer buffer;
        Mf.MFCreateMemoryBuffer(bytes, out buffer);
        IntPtr dst; int max, cur;
        buffer.Lock(out dst, out max, out cur);
        var data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[width * 4];
            for (int y = 0; y < height; y++)
            {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, row.Length);
                Marshal.Copy(row, 0, dst + y * width * 4, row.Length);
            }
        }
        finally { bmp.UnlockBits(data); buffer.Unlock(); }
        buffer.SetCurrentLength(bytes);

        IMFSample sample;
        Mf.MFCreateSample(out sample);
        sample.AddBuffer(buffer);
        sample.SetSampleTime(time);
        sample.SetSampleDuration(duration);
        writer.WriteSample(stream, sample);
        Marshal.ReleaseComObject(sample);
        Marshal.ReleaseComObject(buffer);
    }

    // shot 과 같은 두 방식. 커서는 둘 다 담지 않으므로 직접 그린다 — zwwin 의 클릭은 실제 커서를
    // 움직이므로, 영상에서 어디를 눌렀는지 보이게 하려면 필요하다.
    private static bool CaptureFrame(Bitmap bmp, Win w, string mode, bool drawCursor)
    {
        bool captured;
        int originX = w.Rect.Left, originY = w.Rect.Top;
        using (var g = Graphics.FromImage(bmp))
        {
            if (mode == "screen")
            {
                g.CopyFromScreen(w.Rect.Left, w.Rect.Top, 0, 0, new Size(bmp.Width, bmp.Height));
                captured = true;
            }
            else
            {
                IntPtr hdc = g.GetHdc();
                try { captured = N.PrintWindow(w.Hwnd, hdc, N.PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
                // PrintWindow 는 GetWindowRect(보이지 않는 테두리 포함)의 원점부터 그린다.
                N.RECT wr;
                if (N.GetWindowRect(w.Hwnd, out wr)) { originX = wr.Left; originY = wr.Top; }
            }

            if (drawCursor)
            {
                var ci = new CursorN.CURSORINFO { cbSize = Marshal.SizeOf(typeof(CursorN.CURSORINFO)) };
                if (CursorN.GetCursorInfo(ref ci) && (ci.flags & CursorN.CURSOR_SHOWING) != 0 && ci.hCursor != IntPtr.Zero)
                {
                    int hx = 0, hy = 0;
                    CursorN.ICONINFO ii;
                    if (CursorN.GetIconInfo(ci.hCursor, out ii))
                    {
                        hx = ii.xHotspot; hy = ii.yHotspot;
                        if (ii.hbmMask != IntPtr.Zero) CursorN.DeleteObject(ii.hbmMask);
                        if (ii.hbmColor != IntPtr.Zero) CursorN.DeleteObject(ii.hbmColor);
                    }
                    IntPtr hdc = g.GetHdc();
                    try { CursorN.DrawIconEx(hdc, ci.ptScreenPos.X - originX - hx, ci.ptScreenPos.Y - originY - hy, ci.hCursor, 0, 0, 0, IntPtr.Zero, CursorN.DI_NORMAL); }
                    finally { g.ReleaseHdc(hdc); }
                }
            }
        }
        return captured;
    }

    private static int FailTo(string resultPath, string message)
    {
        var sb = new StringBuilder();
        sb.Append("{\"ok\":false,\"error\":");
        AppendStr(sb, message);
        sb.Append('}');
        WriteResult(resultPath, sb.ToString());
        Console.Out.Write(sb.ToString());
        return 1;
    }

    // 결과를 임시 파일에 쓴 뒤 옮긴다 — 기다리는 쪽이 반쯤 쓰인 JSON 을 읽지 않게.
    private static void WriteResult(string path, string json)
    {
        if (path == null) return;
        string full = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(full));
        string tmp = full + ".tmp";
        File.WriteAllText(tmp, json, new UTF8Encoding(false));
        if (File.Exists(full)) File.Delete(full);
        File.Move(tmp, full);
    }

    private static int ParseInt(string s, int fallback)
    {
        int v;
        return s != null && int.TryParse(s, out v) ? v : fallback;
    }

    private static double ParseDouble(string s, double fallback)
    {
        double v;
        return s != null && double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) ? v : fallback;
    }
}
