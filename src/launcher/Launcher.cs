using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace SiteBlueprintLauncher
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string initialUrl = args.Length > 0 ? args[0] : "";
            Application.Run(new MainForm(initialUrl));
        }
    }

    public class MainForm : Form
    {
        private TextBox txtUrl;
        private Button btnStart;
        private Button btnStop;
        private Button btnListen;
        private Button btnOpenOutput;
        private Button btnExtension;
        private NumericUpDown numDepth;
        private NumericUpDown numPages;
        private CheckBox chkApi;
        private CheckBox chkSnapshots;
        private CheckBox chkVerify;
        private CheckBox chkNoLlm;
        private RichTextBox rtbLog;
        private Label lblStatus;
        private ProgressBar progressBar;

        private Process currentProcess = null;
        private string toolRoot;

        public MainForm(string initialUrl)
        {
            toolRoot = ResolveToolRoot();
            InitializeComponent();
            if (!string.IsNullOrEmpty(initialUrl))
            {
                txtUrl.Text = initialUrl;
            }
        }

        private string ResolveToolRoot()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            if (File.Exists(Path.Combine(exeDir, "bin", "site-blueprint.mjs")))
                return exeDir;

            DirectoryInfo parent = Directory.GetParent(exeDir);
            string parentDir = parent != null ? parent.FullName : exeDir;
            if (File.Exists(Path.Combine(parentDir, "bin", "site-blueprint.mjs")))
                return parentDir;

            return exeDir;
        }

        private void InitializeComponent()
        {
            this.Text = "site-blueprint v2.0.0 — AI Website Cloner";
            this.Size = new Size(880, 680);
            this.MinimumSize = new Size(760, 560);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(24, 24, 27); // Zinc 900
            this.ForeColor = Color.FromArgb(244, 244, 245); // Zinc 100
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            // --- HEADER PANEL ---
            Panel pnlHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 64,
                Padding = new Padding(20, 10, 20, 5),
                BackColor = Color.FromArgb(18, 18, 20)
            };

            Label lblTitle = new Label
            {
                Text = "⚡ site-blueprint v2.0.0",
                Font = new Font("Segoe UI", 15f, FontStyle.Bold),
                ForeColor = Color.FromArgb(167, 139, 250), // Violet 400
                AutoSize = true,
                Location = new Point(18, 10)
            };

            Label lblSubtitle = new Label
            {
                Text = "Автономный реверс-инжиниринг сайтов → Next.js 16 + Tailwind v4 + Mock API + Chrome Extension",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(161, 161, 170), // Zinc 400
                AutoSize = true,
                Location = new Point(20, 38)
            };

            pnlHeader.Controls.Add(lblTitle);
            pnlHeader.Controls.Add(lblSubtitle);

            // --- INPUT & OPTIONS PANEL ---
            Panel pnlControls = new Panel
            {
                Dock = DockStyle.Top,
                Height = 150,
                Padding = new Padding(20, 10, 20, 10),
                BackColor = Color.FromArgb(24, 24, 27)
            };

            Label lblUrl = new Label
            {
                Text = "URL сайта для клонирования:",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(228, 228, 231),
                Location = new Point(20, 12),
                AutoSize = true
            };

            txtUrl = new TextBox
            {
                Location = new Point(20, 34),
                Size = new Size(540, 30),
                Font = new Font("Segoe UI", 11f),
                BackColor = Color.FromArgb(39, 39, 42),
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };

            Button btnPaste = new Button
            {
                Text = "📋 Вставить",
                Location = new Point(568, 33),
                Size = new Size(95, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(63, 63, 70),
                ForeColor = Color.White,
                Cursor = Cursors.Hand
            };
            btnPaste.FlatAppearance.BorderSize = 0;
            btnPaste.Click += (s, e) => {
                if (Clipboard.ContainsText()) txtUrl.Text = Clipboard.GetText().Trim();
            };

            btnStart = new Button
            {
                Text = "🚀 Клонировать",
                Location = new Point(670, 31),
                Size = new Size(165, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(124, 58, 237), // Violet 600
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnStart.FlatAppearance.BorderSize = 0;
            btnStart.Click += BtnStart_Click;

            btnStop = new Button
            {
                Text = "🛑 Стоп",
                Location = new Point(670, 31),
                Size = new Size(165, 34),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(225, 29, 72), // Rose 600
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
                Visible = false,
                Cursor = Cursors.Hand
            };
            btnStop.FlatAppearance.BorderSize = 0;
            btnStop.Click += BtnStop_Click;

            // Options Row 1
            Label lblDepth = new Label { Text = "Глубина:", Location = new Point(20, 75), AutoSize = true, ForeColor = Color.FromArgb(161, 161, 170) };
            numDepth = new NumericUpDown
            {
                Location = new Point(85, 73),
                Size = new Size(45, 24),
                Minimum = 0,
                Maximum = 5,
                Value = 2,
                BackColor = Color.FromArgb(39, 39, 42),
                ForeColor = Color.White
            };

            Label lblPages = new Label { Text = "Макс. стр:", Location = new Point(145, 75), AutoSize = true, ForeColor = Color.FromArgb(161, 161, 170) };
            numPages = new NumericUpDown
            {
                Location = new Point(215, 73),
                Size = new Size(55, 24),
                Minimum = 1,
                Maximum = 100,
                Value = 15,
                BackColor = Color.FromArgb(39, 39, 42),
                ForeColor = Color.White
            };

            chkApi = new CheckBox { Text = "API-моки", Checked = true, Location = new Point(290, 74), AutoSize = true, Cursor = Cursors.Hand };
            chkSnapshots = new CheckBox { Text = "SingleFile снимки", Checked = true, Location = new Point(380, 74), AutoSize = true, Cursor = Cursors.Hand };
            chkVerify = new CheckBox { Text = "Verify & Heal", Checked = true, Location = new Point(520, 74), AutoSize = true, Cursor = Cursors.Hand };
            chkNoLlm = new CheckBox { Text = "Без AI", Checked = false, Location = new Point(635, 74), AutoSize = true, Cursor = Cursors.Hand };

            // Quick Actions Row 2
            btnListen = new Button
            {
                Text = "📡 Сервер расширения (listen:3005)",
                Location = new Point(20, 110),
                Size = new Size(240, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(37, 99, 235), // Blue 600
                ForeColor = Color.White,
                Cursor = Cursors.Hand
            };
            btnListen.FlatAppearance.BorderSize = 0;
            btnListen.Click += BtnListen_Click;

            btnOpenOutput = new Button
            {
                Text = "📁 Папка output/",
                Location = new Point(270, 110),
                Size = new Size(130, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(63, 63, 70),
                ForeColor = Color.White,
                Cursor = Cursors.Hand
            };
            btnOpenOutput.FlatAppearance.BorderSize = 0;
            btnOpenOutput.Click += (s, e) => {
                string outDir = Path.Combine(toolRoot, "output");
                if (!Directory.Exists(outDir)) Directory.CreateDirectory(outDir);
                Process.Start("explorer.exe", outDir);
            };

            btnExtension = new Button
            {
                Text = "🧩 Расширение Chrome",
                Location = new Point(410, 110),
                Size = new Size(160, 30),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(5, 150, 105), // Emerald 600
                ForeColor = Color.White,
                Cursor = Cursors.Hand
            };
            btnExtension.FlatAppearance.BorderSize = 0;
            btnExtension.Click += (s, e) => {
                string extDir = Path.Combine(toolRoot, "extension");
                if (Directory.Exists(extDir)) Process.Start("explorer.exe", extDir);
                MessageBox.Show(
                    "Как установить расширение в Chrome / Edge / Brave:\n\n" +
                    "1. Откройте в браузере chrome://extensions\n" +
                    "2. Включите 'Режим разработчика' (вверху справа)\n" +
                    "3. Нажмите 'Загрузить распакованное расширение'\n" +
                    "4. Выберите открывшуюся папку 'extension'!\n\n" +
                    "После этого нажмите значок site-blueprint на любой странице сайта.",
                    "Установка расширения",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            };

            pnlControls.Controls.Add(lblUrl);
            pnlControls.Controls.Add(txtUrl);
            pnlControls.Controls.Add(btnPaste);
            pnlControls.Controls.Add(btnStart);
            pnlControls.Controls.Add(btnStop);
            pnlControls.Controls.Add(lblDepth);
            pnlControls.Controls.Add(numDepth);
            pnlControls.Controls.Add(lblPages);
            pnlControls.Controls.Add(numPages);
            pnlControls.Controls.Add(chkApi);
            pnlControls.Controls.Add(chkSnapshots);
            pnlControls.Controls.Add(chkVerify);
            pnlControls.Controls.Add(chkNoLlm);
            pnlControls.Controls.Add(btnListen);
            pnlControls.Controls.Add(btnOpenOutput);
            pnlControls.Controls.Add(btnExtension);

            // --- STATUS BAR PANEL ---
            Panel pnlStatus = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 32,
                BackColor = Color.FromArgb(18, 18, 20),
                Padding = new Padding(15, 6, 15, 6)
            };

            lblStatus = new Label
            {
                Text = "Готов к работе",
                ForeColor = Color.FromArgb(161, 161, 170),
                AutoSize = true,
                Location = new Point(12, 6)
            };

            progressBar = new ProgressBar
            {
                Dock = DockStyle.Right,
                Width = 140,
                Style = ProgressBarStyle.Marquee,
                Visible = false
            };

            pnlStatus.Controls.Add(lblStatus);
            pnlStatus.Controls.Add(progressBar);

            // --- LOG CONSOLE ---
            rtbLog = new RichTextBox
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(9, 9, 11), // Zinc 950
                ForeColor = Color.FromArgb(228, 228, 231),
                Font = new Font("Consolas", 10f),
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                ScrollBars = RichTextBoxScrollBars.Vertical
            };

            Panel pnlLogContainer = new Panel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(15, 0, 15, 5),
                BackColor = Color.FromArgb(24, 24, 27)
            };
            pnlLogContainer.Controls.Add(rtbLog);

            this.Controls.Add(pnlLogContainer);
            this.Controls.Add(pnlStatus);
            this.Controls.Add(pnlControls);
            this.Controls.Add(pnlHeader);

            AppendLog("⚡ site-blueprint v2.0.0 инициализирован. Рабочая папка: " + toolRoot, Color.Cyan);
            AppendLog("💡 Введите ссылку на сайт и нажмите 'Клонировать', либо запустите сервер расширения.", Color.Gray);
        }

        private string FindNodeExecutable()
        {
            // Check PATH first
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] dirs = pathEnv.Split(Path.PathSeparator);
            foreach (var d in dirs)
            {
                try
                {
                    string candidate = Path.Combine(d.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }

            // Common default install locations on Windows
            string[] defaults = new[] {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\node\node.exe")
            };
            foreach (var def in defaults)
            {
                if (File.Exists(def)) return def;
            }

            return null;
        }

        private void BtnStart_Click(object sender, EventArgs e)
        {
            string url = txtUrl.Text.Trim();
            if (string.IsNullOrEmpty(url))
            {
                MessageBox.Show("Пожалуйста, введите URL сайта (например, https://example.com)", "Внимание", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                txtUrl.Focus();
                return;
            }

            if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                url = "https://" + url;
                txtUrl.Text = url;
            }

            StringBuilder args = new StringBuilder();
            args.AppendFormat("\"{0}\" ", Path.Combine(toolRoot, "bin", "site-blueprint.mjs"));
            args.AppendFormat("\"{0}\" ", url);
            args.AppendFormat("--depth {0} ", (int)numDepth.Value);
            args.AppendFormat("--max-pages {0} ", (int)numPages.Value);

            if (!chkApi.Checked) args.Append("--no-api ");
            if (!chkSnapshots.Checked) args.Append("--no-snapshot ");
            if (!chkVerify.Checked) args.Append("--no-verify ");
            if (chkNoLlm.Checked) args.Append("--no-llm ");

            StartRunner(args.ToString(), "Клонирование " + url);
        }

        private void BtnListen_Click(object sender, EventArgs e)
        {
            string script = Path.Combine(toolRoot, "bin", "site-blueprint.mjs");
            StartRunner(string.Format("\"{0}\" listen --port 3005", script), "Сервер расширения (порт 3005)");
        }

        private void StartRunner(string nodeArgs, string taskDesc)
        {
            string nodePath = FindNodeExecutable();
            if (string.IsNullOrEmpty(nodePath))
            {
                MessageBox.Show("Node.js 20+ не обнаружен в системе. Пожалуйста, установите Node.js с официального сайта https://nodejs.org", "Node.js не найден", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string scriptPath = Path.Combine(toolRoot, "bin", "site-blueprint.mjs");
            if (!File.Exists(scriptPath))
            {
                MessageBox.Show("Файл bin/site-blueprint.mjs не найден в директории:\n" + toolRoot, "Ошибка", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            btnStart.Visible = false;
            btnStop.Visible = true;
            progressBar.Visible = true;
            lblStatus.Text = taskDesc + "...";
            rtbLog.Clear();
            AppendLog("▶ Запуск: " + taskDesc, Color.FromArgb(167, 139, 250));

            try
            {
                currentProcess = new Process();
                currentProcess.StartInfo.FileName = nodePath;
                currentProcess.StartInfo.Arguments = nodeArgs;
                currentProcess.StartInfo.WorkingDirectory = toolRoot;
                currentProcess.StartInfo.UseShellExecute = false;
                currentProcess.StartInfo.RedirectStandardOutput = true;
                currentProcess.StartInfo.RedirectStandardError = true;
                currentProcess.StartInfo.CreateNoWindow = true;
                currentProcess.StartInfo.StandardOutputEncoding = Encoding.UTF8;
                currentProcess.StartInfo.StandardErrorEncoding = Encoding.UTF8;
                currentProcess.EnableRaisingEvents = true;

                currentProcess.OutputDataReceived += (s, ev) => {
                    if (ev.Data != null) SafeLog(ev.Data);
                };
                currentProcess.ErrorDataReceived += (s, ev) => {
                    if (ev.Data != null) SafeLog(ev.Data, Color.FromArgb(244, 63, 94)); // Rose 500
                };
                currentProcess.Exited += (s, ev) => {
                    this.BeginInvoke((Action)(() => {
                        int code = 0;
                        try { code = currentProcess.ExitCode; } catch { }
                        btnStart.Visible = true;
                        btnStop.Visible = false;
                        progressBar.Visible = false;
                        if (code == 0)
                        {
                            lblStatus.Text = "Готово! Результаты сохранены в output/";
                            AppendLog("\n✓ Процесс успешно завершён (код 0). Результат готов!", Color.FromArgb(52, 211, 153));
                        }
                        else
                        {
                            lblStatus.Text = "Завершено с ошибкой (код " + code + ")";
                            AppendLog(string.Format("\n✖ Процесс завершён с кодом {0}.", code), Color.FromArgb(248, 113, 113));
                        }
                        currentProcess = null;
                    }));
                };

                currentProcess.Start();
                currentProcess.BeginOutputReadLine();
                currentProcess.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                btnStart.Visible = true;
                btnStop.Visible = false;
                progressBar.Visible = false;
                lblStatus.Text = "Ошибка запуска";
                AppendLog("Ошибка запуска: " + ex.Message, Color.Red);
                currentProcess = null;
            }
        }

        private void BtnStop_Click(object sender, EventArgs e)
        {
            if (currentProcess != null && !currentProcess.HasExited)
            {
                try
                {
                    currentProcess.Kill();
                    AppendLog("⏹ Процесс остановлен пользователем.", Color.Orange);
                }
                catch (Exception ex)
                {
                    AppendLog("Не удалось остановить процесс: " + ex.Message, Color.Red);
                }
            }
        }

        private static readonly Regex AnsiRegex = new Regex(@"\x1B\[[0-9;]*[a-zA-Z]");

        private void SafeLog(string rawLine, Color? overrideColor = null)
        {
            if (this.IsDisposed || !this.IsHandleCreated) return;
            this.BeginInvoke((Action)(() => {
                string line = AnsiRegex.Replace(rawLine, "");
                Color col = overrideColor ?? Color.FromArgb(228, 228, 231);

                if (!overrideColor.HasValue)
                {
                    if (line.Contains("✓") || line.Contains("Готово")) col = Color.FromArgb(52, 211, 153); // Emerald
                    else if (line.Contains("▶") || line.Contains("•")) col = Color.FromArgb(96, 165, 250); // Sky
                    else if (line.Contains("!") || line.Contains("warn")) col = Color.FromArgb(251, 191, 36); // Amber
                    else if (line.Contains("✖") || line.Contains("error") || line.Contains("Error")) col = Color.FromArgb(248, 113, 113); // Rose
                    else if (line.Contains("http://") || line.Contains("https://")) col = Color.FromArgb(167, 139, 250); // Violet
                }

                AppendLog(line, col);
            }));
        }

        private void AppendLog(string text, Color color)
        {
            rtbLog.SelectionStart = rtbLog.TextLength;
            rtbLog.SelectionLength = 0;
            rtbLog.SelectionColor = color;
            rtbLog.AppendText(text + Environment.NewLine);
            rtbLog.ScrollToCaret();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (currentProcess != null && !currentProcess.HasExited)
            {
                try { currentProcess.Kill(); } catch { }
            }
            base.OnFormClosing(e);
        }
    }
}
