using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Dtos;
using IoTSharp.Extensions;
using IoTSharp.IndustrialSecurity;
using Industrial.Security.Abstractions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;

namespace IoTSharp.Controllers
{
    /// <summary>
    /// this is test purpose
    /// </summary>
    [Route("api/[controller]/[action]")]
    [ApiController]
    [Authorize]
    public class MenuController : ControllerBase
    {
        private readonly UserManager<IdentityUser> _userManager;
        private readonly ApplicationDbContext _context;
        private readonly ILocalPermissionSource _permissions;

        public MenuController(UserManager<IdentityUser> userManager,
            ApplicationDbContext context, ILocalPermissionSource permissions)
        {
            _userManager = userManager;
            _context = context;
            _permissions = permissions;
        }

        public ApiResult<dynamic> GetUserAsset(int type)
        {
            return new ApiResult<dynamic>(ApiCode.Success, "OK", null);
        }

        [HttpGet]
        public async Task<ApiResult<dynamic>> GetProfile()
        {
            var profile = this.GetUserProfile();
            var localUserId = User.FindFirst(IndustrialClaimTypes.LocalUserId)?.Value
                ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            async Task<bool> Allowed(string code) =>
                !string.IsNullOrWhiteSpace(localUserId) &&
                await _permissions.HasPermissionAsync(localUserId, code);
            var canViewDevices = await Allowed("iot.device.view");
            var canViewTelemetry = await Allowed("iot.telemetry.view");
            var canManageDevices = await Allowed("iot.device.manage");
            var canCommandDevice = await Allowed("iot.device.command");
            var canManageCustomer = await Allowed("iot.customer.admin");
            var canManageTenant = await Allowed("iot.tenant.admin");
            var sysmenu = new List<MenuItem>();
            if (User.IsInRole(nameof(UserRole.SystemAdmin)))
            {
                sysmenu.Add(new() { text = "证书管理", i18n = "", vi18n = "iot.certmnt", routename = "certmnt", link = "/iot/settings/certmgr", vpath = "/iot/settings/certmgr", });
                sysmenu.Add(new() { text = "租户列表", i18n = "", vi18n = "iot.tenantlist", routename = "tenantlist", link = "/iot/settings/tenantlist", vpath = "/iot/settings/tenantlist" });
            }
            if (canManageTenant)
            {
                sysmenu.Add(new() { text = "客户列表", i18n = "", vi18n = "iot.customerlist", routename = "customerlist", link = "/iot/settings/customerlist", vpath = "/iot/settings/customerlist", });
            }
            if (User.IsInRole(nameof(UserRole.SystemAdmin)) ||
                User.IsInRole(nameof(UserRole.TenantAdmin)) ||
                User.IsInRole(nameof(UserRole.CustomerAdmin)))
            {
                sysmenu.Add(new() { text = "用户列表", i18n = "", vi18n = "iot.userlist", routename = "userlist", link = "/iot/settings/userlist", vpath = "/iot/settings/userlist", });
                sysmenu.Add(new() { text = "角色管理", i18n = "", vi18n = "", routename = "rolelist", link = "/iot/settings/rolelist", vpath = "/iot/settings/rolelist", });
            }

            var _user_menu = new List<MenuItem>
            {
                new()
                {
                    text = "仪表盘",
                    i18n = "仪表盘",
                    vi18n = "iot.dashboardmnt",
                    routename = "dashboard",
                    vpath = "/dashboard",
                    icon = "anticon-dashboard",
                    children = new MenuItem[]
                        {
                            new() { text = "仪表盘", i18n = "", vi18n="iot.dashboard", routename="dashboard", link = "/dashboard",      vpath="/dashboard", }
                        }
                }
            };
            if (canViewDevices || canViewTelemetry ||
                User.IsInRole(nameof(UserRole.NormalUser)) ||
                User.IsInRole(nameof(UserRole.SystemAdmin)))
            {
                _user_menu.Add(
                new()
                {
                    text = "设备管理",
                    i18n = "",
                    vi18n = "iot.devicemnt",
                    routename = "devicemnt",
                    vpath = "/iot/devices",
                    icon = "anticon-database",
                    children = new MenuItem[]
                        {
                            new() { text = "设备管理", i18n = "", vi18n="iot.devicelist", routename="devicelist", link = "/iot/devices/devicelist" , vpath="/iot/devices/devicelist",},
                            new() { text = "遥测数据", i18n = "", vi18n="iot.telemetry", routename="telemetry", link = "/iot/devices/telemetry" , vpath="/iot/devices/telemetry",},
                            new() { text = "Edge 管理", i18n = "", vi18n="iot.edgelist", routename="edgelist", link = "/iot/devices/edgelist" , vpath="/iot/devices/edgelist",},
                            new() { text = "Edge 任务", i18n = "", vi18n="iot.edgetasks", routename="edgetasks", link = "/iot/devices/edgetasks" , vpath="/iot/devices/edgetasks",},
                            new() { text = "设备告警", i18n = "", vi18n="iot.alarmlist", routename="alarmlist", link = "/iot/alarms/alarmlist", vpath = "/iot/alarms/alarmlist", },
                            new() { text = "规则链设计", i18n = "", vi18n="iot.flowlist", routename="flowlist", link = "/iot/rules/flowlist", vpath = "/iot/rules/flowlist", },
                            new() { text = "规则链审计", i18n = "", vi18n="iot.flowevents", routename="flowevents", link = "/iot/rules/flowevents", vpath = "/iot/rules/flowevents",  },
                        }.Where(item =>
                            (item.routename != "devicelist" || canViewDevices) &&
                            (item.routename != "telemetry" || canViewTelemetry))
                          .ToArray()
                });
                _user_menu.Add(new()
                {
                    text = "数字孪生",
                    i18n = "",
                    vi18n = "iot.digitaltwin",
                    routename = "digitaltwin",
                    vpath = "/iot/digital-twin",
                    icon = "anticon-apartment",
                    children = new MenuItem[]
                    {
                        new() { text = "模型生成", i18n = "", vi18n="iot.digitaltwin.modelgenerator", routename="digitaltwinmodelgenerator", link = "/iot/digital-twin/model-generator", vpath = "/iot/digital-twin/model-generator", },
                        new() { text = "组件设计器", i18n = "", vi18n="iot.digitaltwin.componentstudio", routename="digitaltwincomponentstudio", link = "/iot/digital-twin/component-studio", vpath = "/iot/digital-twin/component-studio", icon = "iconfont icon-bianji", },
                        new() { text = "三维场景", i18n = "", vi18n="iot.digitaltwin.workbench", routename="digitaltwinworkbench", link = "/iot/digital-twin/workbench", vpath = "/iot/digital-twin/workbench", },
                        new() { text = "数字孪生 Studio V2", i18n = "", vi18n="", routename="digitaltwinstudiov2", link = "/iot/digital-twin/studio-v2", vpath="/iot/digital-twin/studio-v2", icon="iconfont icon-bianji", },
                        new() { text = "2D 场景设计器", i18n = "", vi18n="iot.digitaltwin.2dscene", routename="digitaltwin2dscene", link = "/iot/digital-twin/2d-scene", vpath = "/iot/digital-twin/2d-scene", icon = "iconfont icon-bianji", },
                        new() { text = "亚特包装线 2D", i18n = "", vi18n="iot.digitaltwin.ytpack2d", routename="digitaltwinytpack2d", link = "/iot/digital-twin/yt-pack-2d", vpath = "/iot/digital-twin/yt-pack-2d", icon = "iconfont icon-shuju", },
                    }
                });
                if (User.IsInRole(nameof(UserRole.CustomerAdmin)) ||
                    User.IsInRole(nameof(UserRole.TenantAdmin)) ||
                    User.IsInRole(nameof(UserRole.SystemAdmin)))
                {
                    _user_menu.Add(new()
                    {
                        text = "AI 与 MCP",
                        i18n = "",
                        vi18n = "iot.ai",
                        routename = "aicenter",
                        vpath = "/iot/ai",
                        icon = "anticon-robot",
                        children = new MenuItem[]
                        {
                            new() { text = "AI 功能", i18n = "", vi18n="iot.ai.workbench", routename="aiworkbench", link = "/iot/ai/workbench", vpath = "/iot/ai/workbench", },
                            new() { text = "MCP 服务", i18n = "", vi18n="iot.mcp", routename="mcpservice", link = "/iot/ai/mcp", vpath = "/iot/ai/mcp", },
                        }
                    });
                }
                _user_menu.Add(new()
                {
                    text = "产品管理",
                    i18n = "",
                    vi18n = "iot.productmnt",
                    routename = "productmnt",
                    icon = "medicinebox",
                    vpath = "/iot/product",
                    children = new MenuItem[]
                        {
                            new() { text = "产品列表", i18n = "", vi18n="iot.productlist", routename="productlist", link = "/iot/product/productlist", vpath="/iot/product/productlist", }
                        }
                });
                _user_menu.Add(new()
                {
                    text = "资产管理",
                    i18n = "",
                    vi18n = "iot.assetsmnt",
                    routename = "assetsmnt",
                    vpath = "/iot/assets",
                    icon = "anticon-gold",
                    children = new MenuItem[]
                        {
                            new() { text = "资产列表", i18n = "", vi18n="iot.assetlist", routename="assetlist", link = "/iot/assets/assetlist" , vpath="/iot/assets/assetlist",},
                        },
                });
            }
            else if (User.IsInRole(nameof(UserRole.CustomerAdmin)) ||
                     User.IsInRole(nameof(UserRole.TenantAdmin)) ||
                     User.IsInRole(nameof(UserRole.SystemAdmin)))
            {
                _user_menu.Add(new()
                {
                    text = "数字孪生",
                    i18n = "",
                    vi18n = "iot.digitaltwin",
                    routename = "digitaltwin",
                    vpath = "/iot/digital-twin",
                    icon = "anticon-apartment",
                    children = new MenuItem[]
                    {
                        new() { text = "模型生成", i18n = "", vi18n="iot.digitaltwin.modelgenerator", routename="digitaltwinmodelgenerator", link = "/iot/digital-twin/model-generator", vpath = "/iot/digital-twin/model-generator", },
                        new() { text = "组件设计器", i18n = "", vi18n="iot.digitaltwin.componentstudio", routename="digitaltwincomponentstudio", link = "/iot/digital-twin/component-studio", vpath = "/iot/digital-twin/component-studio", icon = "iconfont icon-bianji", },
                        new() { text = "三维场景", i18n = "", vi18n="iot.digitaltwin.workbench", routename="digitaltwinworkbench", link = "/iot/digital-twin/workbench", vpath = "/iot/digital-twin/workbench", },
                        new() { text = "数字孪生 Studio V2", i18n = "", vi18n="", routename="digitaltwinstudiov2", link = "/iot/digital-twin/studio-v2", vpath="/iot/digital-twin/studio-v2", icon="iconfont icon-bianji", },
                        new() { text = "2D 场景设计器", i18n = "", vi18n="iot.digitaltwin.2dscene", routename="digitaltwin2dscene", link = "/iot/digital-twin/2d-scene", vpath = "/iot/digital-twin/2d-scene", icon = "iconfont icon-bianji", },
                        new() { text = "亚特包装线 2D", i18n = "", vi18n="iot.digitaltwin.ytpack2d", routename="digitaltwinytpack2d", link = "/iot/digital-twin/yt-pack-2d", vpath = "/iot/digital-twin/yt-pack-2d", icon = "iconfont icon-shuju", },
                    }
                });
            }
            _user_menu.Add(new()
            {
                text = "预测性维护",
                i18n = "",
                vi18n = "",
                routename = "pdm",
                vpath = "/iot/pdm",
                icon = "anticon-heart",
                children = new MenuItem[]
                {
                    new() { text = "设备健康监测", i18n = "", vi18n = "", routename = "pdmworkbench", link = "/iot/pdm/workbench", vpath = "/iot/pdm/workbench", },
                    new() { text = "风险事件", i18n = "", vi18n = "", routename = "pdmevents", link = "/iot/pdm/risk-events", vpath = "/iot/pdm/risk-events", },
                    new() { text = "维修工单处理", i18n = "", vi18n = "", routename = "pdmworkorders", link = "/iot/pdm/work-orders", vpath = "/iot/pdm/work-orders", icon = "anticon-audit", },
                }.Concat(User.IsInRole(nameof(UserRole.SystemAdmin))
                        ? new MenuItem[]
                        {
                            new() { text = "MES 推送测试", i18n = "", vi18n = "", routename = "pdmmestest", link = "/iot/pdm/mes-test", vpath = "/iot/pdm/mes-test", },
                            new() { text = "飞书推送测试", i18n = "", vi18n = "", routename = "pdmfeishutest", link = "/iot/pdm/feishu-test", vpath = "/iot/pdm/feishu-test", },
                        } : System.Array.Empty<MenuItem>()).ToArray()
            });
            _user_menu.Add(new()
            {
                text = "系统管理",
                i18n = "",
                vi18n = "iot.settingsmnt",
                routename = "settingsmnt",
                vpath = "/iot/settings",
                icon = "anticon-setting",
                children = sysmenu.ToArray()
            });
            var data = new
            {
                menu = new[]{
                        new MenuItem
                        {
                            text = "主导航",
                            i18n = "主导航",
                            vi18n="iot.home",
                            routename="home",
                            group = true,
                            hideInBreadcrumb = true,
                            vpath="/dashboard",
                            isAffix=true,
                            isLink=false,
                            children = _user_menu.ToArray()
                        }
                    },
                funcs = Enumerable.Range(0, 500),
                username = profile.Name,
                AppName = "IoTSharp",
                Modules = new[]
                                {
                        "kanban",
                        "statistics",
                        "lists",
                        //"warning"
                    }, // 用户首页模块
                Email = this.User.GetEmail(),
                effectivePermissions = new[]
                {
                    (code: "iot.device.view", granted: canViewDevices),
                    (code: "iot.telemetry.view", granted: canViewTelemetry),
                    (code: "iot.device.manage", granted: canManageDevices),
                    (code: "iot.device.command", granted: canCommandDevice),
                    (code: "iot.customer.admin", granted: canManageCustomer),
                    (code: "iot.tenant.admin", granted: canManageTenant)
                }.Where(x => x.granted).Select(x => x.code).ToArray(),
                Customer = User.GetCustomerId(),
                Tenant = User.GetTenantId(),
                Logo = ""
            };
            return new ApiResult<dynamic>(ApiCode.Success, "OK", data);
        }
    }
}
