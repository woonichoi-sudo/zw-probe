// zwprobe 캡처 테스트용 픽스처 창. Z-Weave 없이 초 단위로 반복하기 위한 것이다.
//
// 테두리 없는 고정 크기 창을 4분면으로 칠한다. 색을 다 다르게 두는 이유는
// 캡처 여부만이 아니라 **상하 반전**과 **채널 순서(BGRA)** 까지 한 번에
// 검증하기 위해서다. 좌상단이 빨강으로 읽히면 둘 다 맞은 것이다.
//
//   좌상 빨강(255,0,0)   우상 초록(0,255,0)
//   좌하 파랑(0,0,255)   우하 흰색(255,255,255)
//
// 빌드: bash fixtures/winapp/build.sh

using System;
using System.Drawing;
using System.Windows.Forms;

internal sealed class FixtureForm : Form
{
    public FixtureForm()
    {
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
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.Run(new FixtureForm());
    }
}
