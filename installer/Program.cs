using System;
using System.Drawing;
using System.Linq;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace BBStreamSetup
{
    static class Program
    {
        /// <summary>No arguments: the window. "--install" / "--uninstall": the same, without asking (exit code 1 on failure).</summary>
        [STAThread]
        static int Main(string[] args)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            if (args.Contains("--install") || args.Contains("--uninstall"))
            {
                try
                {
                    Installer.Progress print = (text, percent) => Console.WriteLine(percent + "% " + text);
                    if (args.Contains("--uninstall")) Installer.Uninstall(print);
                    else Installer.Install(print);
                    return 0;
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine(e);
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
            return 0;
        }
    }

    sealed class SetupForm : Form
    {
        static readonly Color Background = Color.FromArgb(0x31, 0x33, 0x38);
        static readonly Color Text1 = Color.FromArgb(0xF2, 0xF3, 0xF5);
        static readonly Color Text2 = Color.FromArgb(0xB5, 0xBA, 0xC1);
        static readonly Color Blurple = Color.FromArgb(0x58, 0x65, 0xF2);
        static readonly Color Danger = Color.FromArgb(0xF2, 0x3F, 0x42);

        readonly Label _status = new Label();
        readonly ProgressBar _bar = new ProgressBar();
        readonly Button _install = new Button();
        readonly LinkLabel _uninstall = new LinkLabel();
        bool _done;

        readonly float _scale;
        Point Pt(int x, int y) => new Point((int)(x * _scale), (int)(y * _scale));
        Size Px(int w, int h) => new Size((int)(w * _scale), (int)(h * _scale));

        public SetupForm()
        {
            using (var screen = Graphics.FromHwnd(IntPtr.Zero)) _scale = screen.DpiX / 96f;
            Text = "BBStream";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            // Laid out by hand in 96-dpi units and scaled here; fonts (in points) already follow the DPI.
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = Px(440, 290);
            BackColor = Background;
            Font = new Font("Segoe UI", 9.75f);

            var title = new Label { Text = "BBStream", ForeColor = Text1, Font = new Font("Segoe UI Semibold", 20f), AutoSize = true, Location = Pt(28, 22) };
            var version = new Label { Text = "v" + typeof(SetupForm).Assembly.GetName().Version.ToString(2), ForeColor = Text2, AutoSize = true };
            version.Location = new Point(title.Left + title.PreferredWidth + (int)(4 * _scale), title.Top + (title.PreferredHeight - version.PreferredHeight) * 2 / 3);
            var about = new Label
            {
                Text = "Transmita no Discord pelo Broadcast Box, com mais qualidade e sem precisar de Nitro. " +
                       "Quem tem o BBStream assiste sua live direto no Discord.",
                ForeColor = Text2,
                Location = Pt(30, 72),
                Size = Px(380, 66)
            };

            _status.ForeColor = Text2;
            _status.Location = Pt(30, 144);
            _status.Size = Px(380, 44);
            _status.Text = Installer.IsInstalled()
                ? "O BBStream já está instalado. Instale de novo para atualizar ou reparar."
                : "O Discord vai fechar e abrir sozinho durante a instalação.";

            _bar.Location = Pt(30, 194);
            _bar.Size = Px(380, 6);
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Visible = false;

            _install.Text = Installer.IsInstalled() ? "Reinstalar" : "Instalar";
            _install.Location = Pt(290, 228);
            _install.Size = Px(120, 38);
            _install.FlatStyle = FlatStyle.Flat;
            _install.FlatAppearance.BorderSize = 0;
            _install.BackColor = Blurple;
            _install.ForeColor = Color.White;
            _install.Font = new Font("Segoe UI Semibold", 10f);
            _install.Cursor = Cursors.Hand;
            _install.Click += (_, __) => { if (_done) Close(); else Run(false); };

            _uninstall.Text = "Desinstalar";
            _uninstall.AutoSize = true;
            _uninstall.Location = Pt(28, 238);
            _uninstall.LinkColor = Text2;
            _uninstall.ActiveLinkColor = Text1;
            _uninstall.LinkBehavior = LinkBehavior.HoverUnderline;
            _uninstall.Visible = Installer.IsInstalled();
            _uninstall.LinkClicked += (_, __) =>
            {
                if (MessageBox.Show(this, "Remover o BBStream e voltar ao Discord normal?", "BBStream", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                    Run(true);
            };

            Controls.AddRange(new Control[] { title, version, about, _status, _bar, _install, _uninstall });
            AcceptButton = _install;
        }

        async void Run(bool uninstall)
        {
            _install.Enabled = false;
            _uninstall.Enabled = false;
            _bar.Visible = true;
            _status.ForeColor = Text2;
            Installer.Progress report = (text, percent) => BeginInvoke((Action)(() =>
            {
                _status.Text = text;
                _bar.Value = Math.Max(0, Math.Min(100, percent));
            }));
            try
            {
                await Task.Run(() =>
                {
                    if (uninstall) Installer.Uninstall(report);
                    else Installer.Install(report);
                });
                _done = true;
                _install.Text = "Fechar";
                _install.Enabled = true;
                if (!uninstall)
                    _status.Text = "Pronto! Entre numa call e clique no botão de Go Live (ao lado do mudo) para transmitir.";
            }
            catch (Exception e)
            {
                _bar.Visible = false;
                _status.ForeColor = Danger;
                _status.Text = e is UserError ? e.Message : "Algo deu errado: " + (e is WebException ? "não consegui baixar os arquivos. Verifique sua internet." : e.Message);
                _install.Text = "Tentar de novo";
                _install.Enabled = true;
                _uninstall.Enabled = true;
            }
        }
    }
}
