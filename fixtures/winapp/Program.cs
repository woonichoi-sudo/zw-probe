// zwprobe 캡처 테스트용 픽스처 창. Z-Weave 없이 초 단위로 반복하기 위한 것이다.
//
// 테두리 없는 고정 크기 창을 4분면으로 칠한다. 색을 다 다르게 두는 이유는
// 캡처 여부만이 아니라 **상하 반전**과 **채널 순서(BGRA)** 까지 한 번에
// 검증하기 위해서다. 좌상단이 빨강으로 읽히면 둘 다 맞은 것이다.
//
//   좌상 빨강(255,0,0)   우상 초록(0,255,0)
//   좌하 파랑(0,0,255)   우하 흰색(255,255,255)
//
// --dialog 를 주면 창이 뜬 뒤 **소유된 모달 다이얼로그**를 하나 더 띄운다.
// 창 구조 판정(windowState.ts)이 읽는 owner·enabled 배선을 검증하기 위한 것이다.
// 이 픽스처는 WinForms 이므로 **Qt 의 모달 구현이 같다는 증거는 되지 못한다** —
// 여기서 확인되는 것은 zwwin.exe 가 소유자와 활성 상태를 옳게 보고한다는 사실뿐이다.
//
// 빌드: bash fixtures/winapp/build.sh

using System;
using System.Drawing;
using System.Windows.Forms;

internal sealed class FixtureForm : Form
{
    private readonly bool mWithDialog;

    public FixtureForm(bool withDialog)
    {
        mWithDialog = withDialog;
        Text = "zwprobe-fixture";
        FormBorderStyle = FormBorderStyle.None; // 창 사각형 == 클라이언트 영역
        StartPosition = FormStartPosition.Manual;
        Location = new Point(80, 80);
        ClientSize = new Size(400, 300);
        ShowInTaskbar = false;
        DoubleBuffered = true;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        int w = ClientSize.Width, h = ClientSize.Height;
        int hw = w / 2, hh = h / 2;
        e.Graphics.FillRectangle(Brushes.Red, 0, 0, hw, hh);
        e.Graphics.FillRectangle(Brushes.Lime, hw, 0, w - hw, hh);
        e.Graphics.FillRectangle(Brushes.Blue, 0, hh, hw, h - hh);
        e.Graphics.FillRectangle(Brushes.White, hw, hh, w - hw, h - hh);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (!mWithDialog) return;

        // BeginInvoke 로 미뤄서 OnShown 이 끝난 뒤에 모달 루프에 들어간다.
        // 여기서 바로 ShowDialog 를 부르면 메인 창의 첫 페인트가 밀린다.
        BeginInvoke((MethodInvoker)delegate { new FixtureDialog().ShowDialog(this); });
    }
}

internal sealed class FixtureDialog : Form
{
    public FixtureDialog()
    {
        Text = "zwprobe-fixture-dialog";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(520, 80);
        ClientSize = new Size(200, 80);
        ShowInTaskbar = false;
        BackColor = Color.Magenta;
    }
}

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        bool withDialog = Array.IndexOf(args, "--dialog") >= 0;
        Application.EnableVisualStyles();
        Application.Run(new FixtureForm(withDialog));
    }
}
