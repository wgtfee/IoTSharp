using IoTSharp.Contracts;
using IoTSharp.Controllers.Models;
using IoTSharp.Data;
using IoTSharp.Dtos;
using IoTSharp.Extensions;
using IoTSharp.Models;
using IoTSharp.IndustrialSecurity;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Dynamic.Core;
using System.Linq.Expressions;
using System.Threading.Tasks;
using Customer = IoTSharp.Data.Customer;

namespace IoTSharp.Controllers
{
    /// <summary>
    /// 客户管理
    /// </summary>
    [Route("api/[controller]")]
    [Authorize]
    [ApiController]
    public class CustomersController : ControllerBase
    {
        private readonly ApplicationDbContext _context;

        public CustomersController(ApplicationDbContext context)
        {
            _context = context;
        }

        private bool CanReadCustomer(Customer customer)
        {
            if (customer is null || customer.Deleted) return false;
            if (User.IsInRole(nameof(UserRole.SystemAdmin))) return true;
            var profile = this.GetUserProfile();
            return profile.Tenant != Guid.Empty &&
                customer.Tenant?.Id == profile.Tenant &&
                (User.IsInRole(nameof(UserRole.TenantAdmin)) ||
                 (profile.Customer != Guid.Empty && customer.Id == profile.Customer));
        }

        /// <summary>
        /// 获取指定租户下的所有客户
        /// </summary>
        /// <returns></returns>
        [HttpPost("Tenant/{tenantId}/All")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesResponseType(StatusCodes.Status403Forbidden)]
        [ProducesDefaultResponseType]
        public async Task<ActionResult<ApiResult<List<Customer>>>> GetAllCustomers([FromRoute] Guid tenantId)
        {
            // 租户范围由本地账号绑定决定，调用者不能通过 URL 切换到其他租户。
            var profile = this.GetUserProfile();
            if (!User.IsInRole(nameof(UserRole.SystemAdmin))
                && (profile.Tenant == Guid.Empty || tenantId != profile.Tenant))
                return Forbid();
            var query = _context.Customer.AsNoTracking()
                .Where(c => c.Tenant.Id == tenantId && !c.Deleted);
            if (!User.IsInRole(nameof(UserRole.SystemAdmin)) &&
                !User.IsInRole(nameof(UserRole.TenantAdmin)))
                query = query.Where(c => c.Id == profile.Customer);
            return new ApiResult<List<Customer>>(ApiCode.Success, "OK",
                await query.OrderBy(c => c.Name).ToListAsync());
        }

        /// <summary>
        /// 获取指定租户下的所有客户
        /// </summary>
        /// <returns></returns>
        [HttpPost("Tenant")]
        [IotRequirePermission("iot.tenant.admin")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesDefaultResponseType]
        public async Task<ActionResult<ApiResult<PagedData<Customer>>>> GetCustomers([FromBody] CustomerParam m)
        {
            var profile = this.GetUserProfile();
            if (!User.IsInRole(nameof(UserRole.SystemAdmin))
                && (profile.Tenant == Guid.Empty || m.tenantId != profile.Tenant))
                return Forbid();
            if (m.tenantId != Guid.Empty)
            {
                var querym = _context.Customer.Include(c => c.Tenant).Where(c => !c.Deleted && c.Tenant.Id == m.tenantId);
                var data = await m.Query(querym, c => c.Name);
                return new ApiResult<PagedData<Customer>>(ApiCode.Success, "OK", data);
            }
            else
            {

                return new ApiResult<PagedData<Customer>>(ApiCode.NotFoundCustomer, "没有指定客户ID", new PagedData<Customer>());
            }

        }

