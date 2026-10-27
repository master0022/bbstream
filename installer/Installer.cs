using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading.Tasks;

namespace BBStreamSetup
{
    /// <summary>
    /// Installs BBStream into Discord the way Vencord's own installer does: the Vencord build and
    /// StreamerV2 go to %APPDATA%\BBStream, and Discord's resources\app.asar is swapped for a tiny
    /// asar that loads our patcher.js (the original stays next to it as _app.asar). Vencord then
    /// keeps itself injected across Discord updates and updates itself from this repo's releases.
    /// </summary>
    public static class Installer
    {
        public const string Repo = "master0022/bbstream";
        /// <summary>BBSTREAM_RELEASE_BASE points at another copy of the release files (a folder works too, as file:///…/).</summary>
        static readonly string ReleaseBase = Environment.GetEnvironmentVariable("BBSTREAM_RELEASE_BASE") ?? "https://github.com/" + Repo + "/releases/latest/download/";
        static readonly string[] DistFiles = { "patcher.js", "preload.js", "renderer.js", "renderer.css" };
        const string StreamerZip = "StreamerV2-win-x64.zip";
        const string StreamerVersionFile = "streamer-version.txt";
        static readonly string[] Flavors = { "Discord", "DiscordPTB", "DiscordCanary" };

        public static string Root => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BBStream");
        static string Dist => Path.Combine(Root, "dist");
        static string StreamerDir => Path.Combine(Root, "StreamerV2");
        static string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        public delegate void Progress(string text, int percent);

        /// <summary>Discord installs (stable, PTB, Canary) found for this Windows user.</summary>
        public static List<string> FindDiscords() =>
            Flavors.Select(f => Path.Combine(LocalAppData, f)).Where(d => LatestApp(d) != null).ToList();

        public static bool IsInstalled() =>
            File.Exists(Path.Combine(Dist, "patcher.js")) && FindDiscords().Any(d => IsShim(Path.Combine(LatestApp(d), "resources", "app.asar")));

        public static void Install(Progress progress)
        {
            var discords = FindDiscords();
            if (discords.Count == 0)
                throw new UserError("Não encontrei o Discord neste PC. Instale o Discord (discord.com) e rode o instalador de novo.");

            // Everything is downloaded before Discord is touched, so a failed download changes nothing.
            var staging = Path.Combine(Root, "download");
            Directory.CreateDirectory(staging);
            using (var web = NewClient())
            {
                for (var i = 0; i < DistFiles.Length; i++)
                {
                    progress("Baixando o BBStream…", 2 + i * 2);
                    web.DownloadFile(ReleaseBase + DistFiles[i], Path.Combine(staging, DistFiles[i]));
                }
            }

            string streamerVersion;
            using (var web = NewClient())
                streamerVersion = web.DownloadString(ReleaseBase + StreamerVersionFile).Trim();
            var versionPath = Path.Combine(StreamerDir, "version.txt");
            var haveStreamer = File.Exists(Path.Combine(StreamerDir, "StreamerV2.exe")) &&
                               File.Exists(versionPath) && File.ReadAllText(versionPath).Trim() == streamerVersion;
            var zipPath = Path.Combine(staging, StreamerZip);
            if (!haveStreamer)
                Download(ReleaseBase + StreamerZip, zipPath, p => progress("Baixando o StreamerV2…", 10 + p * 70 / 100));

            progress("Fechando o Discord…", 82);
            var running = CloseDiscord();
            StopStreamer();

            progress("Instalando…", 86);
            Directory.CreateDirectory(Dist);
            foreach (var file in DistFiles)
                Replace(Path.Combine(staging, file), Path.Combine(Dist, file));
            if (!haveStreamer)
            {
                Extract(zipPath, Root);
                File.WriteAllText(versionPath, streamerVersion);
            }
            TryDelete(staging);

            progress("Conectando ao Discord…", 94);
            foreach (var discord in discords)
                Patch(LatestApp(discord));

            progress("Abrindo o Discord…", 98);
            StartDiscord(running.Count > 0 ? running : discords.Take(1));
            progress("Pronto! O BBStream está instalado.", 100);
        }

        public static void Uninstall(Progress progress)
        {
            progress("Fechando o Discord…", 20);
            var running = CloseDiscord();
            StopStreamer();

            progress("Restaurando o Discord original…", 50);
            var discords = FindDiscords();
            foreach (var discord in discords)
                foreach (var app in Directory.GetDirectories(discord, "app-*"))
                    Unpatch(app);

            progress("Removendo arquivos…", 80);
            TryDelete(Root);

            StartDiscord(running.Count > 0 ? running : discords.Take(1));
            progress("O BBStream foi removido.", 100);
        }

        // --- Discord ----------------------------------------------------------------------

        /// <summary>The newest app-x.y.z folder, the one Discord's Update.exe launches.</summary>
        static string LatestApp(string discordRoot)
        {
            if (!Directory.Exists(discordRoot)) return null;
            return Directory.GetDirectories(discordRoot, "app-*")
                .Where(d => File.Exists(Path.Combine(d, "resources", "app.asar")) || File.Exists(Path.Combine(d, "resources", "_app.asar")))
                .OrderByDescending(d => ParseVersion(Path.GetFileName(d).Substring(4)))
                .FirstOrDefault();
        }

        static Version ParseVersion(string text) => Version.TryParse(text, out var v) ? v : new Version(0, 0);

