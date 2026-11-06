using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace SiteBlueprintCli
{
    class Program
    {
        static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
                Console.InputEncoding = Encoding.UTF8;
            }
            catch { }

            string toolRoot = ResolveToolRoot();
            string scriptPath = Path.Combine(toolRoot, "bin", "site-blueprint.mjs");
            if (!File.Exists(scriptPath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Ошибка: не найден рабочий скрипт: " + scriptPath);
                Console.ResetColor();
                WaitOnExit(args);
                return 1;
            }

            string nodePath = FindNodeExecutable();
            if (string.IsNullOrEmpty(nodePath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Ошибка: Node.js (node.exe) не найден в PATH или стандартных папках.");
                Console.WriteLine("Установите Node.js 20.12+ с сайта https://nodejs.org/");
                Console.ResetColor();
                WaitOnExit(args);
                return 1;
            }

            // Build arguments for node
            StringBuilder sb = new StringBuilder();
            sb.AppendFormat("\"{0}\"", scriptPath);
            foreach (var arg in args)
            {
                sb.Append(" ");
                if (arg.Contains(" ") || arg.Contains("\""))
                    sb.AppendFormat("\"{0}\"", arg.Replace("\"", "\\\""));
                else
                    sb.Append(arg);
            }

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = sb.ToString(),
                WorkingDirectory = toolRoot,
                UseShellExecute = false
            };

            try
            {
                using (Process proc = Process.Start(psi))
                {
                    proc.WaitForExit();
                    int code = proc.ExitCode;
                    WaitOnExit(args);
                    return code;
                }
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("Ошибка запуска: " + ex.Message);
                Console.ResetColor();
                WaitOnExit(args);
                return 1;
            }
        }

        private static void WaitOnExit(string[] args)
        {
            if (args.Length == 0)
            {
                try
                {
                    Console.WriteLine("\n[Нажмите Enter для завершения]");
                    Console.ReadLine();
                }
                catch { }
            }
        }

        private static string ResolveToolRoot()
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

        private static string FindNodeExecutable()
        {
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
    }
}