        /// <summary>
        /// 获取指定用户下的AI设置
        /// </summary>
        /// <returns></returns>
        [HttpPost("{customerId}/ai")]
        [IotRequirePermission("iot.customer.admin")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesDefaultResponseType]
        public async Task<ApiResult<AISettingsDto>> SetAISettings([FromRoute] Guid customerId, [FromBody] AISettingsSetDto dto)
        {
            var profile = this.GetUserProfile();
            if (!User.IsInRole(nameof(UserRole.SystemAdmin)) &&
                !User.IsInRole(nameof(UserRole.TenantAdmin)) &&
                (profile.Customer == Guid.Empty || customerId != profile.Customer))
                return new ApiResult<AISettingsDto>(ApiCode.DoNotAllow,
                    "无权修改其他客户的AI设置", null);
            if (customerId != Guid.Empty)
            {
                var querym = _context.Customer.Include(c => c.Tenant).Include(s => s.AISettings).Where(c => !c.Deleted && c.Id == customerId && (User.IsInRole(nameof(UserRole.SystemAdmin)) || c.Tenant.Id == profile.Tenant));
                if (querym.Any())
                {
                    var d = await querym.FirstOrDefaultAsync();

                    if (d.AISettings == null)
                    {
                        var dx = new AISettings();
                        dx.Id = Guid.NewGuid();
                        dx.Role = UserRole.CustomerAdmin;
                        _context.AISettings.Add(dx);
                        d.AISettings = dx;
                    }
                    d.AISettings.Enable = dto.Enable;
                    d.AISettings.Role = UserRole.CustomerAdmin;
                    if (string.IsNullOrWhiteSpace(d.AISettings.MCP_API_KEY) || dto.RegenerateApiKey)
                    {
                        d.AISettings.MCP_API_KEY = Guid.NewGuid().ToString("D");
                    }
                    d.AISettings.Name = dto.Name;
                    int ret = await _context.SaveChangesAsync();
                    var dtor = new AISettingsDto() { Enable = d.AISettings.Enable, MCP_API_KEY = d.AISettings.MCP_API_KEY, Name = d.AISettings.Name };
                    return new ApiResult<AISettingsDto>(ApiCode.Success, "OK", dtor);
                }
                else
                {
                    return new ApiResult<AISettingsDto>(ApiCode.NotFoundCustomer, "没有指定客户", new AISettingsDto());
                }
            }
            else
            {

                return new ApiResult<AISettingsDto>(ApiCode.InValidData, "传入的客户ID为空", new AISettingsDto());
            }

        }

        /// <summary>
        /// 获取指定用户下的AI设置
        /// </summary>
        /// <returns></returns>
        [HttpGet("{customerId}/ai")]
        [IotRequirePermission("iot.customer.admin")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesDefaultResponseType]
        public async Task<ApiResult<AISettingsDto>> GetAISettings([FromRoute] Guid customerId)
        {
            var profile = this.GetUserProfile();
            if (!User.IsInRole(nameof(UserRole.SystemAdmin)) &&
                !User.IsInRole(nameof(UserRole.TenantAdmin)) &&
                (profile.Customer == Guid.Empty || customerId != profile.Customer))
                return new ApiResult<AISettingsDto>(ApiCode.DoNotAllow,
                    "无权查看其他客户的AI设置", null);
            if (customerId != Guid.Empty)
            {
                var querym = _context.Customer.Include(c => c.Tenant).Include(s => s.AISettings).Where(c => !c.Deleted && c.Id == customerId && (User.IsInRole(nameof(UserRole.SystemAdmin)) || c.Tenant.Id == profile.Tenant));
                if (querym.Any())
                {
                    var d = await querym.FirstOrDefaultAsync();
                    var s = d?.AISettings ?? new AISettings() { Name = "None" };
                    var data = new AISettingsDto() { Enable = s.Enable, MCP_API_KEY = s.MCP_API_KEY, Name = s.Name };
                    return new ApiResult<AISettingsDto>(ApiCode.Success, "OK", data);
                }
                else
                {
                    return new ApiResult<AISettingsDto>(ApiCode.NotFoundCustomer, "没有指定客户", new AISettingsDto());
                }
            }
            else
            {

                return new ApiResult<AISettingsDto>(ApiCode.InValidData, "传入的客户ID为空", new AISettingsDto());
            }

        }