        static void Patch(string appDir)
        {
            var resources = Path.Combine(appDir, "resources");
            var asar = Path.Combine(resources, "app.asar");
            var original = Path.Combine(resources, "_app.asar");
            if (File.Exists(asar) && !IsShim(asar))
            {
                if (File.Exists(original)) File.Delete(original);
                File.Move(asar, original);
            }
            if (!File.Exists(original))
                throw new UserError("O Discord em " + appDir + " parece incompleto (falta o app.asar). Reinstale o Discord e tente de novo.");
            File.WriteAllBytes(asar, Shim(Path.Combine(Dist, "patcher.js")));
        }

        static void Unpatch(string appDir)
        {
            var resources = Path.Combine(appDir, "resources");
            var asar = Path.Combine(resources, "app.asar");
            var original = Path.Combine(resources, "_app.asar");
            if (!File.Exists(original)) return;
            if (File.Exists(asar)) File.Delete(asar);
            File.Move(original, asar);
        }

        /// <summary>Our loader (and Vencord's) is a few hundred bytes; Discord's real app.asar is megabytes.</summary>
        static bool IsShim(string asar) => File.Exists(asar) && new FileInfo(asar).Length < 16 * 1024;

        /// <summary>
        /// An asar archive holding index.js = require("…\patcher.js") and a package.json pointing at it.
        /// Layout: uint32 4, uint32 header size, then the header as a Chromium pickle
        /// (uint32 payload size, uint32 json length, json padded to 4 bytes), then the file bytes.
        /// </summary>
        static byte[] Shim(string patcher)
        {
            var index = Encoding.UTF8.GetBytes("require(\"" + patcher.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\")");
            var package = Encoding.UTF8.GetBytes("{\"name\":\"discord\",\"main\":\"index.js\"}");
            var header = Encoding.UTF8.GetBytes(
                "{\"files\":{\"index.js\":{\"size\":" + index.Length + ",\"offset\":\"0\"}," +
                "\"package.json\":{\"size\":" + package.Length + ",\"offset\":\"" + index.Length + "\"}}}");
            var padded = (header.Length + 3) & ~3;
            using (var ms = new MemoryStream())
            using (var w = new BinaryWriter(ms))
            {
                w.Write(4u);
                w.Write((uint)(padded + 8));
                w.Write((uint)(padded + 4));
                w.Write((uint)header.Length);
                w.Write(header);
                w.Write(new byte[padded - header.Length]);
                w.Write(index);
                w.Write(package);
                w.Flush();
                return ms.ToArray();
            }
        }

        /// <summary>Closes every Discord and returns the flavors that were open, to reopen them after.</summary>
        static List<string> CloseDiscord()
        {
            var running = new List<string>();
            foreach (var flavor in Flavors)
            {
                var processes = Process.GetProcessesByName(flavor);
                if (processes.Length > 0) running.Add(Path.Combine(LocalAppData, flavor));
                foreach (var p in processes)
                {
                    try { p.Kill(); } catch (Win32Exception) { } catch (InvalidOperationException) { }
                }
                foreach (var p in processes)
                {
                    try { p.WaitForExit(10000); } catch (InvalidOperationException) { }
                    p.Dispose();
                }
            }
            return running;
        }

        static void StopStreamer()
        {
            foreach (var p in Process.GetProcessesByName("StreamerV2"))
            {
                try
                {
                    var path = p.MainModule?.FileName ?? "";
                    if (path.StartsWith(StreamerDir, StringComparison.OrdinalIgnoreCase))
                    {
                        p.Kill();
                        p.WaitForExit(10000);
                    }
                }
                catch (Exception e) when (e is Win32Exception || e is InvalidOperationException) { }
                finally { p.Dispose(); }
            }
        }

        static void StartDiscord(IEnumerable<string> discordRoots)
        {
            // Discord.exe itself rather than Update.exe --processStart: Windows may treat a program
            // named "Update" as an installer and ask for admin. Discord checks for updates on its own.
            foreach (var root in discordRoots)
            {
                var app = LatestApp(root);
                var exe = app == null ? null : Path.Combine(app, Path.GetFileName(root) + ".exe");
                if (exe == null || !File.Exists(exe)) continue;
                try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = app }); }
                catch (Win32Exception) { }
            }
        }

        // --- files ------------------------------------------------------------------------

        static WebClient NewClient()
        {
            var web = new WebClient();
            web.Headers[HttpRequestHeader.UserAgent] = "BBStreamSetup";
            return web;
        }

        static void Download(string url, string path, Action<int> onPercent)
        {
            using (var web = NewClient())
            {
                web.DownloadProgressChanged += (_, e) => onPercent(e.ProgressPercentage);
                web.DownloadFileTaskAsync(url, path).GetAwaiter().GetResult();
            }
        }

        static void Replace(string from, string to)
        {
            if (File.Exists(to)) File.Delete(to);
            File.Move(from, to);
        }

        /// <summary>Unzips over what's there, so StreamerV2's saved settings survive an update.</summary>
        static void Extract(string zip, string into)
        {
            var root = Path.GetFullPath(into) + Path.DirectorySeparatorChar;
            using (var archive = ZipFile.OpenRead(zip))
            {
                foreach (var entry in archive.Entries)
                {
                    var target = Path.GetFullPath(Path.Combine(into, entry.FullName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    if (entry.FullName.EndsWith("/"))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
        }

        static void TryDelete(string path)
        {
            try { if (Directory.Exists(path)) Directory.Delete(path, true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>A failure with a message meant for the person installing.</summary>
    public class UserError : Exception
    {
        public UserError(string message) : base(message) { }
    }
}
