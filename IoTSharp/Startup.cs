using EasyCaching.Core.Configurations;
using HealthChecks.UI.Client;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Data.Extensions;
using IoTSharp.Data.SonnetDB;
using IoTSharp.Data.TimeSeries;
using IoTSharp.EventBus;
using IoTSharp.EventBus.CAP;
using IoTSharp.EventBus.SonnetMQ;
using IoTSharp.FlowRuleEngine;
using IoTSharp.Gateways;
using IoTSharp.Interpreter;
using IoTSharp.McpTools;
using IoTSharp.Services;
using IoTSharp.Services.Coap;
using IoTSharp.TaskActions;
using IoTSharp.IndustrialSecurity;
using Industrial.Security.Abstractions;
using Industrial.Security.AspNetCore;
using Industrial.Health;
using IoTSharp.Health;
using IoTSharp.Services.DigitalTwin;
using Jdenticon.AspNetCore;
using Jdenticon.Rendering;
using LettuceEncrypt;
using LettuceEncrypt.Dns.Ali;
using MaiKeBing.HostedService.ZeroMQ;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using MQTTnet.AspNetCore;
using Quartz;
using Quartz.AspNetCore;
using Storage.Net;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;

namespace IoTSharp
{
    public class Startup
    {
        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
        }

        public IConfiguration Configuration { get; private set; }

