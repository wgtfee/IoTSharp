using IoTSharp.Contracts;
using IoTSharp.Controllers.Models;
using IoTSharp.Data;
using IoTSharp.Dtos;
using IoTSharp.Extensions;
using IoTSharp.Models;
using Industrial.Security.Abstractions;
using Jdenticon.AspNetCore;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using System;
using System.Collections.Generic;
using System.IdentityModel.Tokens.Jwt;
using System.Linq;
using System.Security.Claims;
using System.Text;
using System.Threading.Tasks;

namespace IoTSharp.Controllers
{
    /// <summary>
    /// 用户管理
    /// </summary>
    [ApiController]
    [Authorize]
    [Route("api/[controller]/[action]")]
    public partial class AccountController : ControllerBase
    {
        private ApplicationDbContext _context;
        private readonly AppSettings _settings;
        private readonly ILogger _logger;
        private readonly UserManager<IdentityUser> _userManager;
        private readonly SignInManager<IdentityUser> _signInManager;
        private readonly EasyCaching.Core.IEasyCachingProvider _caching;

        /// <summary>
        /// 用户管理
        /// </summary>
        /// <param name="userManager"></param>
        /// <param name="signInManager"></param>
        /// <param name="logger"></param>
        /// <param name="context"></param>
        /// <param name="options"></param>
        /// <param name="caching"></param>
        public AccountController(
            UserManager<IdentityUser> userManager,
            SignInManager<IdentityUser> signInManager,
            ILogger<AccountController> logger,
            ApplicationDbContext context,
            IOptions<AppSettings> options,
            EasyCaching.Core.IEasyCachingProvider caching
        )
        {
            _userManager = userManager;
            _signInManager = signInManager;
            _logger = logger;
            _context = context;
            _settings = options.Value;
            _caching = caching;
        }

        /// <summary>
        /// 获取当前用户的头像， 基于邮箱生成
        /// </summary>
        /// <returns></returns>
        [HttpGet, AllowAnonymous]
        public async Task<IActionResult> Avatar([FromQuery] string seed = null)
        {
            IdenticonResult result = IdenticonResult.FromValue("IoTSharp", 64);
            try
            {
                if (!string.IsNullOrWhiteSpace(seed))
                {
                    result = IdenticonResult.FromValue($"iotsharp_{seed}", 64);
                }
                else if (_signInManager.IsSignedIn(this.User))
                {
                    var user = await _userManager.GetUserAsync(User);
                    result = IdenticonResult.FromValue($"iotsharp_{user?.Email}_{user?.Id}", 64);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, $"生成头像失败:{ex.Message}");
            }
            return result;
        }

        /// <summary>
        /// 获取当前登录用户信息
        /// </summary>
        /// <returns></returns>
        [HttpGet, Authorize(Roles = nameof(UserRole.NormalUser))]
        public async Task<ActionResult<ApiResult<UserInfoDto>>> MyInfo()
        {
            ApiResult<UserInfoDto> result;
            var user = await _userManager.GetUserAsync(User);
            var custid = User.GetCustomerId();
            if (user == null || custid == Guid.Empty)
            {
                result = new ApiResult<UserInfoDto>(ApiCode.UserTokenNotAvailable, "用户的登录信息已经不可用", new UserInfoDto() { Code = ApiCode.UserTokenNotAvailable });
            }
            else
            {
                try
                {
                    var rooles = await _userManager.GetRolesAsync(user);
                    var Customer = _context.GetCustomer(custid);
                    var uidto = new UserInfoDto()
                    {
                        Code = ApiCode.Success,
                        Roles = string.Join(',', rooles).ToLower(),
                        Name = user.UserName,
                        Email = user.Email,
                        Avatar = user.Gravatar(),
                        PhoneNumber = user.PhoneNumber,
                        Introduction = user.NormalizedUserName,
                        Customer = Customer,
                        Tenant = Customer?.Tenant
                    };
                    result = new ApiResult<UserInfoDto>(ApiCode.Success, "OK", uidto);
                }
                catch (Exception ex)
                {
                    result = new ApiResult<UserInfoDto>(ApiCode.UserTokenNotAvailable, ex.Message, new UserInfoDto() { Code = ApiCode.UserTokenNotAvailable });
                }
            }
            return result;
        }

        /// <summary>
        /// 登录用户
        /// </summary>
        /// <param name="model"></param>
        /// <returns></returns>
        [AllowAnonymous]
        [HttpPost]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesDefaultResponseType]
        public async Task<ApiResult<LoginResult>> Login([FromBody] LoginDto model, [FromServices] IConfiguration configuration)
        {
            if (string.Equals(configuration["Security:Authentication:Mode"], "Centralized", StringComparison.OrdinalIgnoreCase)
                && !configuration.GetValue<bool>("Security:Central:AllowEmergencyLocalLogin"))
                return new ApiResult<LoginResult>(ApiCode.LoginError, "中央认证模式已关闭普通本地登录。", new LoginResult { Code = ApiCode.LoginError, Succeeded = false });
            try
            {
                var captchaResult = ConsumeCaptcha(model);
                if (!captchaResult.ok)
                {
                    return new ApiResult<LoginResult>(ApiCode.InValidData, captchaResult.message, null);
                }

                var result = await _signInManager.PasswordSignInAsync(model.UserName, model.Password, false, false);
                if (result.Succeeded)
                {
                    var SignInResult = await CreateToken(model.UserName);
                    return new ApiResult<LoginResult>(ApiCode.Success, "Ok", new LoginResult()
                    {
                        Code = ApiCode.Success,
                        Succeeded = result.Succeeded,
                        Token = new TokenEntity
                        {
                            access_token = SignInResult.Token,
                            expires_in = SignInResult.ExpiresIn,
                            refresh_token = SignInResult.RefreshToken,
                            expires = SignInResult.Expires
                        },
                        UserName = model.UserName,
                        SignIn = result,
                        Roles = SignInResult.Roles,
                        Avatar = SignInResult.AppUser.Gravatar()
                    });
                }
                else
                {
                    return new ApiResult<LoginResult>(ApiCode.LoginError, "用户名或密码错误。", new LoginResult() { Code = ApiCode.LoginError, Succeeded = false, SignIn = result });
                }
            }
            catch (Exception ex)
            {
                return new ApiResult<LoginResult>(ApiCode.InValidData, ex.Message, null);
            }
        }

        // Captcha is consumed during login so the final decision stays on the server side.
        private (bool ok, string message) ConsumeCaptcha(LoginDto model)
        {
            if (string.IsNullOrWhiteSpace(model.CaptchaClientId))
            {
                return (false, "请先完成滑块验证。");
            }

            var list = _caching.Get<List<ModelCaptchaVertifyItem>>("Captcha").Value ?? new List<ModelCaptchaVertifyItem>();
            var item = list.SingleOrDefault(c => c.Clientid == model.CaptchaClientId);

            if (item == null)
            {
                return (false, "验证码已过期，请刷新后重试。");
            }

            if (Math.Abs(item.Move - model.CaptchaMove) >= 3)
            {
                return (false, "滑块验证失败，请重新拼图。");
            }

            list.Remove(item);
            _caching.Set("Captcha", list, expiration: TimeSpan.FromMinutes(20));
            return (true, "OK");
        }


        private async Task<ModelRefreshToken> CreateToken(string name)
        {
            var appUser = await _userManager.FindByNameAsync(name)
                ?? await _userManager.FindByEmailAsync(name);
            if (appUser == null)
            {
                throw new InvalidOperationException($"本地用户 {name} 不存在。");
            }
            var secretKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(RequireJwtSetting(_settings.JwtKey, nameof(AppSettings.JwtKey))));
            var signinCredentials = new SigningCredentials(secretKey, SecurityAlgorithms.HmacSha256Signature);
            var claims = new List<Claim>
            {
                new(ClaimTypes.Email, appUser.Email),
                new(ClaimTypes.NameIdentifier, appUser.Id),
                new(ClaimTypes.Name,  appUser.UserName),
            };
            var lstclaims = await _userManager.GetClaimsAsync(appUser);
            claims.AddRange(lstclaims);
            var roles = await _userManager.GetRolesAsync(appUser);
            if (roles != null)
            {
                claims.AddRange(from role in roles
                                select new Claim(ClaimTypes.Role, role));
            }
            var expires = DateTime.UtcNow.AddHours(_settings.JwtExpireHours);
            var jwtSecurityTokenHandler = new JwtSecurityTokenHandler();

