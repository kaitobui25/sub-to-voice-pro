using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

class VieNeuNativeHost
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    static void Main()
    {
        try
        {
            var input = Console.OpenStandardInput();
            var sizeBytes = ReadExactly(input, 4);
            int size = BitConverter.ToInt32(sizeBytes, 0);
            if (size < 1 || size > 65536) throw new Exception("Invalid native message length.");
            var message = Json.DeserializeObject(Encoding.UTF8.GetString(ReadExactly(input, size))) as System.Collections.Generic.Dictionary<string, object>;
            if (message == null || !message.ContainsKey("action") || (string)message["action"] != "start")
                throw new Exception("Unsupported native action.");

            var script = File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "vieneu-start-script.txt")).Trim();
            if (!File.Exists(script)) throw new Exception("VieNeu start script is missing.");
            var info = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
            info.UseShellExecute = true;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            using (var process = Process.Start(info))
            {
                if (!process.WaitForExit(15000)) throw new Exception("VieNeu launcher did not finish within 15 seconds.");
                if (process.ExitCode != 0) throw new Exception("VieNeu launcher failed. Run npm run vieneu:start to see the error.");
            }

            var deadline = DateTime.UtcNow.AddSeconds(90);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    using (var client = new WebClient())
                    {
                        var health = Json.DeserializeObject(client.DownloadString("http://127.0.0.1:8000/health")) as System.Collections.Generic.Dictionary<string, object>;
                        if (health != null && health.ContainsKey("status") && (string)health["status"] == "ok")
                        {
                            Reply(new { ok = true });
                            return;
                        }
                    }
                }
                catch (WebException) { }
                System.Threading.Thread.Sleep(1000);
            }
            throw new Exception("VieNeu did not become healthy within 90 seconds. Check artifacts/vieneu-server.err.log.");
        }
        catch (Exception error)
        {
            Reply(new { ok = false, error = error.Message });
        }
    }

    static byte[] ReadExactly(Stream stream, int count)
    {
        var bytes = new byte[count];
        int read = 0;
        while (read < count)
        {
            int next = stream.Read(bytes, read, count - read);
            if (next == 0) throw new EndOfStreamException();
            read += next;
        }
        return bytes;
    }

    static void Reply(object value)
    {
        var bytes = Encoding.UTF8.GetBytes(Json.Serialize(value));
        var output = Console.OpenStandardOutput();
        var length = BitConverter.GetBytes(bytes.Length);
        output.Write(length, 0, length.Length);
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }
}
