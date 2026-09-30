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
// 창을 클릭하면 그 사분면이 검게 칠해진다. 클릭 좌표 변환을 화면으로 검증하기 위한 것이다.
//
// --title T · --at X,Y 로 제목과 위치를 바꾼다. node --test 는 파일을 병렬로 돌리므로, 다른 테스트가
// 제목 조각("zwprobe-fixture")으로 찾거나 (80,80) 을 실제로 누르는 동안 **겹치지 않는 창**이 필요할 때 쓴다.
//
// 빌드: bash fixtures/winapp/build.sh

using System;
using System.Drawing;
using System.Windows.Forms;

internal sealed class FixtureForm : Form
{
    private readonly bool mWithDialog;

    public FixtureForm(bool withDialog, string title, Point at)
    {
        mWithDialog = withDialog;
        Text = title;
        FormBorderStyle = FormBorderStyle.None; // 창 사각형 == 클라이언트 영역
        StartPosition = FormStartPosition.Manual;
        Location = at;
        ClientSize = new Size(400, 300);
        ShowInTaskbar = false;
        DoubleBuffered = true;

        mTarget.Click += (s, e) => { mLastClick = new Point(ClientSize.Width - 1, ClientSize.Height - 1); Invalidate(); };
        Controls.Add(mTarget);
    }

    // 클릭이 실제로 닿았는지 **화면으로** 확인하기 위한 것이다. 마지막으로 눌린
    // 사분면을 검게 칠한다. 4분면 색이 다 다르므로 어느 칸이 눌렸는지 캡처만 보고
    // 알 수 있다 — "좌표가 창 기준으로 옳게 변환됐는가" 가 이걸로 검증된다.
    private Point? mLastClick;

    // 이름으로 찾아 누르는 경로(zwprobe click --name)를 검증하기 위한 버튼이다.
    // UIA 에 이름이 실리는 자식이 하나는 있어야 findOne → clickPoint → click 전 경로를
    // 픽스처에서 돌릴 수 있다. 눌리면 **우하단** 사분면을 검게 만든다 — 버튼 자신은
    // 좌상단에 있으므로 확인할 픽셀이 버튼에 가려지지 않는다.
    private readonly Button mTarget = new Button
    {
        Text = "fixture-target",
        Location = new Point(10, 10),
        Size = new Size(90, 22),
        TabStop = false,
    };

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        mLastClick = e.Location;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        int w = ClientSize.Width, h = ClientSize.Height;
        int hw = w / 2, hh = h / 2;
        e.Graphics.FillRectangle(Brushes.Red, 0, 0, hw, hh);
        e.Graphics.FillRectangle(Brushes.Lime, hw, 0, w - hw, hh);
        e.Graphics.FillRectangle(Brushes.Blue, 0, hh, hw, h - hh);
        e.Graphics.FillRectangle(Brushes.White, hw, hh, w - hw, h - hh);

        if (mLastClick.HasValue)
        {
            // 눌린 점이 속한 사분면을 검게 덮는다.
            int qx = mLastClick.Value.X < hw ? 0 : hw;
            int qy = mLastClick.Value.Y < hh ? 0 : hh;
            e.Graphics.FillRectangle(Brushes.Black, qx, qy, hw, hh);
        }
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
        string title = "zwprobe-fixture";
        var at = new Point(80, 80);
        for (int i = 0; i + 1 < args.Length; i++)
        {
            if (args[i] == "--title") title = args[i + 1];
            if (args[i] == "--at")
            {
                string[] xy = args[i + 1].Split(',');
                at = new Point(int.Parse(xy[0]), int.Parse(xy[1]));
            }
        }
        Application.EnableVisualStyles();
        Application.Run(new FixtureForm(withDialog, title, at));
    }
}