            var tokenDescriptor = new SecurityTokenDescriptor
            {
                Issuer = RequireJwtSetting(_settings.JwtIssuer, nameof(AppSettings.JwtIssuer)),
                Audience = RequireJwtSetting(_settings.JwtAudience, nameof(AppSettings.JwtAudience)),
                Subject = new ClaimsIdentity(claims),
                Expires = expires,
                SigningCredentials = signinCredentials
            };
            var _token = jwtSecurityTokenHandler.CreateToken(tokenDescriptor);
            var jwtToken = jwtSecurityTokenHandler.WriteToken(_token);
            var refreshToken = new RefreshToken()
            {
                JwtId = _token.Id,
                IsUsed = false,
                IsRevorked = false,
                UserId = appUser.Id,
                AddedDate = DateTime.UtcNow,
                ExpiryDate = DateTime.UtcNow.AddHours(_settings.JwtExpireHours),
                Token = Guid.NewGuid().ToString()
            };
            await _context.RefreshTokens.AddAsync(refreshToken);
            await _context.SaveChangesAsync();
            return new ModelRefreshToken() { RefreshToken = refreshToken.Token, Token = jwtToken, ExpiresIn = (long)(_settings.JwtExpireHours * 3600), AppUser = appUser, Roles = roles, Expires = expires };
        }

        private static string RequireJwtSetting(string value, string name)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new InvalidOperationException($"{name} 未配置。");
            }

            return value;
        }

        /// <summary>
        /// 刷新JWT Token
        /// </summary>
        /// <param name="model"></param>
        /// <returns></returns>
        [HttpPost]
        public async Task<ApiResult<LoginResult>> RefreshToken([FromBody] RefreshTokenDto model)
        {
            var profile = this.GetUserProfile();
            try
            {
                var storedRefreshToken = await _context.RefreshTokens.FirstOrDefaultAsync(x => x.Token == model.RefreshToken);
                if (storedRefreshToken == null)
                {
                    return new ApiResult<LoginResult>(ApiCode.InValidData, "RefreshToken does not exist", null);
                }

                if (storedRefreshToken.IsRevorked)

                {
                    return new ApiResult<LoginResult>(ApiCode.InValidData, "RefreshToken is revorked", null);
                }

                storedRefreshToken.IsUsed = true;
                _context.RefreshTokens.Update(storedRefreshToken);
                await _context.SaveChangesAsync();
                var signInResult = await CreateToken(profile.Name);
                return new ApiResult<LoginResult>(ApiCode.Success, "Ok", new LoginResult()
                {
                    Code = ApiCode.Success,
                    Succeeded = true,
                    UserName = profile.Name,
                    Roles = profile.Roles,
                    Token = new TokenEntity
                    {
                        access_token = signInResult.Token,
                        expires_in = signInResult.ExpiresIn,
                        refresh_token = signInResult.RefreshToken,
                        expires = signInResult.Expires
                    },
                });
            }
            catch (Exception ex)
            {
                return new ApiResult<LoginResult>(ApiCode.Exception, ex.Message, null);
            }
        }

        /// <summary>
        /// 退出账号
        /// </summary>
        /// <returns></returns>
        [AllowAnonymous]
        [HttpPost]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesDefaultResponseType]
        public async Task<ApiResult<bool>> Logout()
        {
            try
            {
                await _signInManager.SignOutAsync();
                return new ApiResult<bool>(ApiCode.Success, "Ok", true);
            }
            catch (Exception ex)
            {
                return new ApiResult<bool>(ApiCode.Exception, ex.Message, true);
            }
        }

        /// <summary>
        /// 注册用户
        /// </summary>
        /// <param name="model"></param>
        /// <returns >返回登录结果</returns>
        [AllowAnonymous]
        [HttpPost]
        public async Task<ApiResult<LoginResult>> Register([FromBody] RegisterDto model)
        {
            try
            {
                var user = new IdentityUser
                {
                    Email = model.Email,
                    UserName = model.Email,
                    PhoneNumber = model.PhoneNumber
                };
                var result = await _userManager.CreateAsync(user, model.Password);

                if (result.Succeeded)
                {
                    await _signInManager.SignInAsync(user, false);
                    await _signInManager.UserManager.AddClaimAsync(user, new Claim(ClaimTypes.Email, model.Email));
                    var customer = await _context.Customer.Include(c => c.Tenant).FirstOrDefaultAsync(c => c.Email == model.Customer);
                    if (customer != null)
                    {
                        await _signInManager.UserManager.AddClaimAsync(user, new Claim(ClaimTypes.Email, model.Email));
                        await _signInManager.UserManager.AddClaimAsync(user, new Claim(IoTSharpClaimTypes.Customer, customer.Id.ToString()));
                        await _signInManager.UserManager.AddClaimAsync(user, new Claim(IoTSharpClaimTypes.Tenant, customer.Tenant.Id.ToString()));
                        await _signInManager.UserManager.AddToRolesAsync(user, new[] { nameof(UserRole.NormalUser) });
                        return new ApiResult<LoginResult>(ApiCode.Success, "Ok", new LoginResult()
                        {
                            Code = ApiCode.Success,
                            Succeeded = result.Succeeded,
                            UserName = model.Email,
                        });
                    }
                }
                else
                {
                    var msg = from e in result.Errors select $"{e.Code}:{e.Description}\r\n";
                    return new ApiResult<LoginResult>(ApiCode.InValidData, string.Join(';', msg.ToArray()), null);
                }
            }
            catch (Exception ex)
            {
                return new ApiResult<LoginResult>(ApiCode.InValidData, ex.Message, null);
            }
            return new ApiResult<LoginResult>(ApiCode.InValidData, "", null);
        }

        /// <summary>
        /// 注册新的租户，客户，以及用户
        /// </summary>
        /// <param name="model"></param>
        /// <returns >返回登录结果</returns>
        [AllowAnonymous]
        [HttpPost]
        public async Task<ApiResult<LoginResult>> Create([FromBody] InstallDto model)
        {
            var tenant = _context.Tenant.FirstOrDefault(t => t.Email == model.TenantEMail && t.Deleted == false);
            var customer = _context.Customer.FirstOrDefault(t => t.Email == model.CustomerEMail && t.Deleted == false);
            if (tenant == null && customer == null)
            {
                tenant = new Tenant() { Id = Guid.NewGuid(), Name = model.TenantName, Email = model.TenantEMail };
                customer = new Customer() { Id = Guid.NewGuid(), Name = model.CustomerName, Email = model.CustomerEMail };
                customer.Tenant = tenant;
                tenant.Customers = new List<Customer>();
                tenant.Customers.Add(customer);
                _context.Tenant.Add(tenant);
                _context.Customer.Add(customer);
                await _context.SaveChangesAsync();
            }
            IdentityUser user = await _userManager.FindByEmailAsync(model.Email);
            if (user == null)
            {
                user = new IdentityUser
                {
                    Email = model.Email,
                    UserName = model.Email,
                    PhoneNumber = model.PhoneNumber
                };
                var result = await _userManager.CreateAsync(user, model.Password);
                if (result.Succeeded)
                {
                    await _signInManager.SignInAsync(user, false);
                    await _signInManager.UserManager.AddClaimAsync(user, new Claim(ClaimTypes.Email, model.Email));
                    await _signInManager.UserManager.AddClaimAsync(user, new Claim(IoTSharpClaimTypes.Customer, customer.Id.ToString()));
                    await _signInManager.UserManager.AddClaimAsync(user, new Claim(IoTSharpClaimTypes.Tenant, tenant.Id.ToString()));
                    await _signInManager.UserManager.AddToRoleAsync(user, nameof(UserRole.Anonymous));
                    await _signInManager.UserManager.AddToRoleAsync(user, nameof(UserRole.NormalUser));
                    await _signInManager.UserManager.AddToRoleAsync(user, nameof(UserRole.CustomerAdmin));
                    await _signInManager.UserManager.AddToRoleAsync(user, nameof(UserRole.TenantAdmin));
                    _context.Relationship.Add(new Relationship
                    {
                        IdentityUser = _context.Users.Find(user.Id),
                        Customer = _context.Customer.Find(customer.Id),
                        Tenant = _context.Tenant.Find(tenant.Id)
                    });
                    await _context.SaveChangesAsync();
                    return new ApiResult<LoginResult>(ApiCode.Success, "OK", null);
                }
                else
                {
                    throw new Exception(string.Join(',', result.Errors.ToList().Select(ie => $"code={ie.Code},msg={ie.Description}")));
                }
            }
            else
            {
                return new ApiResult<LoginResult>(ApiCode.UserAlreadyExists, "The user already exists", null);
            }
        }

        /// <summary>
        /// 注册新的租户，客户，以及用户
        /// </summary>
        /// <param name="model"></param>
        /// <returns >返回登录结果</returns>
        [AllowAnonymous]
        [HttpPost]
        public async Task<ApiResult<LoginResult>> CreateUser([FromBody] CreateUserDto model)
        {
            var customer = await _context.Customer.Include(c => c.Tenant).FirstOrDefaultAsync(c => c.Id == model.Customer);
            if (customer != null && customer.Tenant != null)
            {
                var tid = customer.Tenant.Id;
                IdentityUser user = await _userManager.FindByEmailAsync(model.Email);
                if (user == null)
                {
                    user = new IdentityUser
                    {
                        Email = model.Email,
                        UserName = model.Email,
                        PhoneNumber = model.PhoneNumber
                    };
                    var result = await _userManager.CreateAsync(user, model.Password);
                    if (result.Succeeded)
                    {
                        await _signInManager.SignInAsync(user, false);
                        await _signInManager.UserManager.AddClaimAsync(user, new Claim(ClaimTypes.Email, model.Email));
                        await _signInManager.UserManager.AddClaimAsync(user, new Claim(IoTSharpClaimTypes.Customer, model.Customer.ToString()));
                        await _signInManager.UserManager.AddClaimAsync(user, new Claim(IoTSharpClaimTypes.Tenant, tid.ToString()));
                        await _signInManager.UserManager.AddToRoleAsync(user, nameof(UserRole.NormalUser));
                        var rship = new Relationship
                        {
                            IdentityUser = _context.Users.Find(user.Id),
                            Customer = _context.Customer.Find(model.Customer),
                            Tenant = _context.Tenant.Find(tid)
                        };
                        _context.Add(rship);
                        await _context.SaveChangesAsync();
                        return new ApiResult<LoginResult>(ApiCode.Success, "OK", null);
                    }
                    else
                    {
                        throw new Exception(string.Join(',', result.Errors.ToList().Select(ie => $"code={ie.Code},msg={ie.Description}")));
                    }
                }
                else
                {
                    return new ApiResult<LoginResult>(ApiCode.UserAlreadyExists, "用户已存在", null);
                }
            }
            else
            {
                return new ApiResult<LoginResult>(ApiCode.NotFoundCustomer, "未找到客户", null);
            }
        }
        /// <summary>
        /// 为当前客户所在的租户新增用户  zhangjie 20230308
        /// </summary>
        /// <param name="model">前端传参</param>
        /// <returns></returns>
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," + nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        [HttpPost]
        public async Task<ApiResult<LoginResult>> PostAccount([FromBody] CreateUserInput model)
        {
            // 先验证目标客户范围，禁止先创建账号再检查归属。
            var customerId = model.CustomerId == Guid.Empty ? User.GetCustomerId() : model.CustomerId;
            var customer = await _context.Customer.Include(c => c.Tenant)
                .SingleOrDefaultAsync(c => c.Id == customerId && !c.Deleted);
            if (customer?.Tenant == null)
                return new ApiResult<LoginResult>(ApiCode.NotFoundCustomer, "请选择有效客户", null);
            var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var tenantAdmin = User.IsInRole(nameof(UserRole.TenantAdmin));
            if (!IoTSharp.Services.Accounts.AccountCreationScope.IsAllowed(systemAdmin, tenantAdmin,
                User.IsInRole(nameof(UserRole.CustomerAdmin)), User.GetTenantId(), User.GetCustomerId(), customer.Tenant.Id, customer.Id))
                return new ApiResult<LoginResult>(ApiCode.DoNotAllow, "不允许为其他客户或租户创建用户", null);
            var requested = await ResolveAccountRolesAsync(
                model.RoleNames ?? new List<string> { nameof(UserRole.NormalUser) });
            if (requested.Names is null)
                return new ApiResult<LoginResult>(requested.Code, requested.Error, null);

            await using var transaction = await _context.Database.BeginTransactionAsync();
            try
            {
                var user = new IdentityUser
                {
                    Email = model.Email,
                    UserName = string.IsNullOrWhiteSpace(model.UserName) ? model.Email : model.UserName.Trim(),
                    PhoneNumber = model.PhoneNumber
                };
                var result = await _userManager.CreateAsync(user, model.Password);
                if (!result.Succeeded)
                    return new ApiResult<LoginResult>(ApiCode.InValidData, string.Join("; ", result.Errors.Select(e => e.Description)), null);

                var newClaims = new List<Claim>
                {
                    new Claim(ClaimTypes.Email, model.Email),
                    new Claim(IoTSharpClaimTypes.Customer, customer.Id.ToString()),
                    new Claim(IoTSharpClaimTypes.Tenant, customer.Tenant.Id.ToString())
                };
                if (!string.IsNullOrWhiteSpace(model.DisplayName))
                    newClaims.Add(new Claim(ClaimTypes.GivenName, model.DisplayName.Trim()));
                var claimsResult = await _userManager.AddClaimsAsync(user, newClaims);
                if (!claimsResult.Succeeded)
                    throw new InvalidOperationException("写入用户归属失败");
                // Validate against Identity's catalog and save roles with the
                // user and customer binding in one database transaction.
                var roleResult = await _userManager.AddToRolesAsync(user, requested.Names);
                if (!roleResult.Succeeded)
                    throw new InvalidOperationException("写入用户角色失败");
                _context.Add(new Relationship { IdentityUser = user, Customer = customer, Tenant = customer.Tenant });
                AddUserManagementAudit(user, "USER_CREATED", customer.Tenant.Id,
                    customer.Id, new { userId = user.Id, customerId = customer.Id,
                        tenantId = customer.Tenant.Id, afterRoles = requested.Names });
                await _context.SaveChangesAsync();
                await transaction.CommitAsync();
                _logger.LogInformation("User created: actor={Actor}, user={Target}, roles={Roles}",
                    User.FindFirst(ClaimTypes.NameIdentifier)?.Value, user.Id,
                    string.Join(",", requested.Names));
                return new ApiResult<LoginResult>(ApiCode.Success, "Ok", new LoginResult
                {
                    Code = ApiCode.Success, Succeeded = true, UserName = user.UserName
                });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "为客户 {CustomerId} 创建普通用户失败", customerId);
                return new ApiResult<LoginResult>(ApiCode.InValidData, "创建用户失败，请联系管理员查看日志", null);
            }
        }

        private void AddUserManagementAudit(IdentityUser subject, string action,
            Guid? tenantId, Guid? customerId, object data)
        {
            _context.AuditLog.Add(new AuditLog
            {
                TenantId = tenantId, CustomerId = customerId,
                UserId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value ?? "",
                UserName = User.Identity?.Name ?? "SystemAdmin",
                ObjectID = Guid.TryParse(subject.Id, out var id) ? id : Guid.Empty,
                ObjectName = subject.UserName ?? subject.Id,
                ObjectType = ObjectType.Unknow,
                ActionName = action,
                ActionData = System.Text.Json.JsonSerializer.Serialize(data),
                ActionResult = "Success",
                ActiveDateTime = DateTime.UtcNow
            });
        }
        public sealed record AssignableRoleOption(string Name, string DisplayName);

        /// <summary>Assignable roles from real Identity; elevated roles require SystemAdmin.</summary>
        [HttpGet]
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," +
            nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        public async Task<IActionResult> AssignableRoles()
        {
            var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var catalog = await _context.Roles.AsNoTracking()
                .Where(r => r.Name != null &&
                    (systemAdmin || r.Name == nameof(UserRole.NormalUser)))
                .OrderBy(r => r.Name).Select(r => new { r.Id, r.Name })
                .ToListAsync();
            var ids = catalog.Select(r => r.Id).ToArray();
            var labels = await _context.RoleClaims.AsNoTracking()
                .Where(c => ids.Contains(c.RoleId) && c.ClaimType == "iotsharp.role.label")
                .Select(c => new { c.RoleId, c.ClaimValue }).ToListAsync();
            var options = catalog.Select(r =>
            {
                var label = labels.FirstOrDefault(c => c.RoleId == r.Id)?.ClaimValue;
                if (string.IsNullOrWhiteSpace(label))
                    label = r.Name switch
                    {
                        "SystemAdmin" => "系统管理员",
                        "TenantAdmin" => "租户管理员",
                        "CustomerAdmin" => "客户管理员",
                        "NormalUser" => "普通用户",
                        "Anonymous" => "匿名访问",
                        _ => r.Name
                    };
                return new AssignableRoleOption(r.Name!, label!);
            }).ToArray();
            return Ok(new ApiResult<AssignableRoleOption[]>(ApiCode.Success, "OK", options));
        }

        /// <summary>Validate a requested complete role set before any Identity mutations.</summary>
        private async Task<(List<string>? Names, ApiCode Code, string Error)>
            ResolveAccountRolesAsync(List<string> supplied)
        {
            if (supplied is null || supplied.Count is < 1 or > 16 ||
                supplied.Any(string.IsNullOrWhiteSpace))
                return (null, ApiCode.InValidData, "请至少选择一个有效角色");
            var normalized = supplied.Select(x => x.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            var catalog = await _context.Roles.AsNoTracking()
                .Select(r => r.Name).Where(x => x != null).ToListAsync();
            var available = catalog.ToDictionary(x => x!, StringComparer.OrdinalIgnoreCase);
            if (normalized.Any(x => !available.ContainsKey(x)))
                return (null, ApiCode.InValidData, "包含不存在的角色，请刷新角色列表");
            var selected = normalized.Select(x => available[x]!).ToList();
            if (!selected.Contains(nameof(UserRole.NormalUser), StringComparer.OrdinalIgnoreCase))
                return (null, ApiCode.InValidData, "用户需保留普通用户角色才能登录管理平台");
            if (!User.IsInRole(nameof(UserRole.SystemAdmin)) &&
                selected.Any(x => !string.Equals(x, nameof(UserRole.NormalUser),
                    StringComparison.OrdinalIgnoreCase)))
                return (null, ApiCode.DoNotAllow, "仅系统管理员可分配管理或自定义角色");
            return (selected, ApiCode.Success, "");
        }

        public sealed record AssignableCustomerOption(Guid Id, string Name,
            Guid TenantId, string TenantName);

        /// <summary>返回当前管理员允许绑定的真实客户列表。</summary>
        [HttpGet]
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," +
            nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        public async Task<IActionResult> AssignableCustomers()
        {
            var admin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var tenantAdmin = User.IsInRole(nameof(UserRole.TenantAdmin));
            var callerTenant = User.GetTenantId();
            var callerCustomer = User.GetCustomerId();
            var query = _context.Customer.AsNoTracking().Include(c => c.Tenant)
                .Where(c => !c.Deleted && c.Tenant != null);
            if (!admin)
            {
                if (callerTenant == Guid.Empty) return Forbid();
                query = query.Where(c => c.Tenant.Id == callerTenant);
                if (!tenantAdmin)
                {
                    if (callerCustomer == Guid.Empty) return Forbid();
                    query = query.Where(c => c.Id == callerCustomer);
                }
            }
            var options = await query.OrderBy(c => c.Name)
                .Select(c => new AssignableCustomerOption(c.Id, c.Name,
                    c.Tenant.Id, c.Tenant.Name)).ToArrayAsync();
            return Ok(new ApiResult<AssignableCustomerOption[]>(ApiCode.Success, "OK", options));
        }

        /// <summary>
        /// 列出指定租户的所有用户。
        /// </summary>
        /// <param name="m"></param>
        /// <returns></returns>
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," +
            nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        public async Task<ApiResult<PagedData<UserItemDto>>> List([FromQuery] UserQueryDto m)
        {
            var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var tenantAdmin = User.IsInRole(nameof(UserRole.TenantAdmin));
            var callerTenant = User.GetTenantId();
            var callerCustomer = User.GetCustomerId();
            var requestedCustomer = m.CustomerId;
            if (!systemAdmin)
            {
                if (callerTenant == Guid.Empty)
                    return new ApiResult<PagedData<UserItemDto>>(ApiCode.DoNotAllow,
                        "当前账号没有有效租户范围", new PagedData<UserItemDto>());
                if (requestedCustomer == Guid.Empty && !tenantAdmin)
                    requestedCustomer = callerCustomer;
                if (requestedCustomer == Guid.Empty && !tenantAdmin)
                    return new ApiResult<PagedData<UserItemDto>>(ApiCode.DoNotAllow,
                        "当前账号没有有效客户范围", new PagedData<UserItemDto>());
                if (requestedCustomer != Guid.Empty)
                {
                    var scope = await _context.Customer.AsNoTracking()
                        .Include(c => c.Tenant)
                        .SingleOrDefaultAsync(c => c.Id == requestedCustomer && !c.Deleted);
                    if (scope?.Tenant == null ||
                        !IoTSharp.Services.Accounts.AccountCreationScope.IsAllowed(
                            false, tenantAdmin,
                            User.IsInRole(nameof(UserRole.CustomerAdmin)),
                            callerTenant, callerCustomer, scope.Tenant.Id, scope.Id))
                        return new ApiResult<PagedData<UserItemDto>>(ApiCode.DoNotAllow,
                            "不能查看其他租户或客户用户", new PagedData<UserItemDto>());
                }
            }
            // Every scope and search condition is translated to SQL before paging.
            // Include local Relationship users and IAM shadow users without
            // loading all rows or performing a query per IAM account.
            var query = _context.Users.AsNoTracking().Where(u =>
                _context.Relationship.Any(r => r.IdentityUser.Id == u.Id) ||
                _context.UserClaims.Any(c => c.UserId == u.Id &&
                    c.ClaimType == IndustrialClaimTypes.GlobalUserId));
            if (requestedCustomer != Guid.Empty)
            {
                var requestedCustomerText = requestedCustomer.ToString("D");
                if (systemAdmin)
                {
                    query = query.Where(u =>
                        _context.Relationship.Any(r =>
                            r.IdentityUser.Id == u.Id && r.Customer.Id == requestedCustomer) ||
                        _context.UserClaims.Any(c =>
                            c.UserId == u.Id &&
                            c.ClaimType == IoTSharpClaimTypes.Customer &&
                            c.ClaimValue == requestedCustomerText));
                }
                else
                {
                    var tenantText = callerTenant.ToString("D");
                    query = query.Where(u =>
                        _context.Relationship.Any(r => r.IdentityUser.Id == u.Id &&
                            r.Customer.Id == requestedCustomer &&
                            r.Tenant.Id == callerTenant) ||
                        (_context.UserClaims.Any(c => c.UserId == u.Id &&
                            c.ClaimType == IoTSharpClaimTypes.Customer &&
                            c.ClaimValue == requestedCustomerText) &&
                         _context.UserClaims.Any(c => c.UserId == u.Id &&
                            c.ClaimType == IoTSharpClaimTypes.Tenant &&
                            c.ClaimValue == tenantText)));
                }
            }
            else if (!systemAdmin)
            {
                var tenantText = callerTenant.ToString("D");
                query = query.Where(u =>
                    _context.Relationship.Any(r => r.IdentityUser.Id == u.Id &&
                        r.Tenant.Id == callerTenant) ||
                    _context.UserClaims.Any(c => c.UserId == u.Id &&
                        c.ClaimType == IoTSharpClaimTypes.Tenant &&
                        c.ClaimValue == tenantText));
            }
            if (!string.IsNullOrWhiteSpace(m.Name))
            {
                var keyword = m.Name.Trim();
                if (keyword.Length > 128)
                    return new ApiResult<PagedData<UserItemDto>>(ApiCode.InValidData,
                        "查询关键字不能超过128个字符", new PagedData<UserItemDto>());
                query = query.Where(u =>
                    (u.UserName != null && u.UserName.Contains(keyword)) ||
                    (u.Email != null && u.Email.Contains(keyword)) ||
                    _context.UserClaims.Any(c => c.UserId == u.Id &&
                        (c.ClaimType == ClaimTypes.GivenName ||
                         c.ClaimType == "display_name") &&
                        c.ClaimValue != null && c.ClaimValue.Contains(keyword)));
            }
            var total = await query.CountAsync();
            var limit = Math.Clamp(m.Limit, 1, 500);
            var offset = Math.Clamp(m.Offset, 0, 100000);
            var users = await query.OrderBy(u => u.UserName).ThenBy(u => u.Id)
                .Skip(offset * limit).Take(limit).ToListAsync();
            if (users.Count == 0)
                return new ApiResult<PagedData<UserItemDto>>(ApiCode.Success, "OK",
                    new PagedData<UserItemDto> { total = total, rows = new List<UserItemDto>() });

            var ids = users.Select(u => u.Id).ToArray();
            var relations = await _context.Relationship.AsNoTracking()
                .Where(r => ids.Contains(r.IdentityUser.Id))
                .Select(r => new {
                    UserId = r.IdentityUser.Id, CustomerId = r.Customer.Id,
                    CustomerName = r.Customer.Name,
                    TenantId = r.Tenant.Id, TenantName = r.Tenant.Name
                }).ToListAsync();
            var relationsById = relations.GroupBy(x => x.UserId)
                .ToDictionary(g => g.Key, g => g.First());
            var claimTypes = new[]
            {
                IoTSharpClaimTypes.Customer, IoTSharpClaimTypes.Tenant,
                IndustrialClaimTypes.GlobalUserId, ClaimTypes.GivenName,
                "display_name"
            };
            var claims = await _context.UserClaims.AsNoTracking()
                .Where(c => ids.Contains(c.UserId) && claimTypes.Contains(c.ClaimType))
                .Select(c => new { c.UserId, c.ClaimType, c.ClaimValue })
                .ToListAsync();
            var claimsById = claims.GroupBy(c => c.UserId)
                .ToDictionary(g => g.Key, g => g.ToList());
            var roleRows = await _context.UserRoles.AsNoTracking()
                .Where(x => ids.Contains(x.UserId))
                .Join(_context.Roles.AsNoTracking(), x => x.RoleId,
                    role => role.Id, (x, role) => new { x.UserId, role.Name })
                .ToListAsync();
            var rolesById = roleRows.GroupBy(x => x.UserId).ToDictionary(g => g.Key,
                g => g.Select(x => x.Name!)
                    .Where(name => !string.IsNullOrWhiteSpace(name))
                    .Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(name => name).ToList());
            var customerIds = claims
                .Where(c => c.ClaimType == IoTSharpClaimTypes.Customer)
                .Select(c => Guid.TryParse(c.ClaimValue, out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty).Distinct().ToArray();
            var customerRows = await _context.Customer.AsNoTracking()
                .Where(c => customerIds.Contains(c.Id))
                .Select(c => new { c.Id, c.Name, TenantId = c.Tenant.Id,
                    TenantName = c.Tenant.Name }).ToListAsync();
            var customersById = customerRows.ToDictionary(c => c.Id);
            var resultRows = new List<UserItemDto>(users.Count);
            foreach (var current in users)
            {
                relationsById.TryGetValue(current.Id, out var relation);
                claimsById.TryGetValue(current.Id, out var userClaims);
                string? ClaimValue(string claimType) => userClaims?
                    .FirstOrDefault(c => c.ClaimType == claimType)?.ClaimValue;
                var boundCustomerId = Guid.TryParse(
                    ClaimValue(IoTSharpClaimTypes.Customer), out var cid)
                    ? cid : relation?.CustomerId ?? Guid.Empty;
                var claimedTenant = Guid.TryParse(
                    ClaimValue(IoTSharpClaimTypes.Tenant), out var tid)
                    ? tid : relation?.TenantId ?? Guid.Empty;
                customersById.TryGetValue(boundCustomerId, out var customer);
                var boundRoles = rolesById.GetValueOrDefault(current.Id) ?? new List<string>();
                resultRows.Add(new UserItemDto
                {
                    Id = current.Id, UserName = current.UserName,
                    Email = current.Email, PhoneNumber = current.PhoneNumber,
                    AccessFailedCount = current.AccessFailedCount,
                    LockoutEnabled = current.LockoutEnabled,
                    LockoutEnd = current.LockoutEnd,
                    DisplayName = ClaimValue(ClaimTypes.GivenName)
                        ?? ClaimValue("display_name"),
                    CustomerId = boundCustomerId,
                    CustomerName = customer?.Name ?? relation?.CustomerName,
                    TenantId = customer?.TenantId ?? claimedTenant,
                    TenantName = customer?.TenantName ?? relation?.TenantName,
                    UserSource = ClaimValue(IndustrialClaimTypes.GlobalUserId) is null
                        ? "Local" : "IAM",
                    IamUserId = ClaimValue(IndustrialClaimTypes.GlobalUserId),
                    Roles = boundRoles, RoleNames = new List<string>(boundRoles)
                });
            }
            return new ApiResult<PagedData<UserItemDto>>(ApiCode.Success, "OK",
                new PagedData<UserItemDto> { total = total, rows = resultRows });
        }
        /// <summary>
        /// 返回用户信息
        /// </summary>
        /// <param name="Id"></param>
        /// <returns></returns>
        [HttpGet]
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," +
            nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        public async Task<ApiResult<UserItemDto>> Get(String Id)
        {
            var user = await _userManager.FindByIdAsync(Id);
            if (user != null)
            {
                var claims = await _userManager.GetClaimsAsync(user);
                if (!User.IsInRole(nameof(UserRole.SystemAdmin)))
                {
                    var sameTenant = claims.Any(c => c.Type == IoTSharpClaimTypes.Tenant &&
                        Guid.TryParse(c.Value, out var tenant) && tenant == User.GetTenantId());
                    var sameCustomer = claims.Any(c => c.Type == IoTSharpClaimTypes.Customer &&
                        Guid.TryParse(c.Value, out var customer) && customer == User.GetCustomerId());
                    if (!sameTenant ||
                        (!User.IsInRole(nameof(UserRole.TenantAdmin)) && !sameCustomer))
                        return new ApiResult<UserItemDto>(ApiCode.DoNotAllow,
                            "不能读取其他租户或客户账号", null);
                }
                var displayName = claims.FirstOrDefault(c => c.Type == ClaimTypes.GivenName)?.Value
                    ?? claims.FirstOrDefault(c => c.Type == "display_name")?.Value;
                var assignedRoles = (await _userManager.GetRolesAsync(user)).ToList();
                var customerId = claims.Where(c => c.Type == IoTSharpClaimTypes.Customer)
                    .Select(c => Guid.TryParse(c.Value, out var val) ? val : Guid.Empty)
                    .FirstOrDefault();
                var customer = await _context.Customer.AsNoTracking()
                    .Include(c => c.Tenant).SingleOrDefaultAsync(c => c.Id == customerId);
                return new ApiResult<UserItemDto>(ApiCode.Success, "", new UserItemDto
                {
                    PhoneNumber = user.PhoneNumber, Id = Id, UserName = user.UserName,
                    Email = user.Email, DisplayName = displayName, CustomerId = customerId,
                    CustomerName = customer?.Name, TenantId = customer?.Tenant?.Id ?? Guid.Empty,
                    TenantName = customer?.Tenant?.Name,
                    Roles = assignedRoles, RoleNames = new List<string>(assignedRoles)
                });
            }

            return new ApiResult<UserItemDto>(ApiCode.CantFindObject, "can't find that user", null);
        }

        /// <summary>
        /// 锁定用户
        /// </summary>
        /// <param name="dto"></param>
        /// <returns>
        /// UserAlreadyExists = 10020,
        /// NotFoundUser = 10021,
        /// CanNotLockUser = 10022,
        ///LockUserHaveError = 10023
        ///CanNotLockYourself =10028 
        ///CanNotUnlockYourself =10029 
        ///</returns>
        [HttpPut]
        public async Task<ApiResult> Lock(LockDto dto)
        {
            var result = new ApiResult();
            var user = await _userManager.FindByIdAsync(dto.Id.ToString());
            if (user != null)
            {
                var les = await _userManager.GetLockoutEnabledAsync(user);
                switch (dto.Opt)
                {
                    case LockOpt.Status:
                        result = new ApiResult(ApiCode.Success, $"{les}");
                        break;

                    case LockOpt.Lock:
                        if (User.GetUserId() == dto.Id)
                        {
                            result = new ApiResult(ApiCode.CanNotLockYourself, "不能自己锁定自己的账号");
                        }
                        else
                        {
                            var lce = await _userManager.SetLockoutEnabledAsync(user, true);
                            if (lce.Succeeded)
                            {
                                /*20230309 zhangjie modify
                                 * 此处修改Now为UtcNow，否则报错：Cannot write DateTimeOffset with Offset=08:00:00 to PostgreSQL type 'timestamp with time zone'
                                 * 如果此处不改，网上给出的另一个方式是在Main方法中添加：
                                 * AppContext.SetSwitch("Npgsql.EnableLegacyTimestampBehavior", true);
                                 * AppContext.SetSwitch("Npgsql.DisableDateTimeInfinityConversions", true);
                                 */
                                var led = await _userManager.SetLockoutEndDateAsync(user, DateTimeOffset.UtcNow.AddYears(100));
                                if (led.Succeeded)
                                {
                                    result = new ApiResult(ApiCode.Success, "OK");
                                }
                                else
                                {
                                    result = new ApiResult(ApiCode.LockUserHaveError, "锁定用户时遇到错误" + string.Join(';', led.Errors.Select(c => $"{c.Code}-{c.Description}")));
                                }
                            }
                            else
                            {
                                result = new ApiResult(ApiCode.CanNotLockUser, "无法锁定此用户" + string.Join(';', lce.Errors.Select(c => $"{c.Code}-{c.Description}")));
                            }
                        }
                        break;

                    case LockOpt.Unlock:
                        if (User.GetUserId() == dto.Id)
                        {
                            result = new ApiResult(ApiCode.CanNotUnlockYourself, "不能自己解锁自己账号");
                        }
                        else
                        {
                            if (les)
                            {
                                var led = await _userManager.SetLockoutEndDateAsync(user, DateTimeOffset.UtcNow);

                                if (led.Succeeded)
                                {
                                    var uld = await _userManager.SetLockoutEnabledAsync(user, false);
                                    if (uld.Succeeded)
                                    {
                                        result = new ApiResult(ApiCode.Success, "OK");
                                    }
                                    else
                                    {
                                        result = new ApiResult(ApiCode.LockUserHaveError, "解锁用户时遇到错误" + string.Join(';', uld.Errors.Select(c => $"{c.Code}-{c.Description}")));
                                    }
                                }
                                else
                                {
                                    result = new ApiResult(ApiCode.UnLockUserHaveError, "解锁用户时遇到错误" + string.Join(';', led.Errors.Select(c => $"{c.Code}-{c.Description}")));
                                }
                            }
                            else
                            {
                                result = new ApiResult(ApiCode.CanNotUnLockUser, "无法解锁此用户");
                            }
                        }
                        break;

                    default:
                        break;
                }
            }
            else
            {
                result = new ApiResult(ApiCode.NotFoundUser, "未找到此用户");
            }

            return result;
        }

        /// <summary>
        /// 修改用户信息
        /// </summary>
        /// <returns></returns>
        [HttpPut]
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," +
            nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        public async Task<ApiResult<bool>> Modify(UserItemDto user)
        {
            if (user is null || string.IsNullOrWhiteSpace(user.Id))
            {
                return new ApiResult<bool>(ApiCode.InValidData, "user id is required", false);
            }

            var idu = await _userManager.FindByIdAsync(user.Id);
            if (idu is null)
            {
                return new ApiResult<bool>(ApiCode.NotFoundUser, "can't find that user", false);
            }

            var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var tenantAdmin = User.IsInRole(nameof(UserRole.TenantAdmin));
            var customerAdmin = User.IsInRole(nameof(UserRole.CustomerAdmin));
            var targetClaims = await _userManager.GetClaimsAsync(idu);
            if (!systemAdmin)
            {
                var sameTenant = targetClaims.Any(c => c.Type == IoTSharpClaimTypes.Tenant &&
                    Guid.TryParse(c.Value, out var t) && t == User.GetTenantId());
                var sameCustomer = targetClaims.Any(c => c.Type == IoTSharpClaimTypes.Customer &&
                    Guid.TryParse(c.Value, out var cId) && cId == User.GetCustomerId());
                if (!sameTenant || (!tenantAdmin && (!customerAdmin || !sameCustomer)))
                    return new ApiResult<bool>(ApiCode.DoNotAllow, "不能修改其他租户或客户账号", false);
            }
            var iamBound = targetClaims.Any(c => c.Type == IndustrialClaimTypes.GlobalUserId);
            // A requested customer change is a real local binding operation,
            // never merely a display change in the edit form.
            IoTSharp.Data.Customer? targetCustomer = null;
            var currentCustomerId = targetClaims
                .Where(c => c.Type == IoTSharpClaimTypes.Customer)
                .Select(c => Guid.TryParse(c.Value, out var id) ? id : Guid.Empty)
                .FirstOrDefault();
            var currentTenantId = targetClaims
                .Where(c => c.Type == IoTSharpClaimTypes.Tenant)
                .Select(c => Guid.TryParse(c.Value, out var id) ? id : Guid.Empty)
                .FirstOrDefault();
            if (user.CustomerId != Guid.Empty)
            {
                targetCustomer = await _context.Customer.Include(c => c.Tenant)
                    .SingleOrDefaultAsync(c => c.Id == user.CustomerId && !c.Deleted);
                if (targetCustomer?.Tenant == null)
                    return new ApiResult<bool>(ApiCode.NotFoundCustomer, "所选客户不存在或已删除", false);
                if (!IoTSharp.Services.Accounts.AccountCreationScope.IsAllowed(
                    systemAdmin, tenantAdmin, customerAdmin, User.GetTenantId(),
                    User.GetCustomerId(), targetCustomer.Tenant.Id, targetCustomer.Id))
                    return new ApiResult<bool>(ApiCode.DoNotAllow, "无权将账号绑定至该客户", false);
                if (iamBound && !systemAdmin &&
                    (targetCustomer.Id != currentCustomerId ||
                     targetCustomer.Tenant.Id != currentTenantId))
                    return new ApiResult<bool>(ApiCode.DoNotAllow,
                        "IAM 账号的本地客户归属仅可由系统管理员修改", false);
                if (!systemAdmin && (await _userManager.IsInRoleAsync(idu,
                        nameof(UserRole.SystemAdmin)) ||
                    await _userManager.IsInRoleAsync(idu, nameof(UserRole.TenantAdmin))) &&
                    (targetCustomer.Id != currentCustomerId ||
                     targetCustomer.Tenant.Id != currentTenantId))
                    return new ApiResult<bool>(ApiCode.DoNotAllow,
                        "不能修改上级管理员账号的客户归属", false);
            }
            List<string>? desiredRoles = null;
            if (user.RoleNames is not null)
            {
                var requested = await ResolveAccountRolesAsync(user.RoleNames);
                if (requested.Names is null)
                    return new ApiResult<bool>(requested.Code, requested.Error, false);
                desiredRoles = requested.Names;
                if (!systemAdmin)
                {
                    var existing = await _userManager.GetRolesAsync(idu);
                    if (existing.Any(x => !string.Equals(x,
                        nameof(UserRole.NormalUser), StringComparison.OrdinalIgnoreCase)))
                        return new ApiResult<bool>(ApiCode.DoNotAllow,
                            "仅系统管理员可修改拥有管理或自定义角色的用户", false);
                }
            }
            var username = user.UserName?.Trim();
            var email = user.Email?.Trim();
            if (user.DisplayName?.Trim().Length > 80 ||
                username is { Length: > 256 } ||
                email is { Length: > 256 })
                return new ApiResult<bool>(ApiCode.InValidData, "用户资料超出最大长度", false);
            if (iamBound &&
                ((username is not null && username != idu.UserName) ||
                 (email is not null && email != idu.Email)))
                return new ApiResult<bool>(ApiCode.DoNotAllow,
                    "IAM 登录账号和邮箱由上游维护；可编辑本地姓名、电话", false);
            if (!iamBound && (username is { Length: 0 } || email is { Length: 0 }))
                return new ApiResult<bool>(ApiCode.InValidData, "登录账号与邮箱不能为空", false);

            // Update Identity and its name/email claims in one transaction.
            // External IAM credentials are never overwritten by a local edit.
            await using var transaction = desiredRoles is null
                ? await _context.Database.BeginTransactionAsync()
                : await _context.Database.BeginTransactionAsync(
                    System.Data.IsolationLevel.Serializable);
            var originalEmail = idu.Email;
            var originalRoleNames = desiredRoles is null ? null
                : (await _userManager.GetRolesAsync(idu)).ToArray();
            if (!iamBound)
            {
                if (username is not null) idu.UserName = username;
                if (email is not null) idu.Email = email;
            }
            idu.PhoneNumber = user.PhoneNumber;
            var result = await _userManager.UpdateAsync(idu);
            if (!result.Succeeded)
                return new ApiResult<bool>(ApiCode.InValidData,
                    string.Join("; ", result.Errors.Select(x => x.Description)), false);

            if (!iamBound && !string.Equals(originalEmail, idu.Email, StringComparison.OrdinalIgnoreCase))
            {
                var oldEmailClaims = targetClaims.Where(c => c.Type == ClaimTypes.Email).ToArray();
                if (oldEmailClaims.Length > 0 &&
                    !(await _userManager.RemoveClaimsAsync(idu, oldEmailClaims)).Succeeded)
                    return new ApiResult<bool>(ApiCode.InValidData, "更新邮箱声明失败", false);
                if (!string.IsNullOrEmpty(idu.Email) &&
                    !(await _userManager.AddClaimAsync(idu,
                        new Claim(ClaimTypes.Email, idu.Email))).Succeeded)
                    return new ApiResult<bool>(ApiCode.InValidData, "保存邮箱声明失败", false);
            }
            if (user.DisplayName is not null)
            {
                var previousNames = targetClaims.Where(c =>
                    c.Type == ClaimTypes.GivenName || c.Type == "display_name").ToArray();
                if (previousNames.Length > 0 &&
                    !(await _userManager.RemoveClaimsAsync(idu, previousNames)).Succeeded)
                    return new ApiResult<bool>(ApiCode.InValidData, "更新姓名失败", false);
                if (!string.IsNullOrWhiteSpace(user.DisplayName) &&
                    !(await _userManager.AddClaimAsync(idu,
                        new Claim(ClaimTypes.GivenName, user.DisplayName.Trim()))).Succeeded)
                {
                    return new ApiResult<bool>(ApiCode.InValidData, "保存姓名失败", false);
                }
            }
            if (targetCustomer != null)
            {
                if (currentCustomerId != targetCustomer.Id ||
                    currentTenantId != targetCustomer.Tenant.Id)
                {
                    var oldScopes = targetClaims.Where(c =>
                        c.Type == IoTSharpClaimTypes.Customer ||
                        c.Type == IoTSharpClaimTypes.Tenant).ToArray();
                    if (oldScopes.Length > 0 &&
                        !(await _userManager.RemoveClaimsAsync(idu, oldScopes)).Succeeded)
                        return new ApiResult<bool>(ApiCode.InValidData, "移除原客户归属失败", false);
                    var newScopes = new[]
                    {
                        new Claim(IoTSharpClaimTypes.Customer, targetCustomer.Id.ToString("D")),
                        new Claim(IoTSharpClaimTypes.Tenant, targetCustomer.Tenant.Id.ToString("D"))
                    };
                    if (!(await _userManager.AddClaimsAsync(idu, newScopes)).Succeeded)
                        return new ApiResult<bool>(ApiCode.InValidData, "写入客户归属失败", false);
                }
                // Correct legacy Relationship drift even if the Identity
                // claims already point at the selected customer.
                var links = await _context.Relationship
                    .Include(r => r.Customer).Include(r => r.Tenant)
                    .Where(r => r.IdentityUser.Id == idu.Id).ToListAsync();
                if (links.Count == 0)
                {
                    _context.Relationship.Add(new Relationship
                    {
                        IdentityUser = idu, Customer = targetCustomer,
                        Tenant = targetCustomer.Tenant
                    });
                }
                else
                {
                    foreach (var link in links)
                    {
                        link.Customer = targetCustomer;
                        link.Tenant = targetCustomer.Tenant;
                    }
                }
                await _context.SaveChangesAsync();
                _logger.LogInformation(
                    "User customer binding updated actor={Actor} target={Target} from={From} to={To}",
                    User.FindFirst(ClaimTypes.NameIdentifier)?.Value, idu.Id,
                    currentCustomerId, targetCustomer.Id);
            }
            if (desiredRoles is not null)
            {
                var existing = await _userManager.GetRolesAsync(idu);
                var removed = existing.Except(desiredRoles,
                    StringComparer.OrdinalIgnoreCase).ToArray();
                var added = desiredRoles.Except(existing,
                    StringComparer.OrdinalIgnoreCase).ToArray();
                if (removed.Contains(nameof(UserRole.SystemAdmin),
                        StringComparer.OrdinalIgnoreCase))
                {
                    if (idu.Id == User.FindFirst(ClaimTypes.NameIdentifier)?.Value)
                        return new ApiResult<bool>(ApiCode.DoNotAllow,
                            "不能撤销当前登录的系统管理员身份", false);
                    var sysAdminRole = await _context.Roles.AsNoTracking()
                        .SingleOrDefaultAsync(r => r.NormalizedName ==
                            nameof(UserRole.SystemAdmin).ToUpperInvariant());
                    if (sysAdminRole is not null &&
                        await _context.UserRoles.CountAsync(x =>
                            x.RoleId == sysAdminRole.Id) <= 1)
                        return new ApiResult<bool>(ApiCode.DoNotAllow,
                            "不能移除最后一个系统管理员", false);
                }
                if (removed.Length > 0)
                {
                    var removeResult = await _userManager.RemoveFromRolesAsync(idu, removed);
                    if (!removeResult.Succeeded)
                        return new ApiResult<bool>(ApiCode.InValidData,
                            "移除旧角色失败：" + string.Join("; ",
                                removeResult.Errors.Select(x => x.Description)), false);
                }
                if (added.Length > 0)
                {
                    var addResult = await _userManager.AddToRolesAsync(idu, added);
                    if (!addResult.Succeeded)
                        return new ApiResult<bool>(ApiCode.InValidData,
                            "添加新角色失败：" + string.Join("; ",
                                addResult.Errors.Select(x => x.Description)), false);
                }
            }
            AddUserManagementAudit(idu, "USER_UPDATED",
                targetCustomer?.Tenant?.Id ?? currentTenantId,
                targetCustomer?.Id ?? currentCustomerId,
                new { userId = idu.Id,
                    customerBefore = currentCustomerId,
                    customerAfter = targetCustomer?.Id ?? currentCustomerId,
                    tenantBefore = currentTenantId,
                    tenantAfter = targetCustomer?.Tenant?.Id ?? currentTenantId,
                    beforeRoles = originalRoleNames,
                    afterRoles = desiredRoles,
                    profileChanged = user.DisplayName is not null ||
                        user.UserName is not null || user.Email is not null ||
                        user.PhoneNumber is not null });
            await _context.SaveChangesAsync();
            await transaction.CommitAsync();
            if (desiredRoles is not null)
                _logger.LogInformation("User roles modified: actor={Actor} target={Target} roles={Roles}",
                    User.FindFirst(ClaimTypes.NameIdentifier)?.Value, idu.Id,
                    string.Join(",", desiredRoles));
            _logger.LogInformation("User profile modified: actor={ActorId} target={TargetId} iam={IamBound}",
                User.FindFirst(ClaimTypes.NameIdentifier)?.Value, idu.Id, iamBound);
            return new ApiResult<bool>(ApiCode.Success, "用户资料已保存", true);
        }

        /// <summary>
        /// 删除 IoTSharp 本地用户/Identity 镜像，不会删除上游 IAM 人员。
        /// 角色与客户范围在服务器校验；不得删除当前登录用户或最后一个系统管理员。
        /// </summary>
        [HttpDelete("{id}")]
        [Authorize(Roles = nameof(UserRole.CustomerAdmin) + "," +
            nameof(UserRole.TenantAdmin) + "," + nameof(UserRole.SystemAdmin))]
        public async Task<ApiResult<bool>> Delete(string id)
        {
            if (string.IsNullOrWhiteSpace(id))
                return new ApiResult<bool>(ApiCode.InValidData, "用户 ID 不能为空", false);
            var target = await _userManager.FindByIdAsync(id);
            if (target is null)
                return new ApiResult<bool>(ApiCode.NotFoundUser, "用户不存在", false);
            var actorId = User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (string.Equals(target.Id, actorId, StringComparison.OrdinalIgnoreCase))
                return new ApiResult<bool>(ApiCode.DoNotAllow, "不能删除当前登录账号", false);
            var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var tenantAdmin = User.IsInRole(nameof(UserRole.TenantAdmin));
            var targetClaims = await _userManager.GetClaimsAsync(target);
            var iamBound = targetClaims.Any(c => c.Type == IndustrialClaimTypes.GlobalUserId);
            if (iamBound && !systemAdmin)
                return new ApiResult<bool>(ApiCode.DoNotAllow, "仅系统超级管理员可删除 IAM 本地镜像", false);
            if (!systemAdmin)
            {
                var sameTenant = targetClaims.Any(c => c.Type == IoTSharpClaimTypes.Tenant &&
                    Guid.TryParse(c.Value, out var t) && t == User.GetTenantId());
                var sameCustomer = targetClaims.Any(c => c.Type == IoTSharpClaimTypes.Customer &&
                    Guid.TryParse(c.Value, out var cId) && cId == User.GetCustomerId());
                if (!sameTenant || (!tenantAdmin && !sameCustomer))
                    return new ApiResult<bool>(ApiCode.DoNotAllow, "不能删除其他租户或客户用户", false);
            }
            var targetIsSystemAdmin = await _userManager.IsInRoleAsync(target,
                nameof(UserRole.SystemAdmin));
            if (targetIsSystemAdmin)
            {
                if (!systemAdmin)
                    return new ApiResult<bool>(ApiCode.DoNotAllow, "仅系统管理员可删除系统管理员账号", false);
                var role = await _context.Roles.AsNoTracking().SingleOrDefaultAsync(
                    x => x.NormalizedName == nameof(UserRole.SystemAdmin).ToUpperInvariant());
                if (role is not null &&
                    await _context.UserRoles.CountAsync(x => x.RoleId == role.Id) <= 1)
                    return new ApiResult<bool>(ApiCode.DoNotAllow, "不能删除最后一个系统管理员", false);
            }
            await using var transaction = await _context.Database.BeginTransactionAsync();
            try
            {
                // Explicitly remove related rows that may not cascade for legacy schemas.
                var relationships = await _context.Relationship
                    .Where(x => x.IdentityUser.Id == target.Id).ToListAsync();
                _context.Relationship.RemoveRange(relationships);
                var tokens = await _context.RefreshTokens
                    .Where(x => x.UserId == target.Id).ToListAsync();
                _context.RefreshTokens.RemoveRange(tokens);
                await _context.SaveChangesAsync();
                var deleted = await _userManager.DeleteAsync(target);
                if (!deleted.Succeeded)
                    return new ApiResult<bool>(ApiCode.InValidData,
                        string.Join("; ", deleted.Errors.Select(x => x.Description)), false);
                await transaction.CommitAsync();
                _logger.LogInformation(
                    "Local account deleted: actor={ActorId} target={TargetId} iamShadow={IamShadow}",
                    actorId, target.Id, iamBound);
                return new ApiResult<bool>(ApiCode.Success,
                    iamBound ? "已删除本地 IAM 镜像；上游身份未删除，重新同步可能重建"
                             : "用户账号已删除", true);
            }
            catch (DbUpdateException ex)
            {
                _logger.LogWarning(ex, "User deletion blocked by related data, target={TargetId}", id);
                return new ApiResult<bool>(ApiCode.InValidData,
                    "用户存在受保护关联数据，删除失败且未更改账号", false);
            }
        }

        /// <summary>
        /// 修改当前用户信息
        /// </summary>
        /// <returns></returns>
        [HttpPut]
        public async Task<ApiResult<bool>> ModifyMyInfo(UserItemDto user)
        {
            var cuser = await _userManager.GetUserAsync(User);
            cuser.PhoneNumber = user.PhoneNumber;
            var result = await _userManager.UpdateAsync(cuser);
            return new ApiResult<bool>(ApiCode.Success, "Ok", result.Succeeded);
        }

        /// <summary>
        /// 修改当前用户信息
        /// </summary>
        /// <returns></returns>
        [HttpPut]
        public async Task<ApiResult<bool>> ModifyMyPassword(UserPassword password)
        {
            if (password is null || string.IsNullOrWhiteSpace(password.Pass) || string.IsNullOrWhiteSpace(password.PassNew) || string.IsNullOrWhiteSpace(password.PassNewSecond))
            {
                return new ApiResult<bool>(ApiCode.InValidData, "password payload is invalid", false);
            }

            if (password.PassNew.Length > 6)
            {
                if (password.PassNew == password.PassNewSecond)
                {
                    var cuser = await _userManager.GetUserAsync(User);
                    if (cuser is null)
                    {
                        return new ApiResult<bool>(ApiCode.NotFoundUser, "can't find current user", false);
                    }

                    var result = await _signInManager.UserManager.ChangePasswordAsync(cuser, password.Pass, password.PassNew);
                    if (result.Succeeded)
                    {
                        return new ApiResult<bool>(ApiCode.Success, "Ok", result.Succeeded);
                    }
                    return new ApiResult<bool>(ApiCode.InValidData, result.Errors.Aggregate("", (x, y) => x + y.Description + "\n\r"), false);
                }
                return new ApiResult<bool>(ApiCode.InValidData, "Repeat password must be equal new password", false);
            }
            return new ApiResult<bool>(ApiCode.InValidData, "password length must great than six character", false);
        }

        [AllowAnonymous]
        [HttpGet]
        public ApiResult<bool> CheckExist(string email, int type)
        {
            if (string.IsNullOrEmpty(email))
            {
                return new ApiResult<bool>(ApiCode.Success, "OK", false);
            }
            else
            {
                switch (type)
                {
                    case 1:
                        return new ApiResult<bool>(ApiCode.Success, "OK", _context.Tenant.Any(c => c.Email.ToLower() == email.ToLower() && c.Deleted == false));

                    case 2:
                        return new ApiResult<bool>(ApiCode.Success, "OK", _context.Customer.Any(c => c.Email.ToLower() == email.ToLower() && c.Deleted == false));

                    case 3:
                        return new ApiResult<bool>(ApiCode.Success, "OK", _context.Users.Any(c => c.Email.ToLower() == email.ToLower()));
                }
                return new ApiResult<bool>(ApiCode.Success, "OK", false);
            }
        }
        [AllowAnonymous]
        [HttpGet]
        public async Task<ApiResult> ResetPasswordAsync(string email, string rootkey, string newpassword)
        {
            IdentityUser user = await _userManager.FindByEmailAsync(email);
            if (user == null)
            {
                return new ApiResult(ApiCode.NotFoundUser, "用户为空");
            }
            else
            {
                if (!string.IsNullOrEmpty(rootkey) && rootkey == _settings.RootKey)
                {
                    if (user.LockoutEnabled)
                    {
                        var ck = await Lock(new LockDto() { Id = new Guid(user.Id), Opt = LockOpt.Unlock });
                    }
                    await _userManager.ResetAccessFailedCountAsync(user);
                    var token = await _userManager.GeneratePasswordResetTokenAsync(user);
                    var rest = await _userManager.ResetPasswordAsync(user, token, newpassword);
                    if (rest.Succeeded)
                    {
                        return new ApiResult(ApiCode.Success, "OK");
                    }
                    else
                    {
                        var errinfo = string.Join(',', rest.Errors.Select(c => $"{c.Code}-{c.Description}").ToList());
                        return new ApiResult(ApiCode.Exception, errinfo);
                    }
                }
                else
                {
                    return new ApiResult(ApiCode.InValidData, "根密码不对，请修改服务器配置文件。");
                }

            }
        }
    }
}
