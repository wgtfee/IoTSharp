using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.EventLog;
using Figgle;
using Figgle.Fonts;
using LettuceEncrypt;
using LettuceEncrypt.Dns.Ali;
using System.Net;

namespace IoTSharp
{
    public class Program
    {
        public static void Main(string[] args)
        {
            InitializeProcessPaths();
            Console.WriteLine(FiggleFonts.Doom.Render("IoTSharp"));
            CreateHostBuilder(args).Build().Run();
        }

        public static IHostBuilder CreateHostBuilder(string[] args) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureLogging(logging =>
                {
                    if (!HostExtension.ShouldUseWindowsService())
                        logging.AddFilter<EventLogLoggerProvider>(level => false);
                })
                .UseContentRoot(AppContext.BaseDirectory)
                .ConfigureAppConfiguration((hostingContext, configuration) =>
                {
                    var environmentName = hostingContext.HostingEnvironment.EnvironmentName;
                    configuration.AddJsonFile("appsettings.Installer.json", optional: true, reloadOnChange: false);
                    configuration.AddJsonFile($"appsettings.{environmentName}.Installer.json", optional: true, reloadOnChange: false);

                    // IAM migration is independent from ASPNETCORE_ENVIRONMENT. This lets
                    // operators switch Local -> IamPrepare -> Shadow without changing
                    // database, diagnostics or other environment-specific behavior.
                    var profile = Environment.GetEnvironmentVariable("INDUSTRIAL_SECURITY_PROFILE")?.Trim();
                    if (!string.IsNullOrWhiteSpace(profile))
                    {
                        if (!new[] { "IamPrepare", "Shadow", "Centralized" }.Contains(profile, StringComparer.OrdinalIgnoreCase))
                            throw new InvalidOperationException($"Unsupported INDUSTRIAL_SECURITY_PROFILE '{profile}'.");

                        configuration.AddJsonFile($"appsettings.{profile}.json", optional: false, reloadOnChange: true);
                    }

                    // Environment variables stay highest priority so secrets and emergency
                    // rollback switches never need to be committed to a profile file.
                    configuration.AddEnvironmentVariables();
                })
                .ConfigureWindowsServices()
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseStartup<Startup>();
                    webBuilder.UseKestrel((context, options) =>
                    {
                        var appServices = options.ApplicationServices;
                        var hostOptions = new IoTSharpHostOptions();
                        context.Configuration.Bind(hostOptions);
                        if (hostOptions.IOTSHARP_ACME)
                            ConfigureAcmeEndpoints(options, appServices, hostOptions);
                    });
                });

        private static void ConfigureAcmeEndpoints(KestrelServerOptions options, IServiceProvider appServices, IoTSharpHostOptions hostOptions)
        {
            var urls = hostOptions.ASPNETCORE_URLS;
            if (!string.IsNullOrWhiteSpace(urls))
            {
                foreach (var url in urls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                {
                    if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
                        ConfigureListenEndpoint(options, uri, appServices);
                }
                return;
            }

            foreach (var port in GetConfiguredPorts(hostOptions.ASPNETCORE_HTTP_PORTS))
                options.ListenAnyIP(port);

            foreach (var port in GetConfiguredPorts(hostOptions.ASPNETCORE_HTTPS_PORTS))
            {
                options.ListenAnyIP(port, listenOptions =>
                {
                    listenOptions.UseHttps(httpsOptions =>
                    {
                        httpsOptions.ClientCertificateMode = ClientCertificateMode.RequireCertificate;
                    });
                    listenOptions.UseLettuceEncrypt(appServices);
                });
            }
        }

        private static IEnumerable<int> GetConfiguredPorts(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return Enumerable.Empty<int>();

            return value.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(segment => int.TryParse(segment, out var port) ? port : (int?)null)
                .Where(port => port.HasValue)
                .Select(port => port!.Value);
        }

        private static void ConfigureListenEndpoint(KestrelServerOptions options, Uri uri, IServiceProvider appServices)
        {
            var listen = CreateListenAction(uri, appServices);
            if (string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
            {
                options.ListenLocalhost(uri.Port, listen);
                return;
            }
            if (IPAddress.TryParse(uri.Host, out var address))
            {
                options.Listen(address, uri.Port, listen);
                return;
            }
            options.ListenAnyIP(uri.Port, listen);
        }

        private static Action<ListenOptions> CreateListenAction(Uri uri, IServiceProvider appServices) =>
            string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                ? listenOptions =>
                {
                    listenOptions.UseHttps(httpsOptions =>
                    {
                        httpsOptions.ClientCertificateMode = ClientCertificateMode.RequireCertificate;
                    });
                    listenOptions.UseLettuceEncrypt(appServices);
                }
                : _ => { };

        private static void InitializeProcessPaths()
        {
            var baseDirectory = AppContext.BaseDirectory;
            if (!string.IsNullOrWhiteSpace(baseDirectory))
                Directory.SetCurrentDirectory(baseDirectory);
        }
    }
}