        // This method gets called by the runtime. Use this method to add services to the container.
        public void ConfigureServices(IServiceCollection services)
        {
            if (Configuration.GetValue("Security:DataProtection:UseLocalKeys", false))
            {
                var keyDirectory = Path.Combine(AppContext.BaseDirectory, "data-protection-keys");
                services.AddDataProtection()
                    .SetApplicationName("IoTSharp")
                    .PersistKeysToFileSystem(new DirectoryInfo(keyDirectory));
            }

            services.AddHttpContextAccessor();
            services.AddIndustrialSecurity(Configuration);
            // Generate the IAM permission manifest from the IotPermissionResource table
            // (real catalog) instead of the static permission-manifest.json file.
            if (Configuration.GetValue("Security:ResourceSync:Enabled", false))
            {
                services.AddHostedService<IotPermissionManifestHostedService>();
            }
            services.AddScoped<IoTSharpCurrentUser>();
            services.AddScoped<ICurrentUser>(sp => sp.GetRequiredService<IoTSharpCurrentUser>());
            services.AddScoped<IIdentityProvider, IoTSharpIdentityProvider>();
            services.AddScoped<IShadowUserResolver, IoTSharpShadowUserResolver>();
            services.AddScoped<ILocalPermissionSource, IoTSharpLocalPermissionSource>();
            services.AddScoped<IPermissionCodeMapper, IoTSharpPermissionCodeMapper>();
            services.AddScoped<IUserPermissionProvider, IoTSharpLocalPermissionProvider>();
            services.AddScoped<IPermissionProvider, IoTSharpLocalPermissionProvider>();
            System.Text.Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            var settings = new AppSettings();
            Configuration.Bind(settings);
            var hostOptions = new IoTSharpHostOptions();
            Configuration.Bind(hostOptions);
            services.Configure<HostOptions>(options =>
            {
                options.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore;
            });
            services.Configure<AppSettings>(setting => Configuration.Bind(setting));
            var healthChecksUI = services.AddHealthChecksUI(setup =>
            {
                setup.SetHeaderText("IoTSharp HealthChecks");
                setup.MaximumHistoryEntriesPerEndpoint(50);
                setup.AddIoTSharpHealthCheckEndpoint(hostOptions);
            });

            var healthChecks = services.AddHealthChecks()
                .AddDiskStorageHealthCheck(dso =>
                {
                    System.IO.DriveInfo.GetDrives()
                        .Where(d => d.DriveType == System.IO.DriveType.Fixed && d.DriveFormat != "overlay" && !d.Name.StartsWith("/sys"))
                        .Select(f => f.Name).Distinct().ToList()
                        .ForEach(f => dso.AddDrive(f));
                }, name: "Disk Storage");

            switch (settings.DataBase)
            {
                case DataBaseType.MySql:
                    services.ConfigureMySql(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    break;
                case DataBaseType.SqlServer:
                    services.ConfigureSqlServer(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    break;
                case DataBaseType.Oracle:
                    services.ConfigureOracle(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    break;
                case DataBaseType.Sqlite:
                    services.ConfigureSqlite(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    break;
                case DataBaseType.InMemory:
                    services.ConfigureInMemory(settings.DbContextPoolSize, healthChecksUI);
                    settings.TelemetryStorage = TelemetryStorage.SingleTable;
                    break;
                case DataBaseType.ClickHouse:
                    services.ConfigureClickHouse(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    settings.TelemetryStorage = TelemetryStorage.SingleTable;
                    break;
                case DataBaseType.SonnetDB:
                    services.ConfigureSonnetDB(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    break;
                case DataBaseType.PostgreSql:
                default:
                    services.ConfigureNpgsql(GetConnectionString(settings, "IoTSharp"), settings.DbContextPoolSize, healthChecks, healthChecksUI);
                    break;
            }
            services.AddDatabaseDeveloperPageExceptionFilter();
            services.AddIdentity<IdentityUser, IdentityRole>()
                .AddRoles<IdentityRole>()
                .AddRoleManager<RoleManager<IdentityRole>>()
                .AddDefaultTokenProviders()
                .AddEntityFrameworkStores<ApplicationDbContext>();

            var centralizedAuthentication = Configuration.GetValue<string>("Security:Authentication:Mode")
                ?.Equals("Centralized", StringComparison.OrdinalIgnoreCase) == true;
            services.AddAuthentication(option =>
            {
                option.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                option.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
                option.DefaultScheme = JwtBearerDefaults.AuthenticationScheme;
            }).AddJwtBearer(options =>
            {
                options.SaveToken = true;
                if (centralizedAuthentication)
                {
                    options.Authority = Configuration["Security:Central:Authority"] ?? "http://localhost:5100";
                    options.Audience = Configuration["Security:Central:Audience"] ?? "industrial-platform";
                    options.RequireHttpsMetadata = false;
                    // Load signing keys directly from the IAM jwks endpoint. Relying on
                    // metadata discovery can yield zero SigningKeys (jwks_uri resolution
                    // against an http authority), which makes every token fail IDX10500.
                    try
                    {
                        var authority = options.Authority.TrimEnd('/');
                        var retriever = new Microsoft.IdentityModel.Protocols.HttpDocumentRetriever { RequireHttps = false };
                        var jwksDoc = retriever.GetDocumentAsync(authority + "/.well-known/jwks", System.Threading.CancellationToken.None).GetAwaiter().GetResult();
                        var signingKeys = new Microsoft.IdentityModel.Tokens.JsonWebKeySet(jwksDoc).Keys;
                        options.TokenValidationParameters = new TokenValidationParameters
                        {
                            IssuerSigningKeys = signingKeys,
                            ValidAudience = options.Audience,
                            ValidateIssuer = false,
                            ValidateLifetime = true,
                            ClockSkew = TimeSpan.FromMinutes(1)
                        };
                        Console.WriteLine($"[JwtBearerMeta] Direct Jwks loaded. keys={signingKeys.Count}");
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[JwtBearerMeta] FAILED: {ex.GetType().Name}: {ex.Message}");
                    }
                }
                else options.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidateAudience = true,
                    ValidateLifetime = true,
                    RequireExpirationTime = true,
                    RequireSignedTokens = true,
                    ValidateIssuerSigningKey = true,
                    ValidIssuer = RequireSetting(settings.JwtIssuer, nameof(AppSettings.JwtIssuer)),
                    ValidAudience = RequireSetting(settings.JwtAudience, nameof(AppSettings.JwtAudience)),
                    IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(RequireSetting(settings.JwtKey, nameof(AppSettings.JwtKey))))
                };
            });

            services.AddCors();
            services.AddLogging(loggingBuilder =>
                {
                    loggingBuilder.AddRinLogger();
                    loggingBuilder.AddPrettyConsole();
                }
            );
            services.AddRin();
            services.AddOpenApiDocument(configure =>
            {
                Assembly assembly = typeof(Startup).GetTypeInfo().Assembly;
                var description = (AssemblyDescriptionAttribute)Attribute.GetCustomAttribute(assembly, typeof(AssemblyDescriptionAttribute));
                configure.Title = assembly.GetName().Name;
                configure.Version = assembly.GetName().Version.ToString();
                configure.Description = description?.Description;
                configure.AddJWTSecurity();
            });

            services.AddTransient<ApplicationDBInitializer>();
            services.AddScoped<DigitalTwinSceneService>();
            services.AddScoped<TwinModelResourceService>();
            services.Configure<TwinModelGenerationOptions>(Configuration.GetSection("DigitalTwin:ModelGeneration"));
            services.AddScoped<TwinModelGenerationService>();
            services.AddHttpClient<Img2ThreeJsGenerationClient>();
            services.AddHostedService<Img2ThreeJsGenerationWorker>();
            services.AddScoped<TwinRuntimeSnapshotService>();
            services.AddIoTSharpMqttServer(settings.MqttBroker);
            services.AddMqttClient(settings.MqttClient);
            services.AddQuartz(q =>
            {
                q.DiscoverJobs();
            });

            services.AddQuartzServer(options =>
            {
                options.StartDelay = TimeSpan.FromSeconds(10);
                options.WaitForJobsToComplete = true;
            });
            services.AddResponseCompression();
            services.AddControllers().AddJsonOptions(options =>
            {
                options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
                options.JsonSerializerOptions.NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString;
            });

            services.AddMemoryCache();
            string _hc_Caching = $"{nameof(CachingUseIn)}-{Enum.GetName(settings.CachingUseIn)}";
            services.AddEasyCaching(options =>
            {
                switch (settings.CachingUseIn)
                {
                    case CachingUseIn.Redis:
                        options.UseRedis(config =>
                        {
                            settings.CachingUseRedisHosts?.Split(';').ToList().ForEach(h =>
                            {
                                var hx = h.Split(':');
                                config.DBConfig.Endpoints.Add(new ServerEndPoint(hx[0], int.Parse(hx[1])));
                            });
                        }, "iotsharp");
                        healthChecks.AddRedis(settings.CachingUseRedisHosts, name: _hc_Caching);
                        break;
                    case CachingUseIn.LiteDB:
                        options.UseLiteDB(cfg => cfg.DBConfig = new EasyCaching.LiteDB.LiteDBDBOptions() { }, name: _hc_Caching);
                        break;
                    case CachingUseIn.SonnetDB:
                        options.UseSonnetDB(config =>
                        {
                            config.ConnectionString = !string.IsNullOrWhiteSpace(settings.CachingUseSonnetDBConnectionString)
                                ? settings.CachingUseSonnetDBConnectionString
                                : GetConnectionString(settings, "TelemetryStorage") ?? string.Empty;
                            config.Keyspace = settings.CachingUseSonnetDBKeyspace;
                            config.Namespace = settings.CachingUseSonnetDBNamespace;
                        }, _hc_Caching);
                        break;
                    case CachingUseIn.InMemory:
                    default:
                        options.UseInMemory(_hc_Caching);
                        break;
                }
            });
            services.AddTelemetryStorage(settings, healthChecks);
            var zmqSection = Configuration.GetSection(nameof(ZMQOption));
            if (zmqSection.Exists())
            {
                services.AddHostedZeroMQ(options => zmqSection.Bind(options));
            }
            services.AddEventBus(opt =>
            {
                opt.AppSettings = settings;
                opt.EventBusStore = GetConnectionString(settings, "EventBusStore");
                opt.EventBusMQ = GetConnectionString(settings, "EventBusMQ");
                opt.HealthChecks = healthChecks;
                switch (settings.EventBus)
                {
                    case EventBusFramework.Shashlik:
                        throw new NotSupportedException(" EventBusFramework.Shashlik is not supported yet");
                    case EventBusFramework.SonnetMQ:
                        opt.UseSonnetMQ();
                        break;
                    case EventBusFramework.CAP:
                    default:
                        opt.UserCAP();
                        break;
                }
            });
            if (Configuration.GetValue("CoapServer:Enabled", false))
            {
                services.AddCoapServer(Configuration.GetSection("CoapServer"));
                services.AddIoTSharpCoapResources();
            }
            services.AddTransient(_ =>
            {
                var blobStorage = GetConnectionString(settings, "BlobStorage");
                if (!string.IsNullOrWhiteSpace(blobStorage)
                    && blobStorage.StartsWith("sonnetdb://", StringComparison.OrdinalIgnoreCase))
                {
                    var parsed = SonnetDbBlobStorage.ParseConnectionString(blobStorage);
                    return new SonnetDbBlobStorage(parsed.ConnectionString, parsed.Bucket);
                }
                if (string.IsNullOrWhiteSpace(blobStorage))
                    blobStorage = $"disk://path={Environment.GetFolderPath(Environment.SpecialFolder.UserProfile, Environment.SpecialFolderOption.Create)}/IoTSharp/";
                return StorageFactory.Blobs.FromConnectionString(blobStorage);
            });

            services.AddRazorPages();
            services.AddScriptEngines(Configuration.GetSection("EngineSetting"));
            services.AddTransient<FlowRuleProcessor>();
            services.AddTransient<CustomeAlarmPullExcutor>();
            services.AddSingleton<TaskExecutorHelper>();
            services.AddTransient<PublishAttributeDataTask>();
            services.AddTransient<PublishTelemetryDataTask>();
            services.AddTransient<PublishAlarmDataTask>();
            services.AddTransient<RawDataGateway>();
            services.AddTransient<KepServerEx>();

            if (hostOptions.IOTSHARP_ACME)
            {
                services.AddLettuceEncrypt()
                        .PersistDataToDirectory(new DirectoryInfo(Path.Combine(AppContext.BaseDirectory, "security")), "kissme")
                        .Services.AddAliDnsChallengeProvider();
                services.AddHsts(options =>
                {
                    options.Preload = true;
                    options.IncludeSubDomains = true;
                    options.MaxAge = TimeSpan.FromDays(60);
                });
            }

            services.AddMcpServer()
             .WithHttpTransport(options =>
             {
                 options.ConfigureSessionOptions += async (context, serverOptions, token) =>
                 {
                     var api_key = context.Request.RouteValues["api_key"]?.ToString()?.ToLower() ?? "none";
                     serverOptions.InitializationTimeout = TimeSpan.FromSeconds(600);
                     serverOptions.Capabilities ??= new ServerCapabilities();
                     serverOptions.Capabilities.Experimental ??= new Dictionary<string, object>();
                     serverOptions.Capabilities.Experimental["API_KEY"] = api_key;
                     await Task.CompletedTask;
                 };
                 options.Stateless = true;
             })
             .WithPromptsFromAssembly()
             .WithResourcesFromAssembly()
             .WithToolsFromAssembly();
        }

        private static string RequireSetting(string value, string name)
        {
            if (string.IsNullOrWhiteSpace(value))
                throw new InvalidOperationException($"{name} 未配置。");
            return value;
        }

        private static string GetConnectionString(AppSettings settings, string name)
        {
            if (settings.ConnectionStrings == null)
                return null;
            if (settings.ConnectionStrings.TryGetValue(name, out var connectionString))
                return connectionString;
            return settings.ConnectionStrings
                .FirstOrDefault(item => string.Equals(item.Key, name, StringComparison.OrdinalIgnoreCase))
                .Value;
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            if ((env.IsDevelopment() || !env.IsEnvironment("Production")) && !env.IsEnvironment("Test"))
            {
                app.UseRin();
                app.UseRinMvcSupport();
                app.UseDeveloperExceptionPage();
                app.UseRinDiagnosticsHandler();
            }
            else
            {
                app.UseExceptionHandler("/Home/Error");
                app.UseHsts();
            }

            app.Map("/healthz", healthz =>
            {
                healthz.Run(async context =>
                {
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsync("{\"status\":\"Healthy\",\"totalDuration\":\"00:00:00\",\"entries\":{}}");
                });
            });

            if (Configuration.GetValue("Database:AutoMigrate", true))
                app.CheckApplicationDBMigrations();

            app.UseRouting();
            app.UseCors(option => option
                .AllowAnyOrigin()
                .AllowAnyMethod()
                .AllowAnyHeader());
            app.UseAuthentication();
            // Industrial.Security must resolve local_user_id before ASP.NET role
            // authorization runs. IoTSharp then overlays the bound user's existing
            // roles and Customer/Tenant claims for the current request only.
            app.UseIndustrialSecurity();
            app.UseMiddleware<IoTSharpLocalIdentityOverlayMiddleware>();
            app.UseAuthorization();
            app.UseDefaultFiles();
            app.UseStaticFiles();
            app.UseResponseCompression();
            app.UseIotSharpMqttServer();
            if (Configuration.GetValue("CoapServer:Enabled", false))
                app.UseCoapServer();
            app.UseSwaggerUi();
            app.UseHealthChecksUI();
            app.UseOpenApi();
            app.UseEventBus(opt =>
            {
                var frp = app.ApplicationServices.GetService<FlowRuleProcessor>();
                return frp.RunRules;
            });

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapMqtt("/mqtt");
                endpoints.MapV071Health("iotsharp");
                endpoints.MapHealthChecks("/health/live", new HealthCheckOptions
                {
                    Predicate = _ => false,
                    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
                });
                endpoints.MapHealthChecks("/health/ready", new HealthCheckOptions
                {
                    Predicate = check => check.Tags.Contains("ready"),
                    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
                });
                endpoints.MapHealthChecks("/readyz", new HealthCheckOptions()
                {
                    Predicate = check => check.Tags.Contains("ready"),
                    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
                });
                endpoints.MapHealthChecksUI();
                endpoints.MapControllers();
                endpoints.MapIndustrialSecurityCacheInvalidation();
                endpoints.MapIndustrialLocalUserManagementInfo();
                endpoints.MapIndustrialEmergencyValidation();
                endpoints.MapDefaultControllerRoute();
                endpoints.MapRazorPages();
                endpoints.MapMcp("/mcp/{api_key}");
            });

            app.UseJdenticon(defaultStyle =>
            {
                defaultStyle.Hues = new HueCollection { { 196, HueUnit.Degrees } };
                defaultStyle.BackColor = Color.FromRgba(134, 68, 68, 0);
                defaultStyle.ColorLightness = Jdenticon.Range.Create(0.36f, 0.70f);
                defaultStyle.GrayscaleLightness = Jdenticon.Range.Create(0.24f, 0.82f);
                defaultStyle.ColorSaturation = 0.51f;
                defaultStyle.GrayscaleSaturation = 0.10f;
            });
            app.UseTelemetryStorage();

            var provider = new FileExtensionContentTypeProvider();
            provider.Mappings[".fbx"] = "application/octet-stream";
            provider.Mappings[".glb"] = "application/octet-stream";
            app.Use(async (context, next) =>
            {
                if (ShouldServeSpaFallback(context.Request))
                    context.Request.Path = "/index.html";
                await next();
            });
            app.UseStaticFiles(new StaticFileOptions
            {
                ContentTypeProvider = provider,
            });
        }

        private static bool ShouldServeSpaFallback(HttpRequest request)
        {
            if (!HttpMethods.IsGet(request.Method) && !HttpMethods.IsHead(request.Method))
                return false;

            var path = request.Path;
            var pathValue = path.Value ?? string.Empty;
            if (Path.HasExtension(pathValue))
                return false;

            return !path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/cap", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/healthz", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/readyz", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/mcp", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/mqtt", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/swagger", StringComparison.OrdinalIgnoreCase)
                   && !path.StartsWithSegments("/healthchecks-ui", StringComparison.OrdinalIgnoreCase);
        }
    }
}