        /// <summary>
        /// 返回指定id的客户
        /// </summary>
        /// <param name="id"></param>
        /// <returns></returns>
        [HttpGet("{id}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesDefaultResponseType]
        public async Task<ApiResult<Customer>> GetCustomer(Guid id)
        {
            var customer = await _context.Customer.AsNoTracking()
                .Include(c => c.Tenant).FirstOrDefaultAsync(c => c.Id == id);
            if (!CanReadCustomer(customer))
            {
                return new ApiResult<Customer>(ApiCode.NotFoundCustomer, "This customer was not found", null);
            }
            return new ApiResult<Customer>(ApiCode.Success, "OK", customer);
        }

        /// <summary>
        /// 修改指定租户为 指定的信息
        /// </summary>
        /// <param name="id"></param>
        /// <param name="customer"></param>
        /// <returns></returns>
        [IotRequirePermission("iot.customer.admin")]
        [HttpPut("{id}")]
        [ProducesResponseType(StatusCodes.Status204NoContent)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesDefaultResponseType]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public async Task<ApiResult<Customer>> PutCustomer(Guid id, CustomerDto customer)
        {
            if (customer is null || id == Guid.Empty || id != customer.Id)
            {
                return new ApiResult<Customer>(ApiCode.InValidData, "InValidData", null);
            }
            var current = await _context.Customer.Include(c => c.Tenant)
                .FirstOrDefaultAsync(c => c.Id == id && !c.Deleted);
            if (current is null || !CanReadCustomer(current))
                return new ApiResult<Customer>(ApiCode.NotFoundCustomer,
                    "客户不存在或不在当前授权范围", null);
            if (customer.TenantId != Guid.Empty &&
                customer.TenantId != current.Tenant.Id)
            {
                // Moving a customer across tenants must also reconcile device,
                // asset, user identity claims and audit ownership. Never
                // silently change only the parent FK in a generic edit form.
                return new ApiResult<Customer>(ApiCode.InValidData,
                    "跨租户迁移必须使用独立、可审计的数据迁移流程", null);
            }
            // Never overwrite Deleted, Id, AISettings or navigation properties
            // from client-provided entity objects.
            current.Name = customer.Name;
            current.Email = customer.Email;
            current.Phone = customer.Phone;
            current.Country = customer.Country;
            current.Province = customer.Province;
            current.City = customer.City;
            current.Street = customer.Street;
            current.Address = customer.Address;
            current.ZipCode = customer.ZipCode;
            try
            {
                await _context.SaveChangesAsync();

                return new ApiResult<Customer>(ApiCode.Success, "", current);
            }
            catch (DbUpdateConcurrencyException)
            {
                if (!_context.Customer.Any(e => e.Id == id && !e.Deleted))
                {
                    return new ApiResult<Customer>(ApiCode.NotFoundCustomer, "This customer was not found", null);
                }
                else
                {
                    throw;
                }
            }
        }

        /// <summary>
        /// 为当前客户所在的租户新增客户
        /// </summary>
        /// <param name="customer"></param>
        /// <returns></returns>
        [IotRequirePermission("iot.tenant.admin")]
        [HttpPost]
        public async Task<ApiResult<Customer>> PostCustomer(CustomerDto customer)
        {
            if (customer is null)
                return new ApiResult<Customer>(ApiCode.InValidData,
                    "客户参数不能为空", null);
            var profile = this.GetUserProfile();
            var systemAdmin = User.IsInRole(nameof(UserRole.SystemAdmin));
            var tenantId = systemAdmin && customer.TenantId != Guid.Empty
                ? customer.TenantId : profile.Tenant;
            if (tenantId == Guid.Empty ||
                (!systemAdmin && customer.TenantId != Guid.Empty &&
                 customer.TenantId != profile.Tenant))
                return new ApiResult<Customer>(ApiCode.DoNotAllow,
                    "不能在其他租户创建客户", null);
            var tent = await _context.Tenant.FirstOrDefaultAsync(t =>
                t.Id == tenantId && !t.Deleted);
            if (tent is null)
                return new ApiResult<Customer>(ApiCode.NotFoundTenantOrCustomer,
                    "所属租户不存在", null);
            customer.Tenant = tent;
            customer.Deleted = false;
            _context.Customer.Add(customer);
            await _context.SaveChangesAsync();

            return new ApiResult<Customer>(ApiCode.Success, "Ok", await _context.Customer.SingleOrDefaultAsync(c => c.Id == customer.Id));
        }

        /// <summary>
        /// 删除指定的客户ID
        /// </summary>
        /// <param name="id"></param>
        /// <returns></returns>
        // DELETE: api/Customers/5
        [IotRequirePermission("iot.tenant.admin")]
        [HttpDelete("{id}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(typeof(ApiResult), StatusCodes.Status404NotFound)]
        [ProducesDefaultResponseType]
        public async Task<ApiResult<Customer>> DeleteCustomer(Guid id)
        {
            var customer = await _context.Customer.Include(c => c.Tenant)
                .FirstOrDefaultAsync(c => c.Id == id && !c.Deleted);
            var profile = this.GetUserProfile();
            if (customer == null || (!User.IsInRole(nameof(UserRole.SystemAdmin)) &&
                (profile.Tenant == Guid.Empty || customer.Tenant.Id != profile.Tenant)))
            {
                return new ApiResult<Customer>(ApiCode.NotFoundCustomer, "This customer was not found", null);
            }
            customer.Deleted = true;
            _context.Customer.Update(customer);
            await _context.SaveChangesAsync();
            return new ApiResult<Customer>(ApiCode.Success, "Ok", customer);
        }
    }
}
