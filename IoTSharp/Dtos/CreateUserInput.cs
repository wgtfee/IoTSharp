using static CLanguage.Report;
using System.ComponentModel.DataAnnotations;
using System;
using System.Collections.Generic;

namespace IoTSharp.Dtos
{
    public class CreateUserInput
    {
        /// <summary>
        /// 邮箱地址， 也是用户名，一个邮箱只能注册平台的一个客户，如果你在平台有两个租户都有账号，则需要两个邮箱地址。 
        /// </summary>
        [Required]
        public string Email { get; set; }
        /// <summary>
        /// 电话号码
        /// </summary>
        public string PhoneNumber { get; set; }

        /// <summary>登录用户名；未指定时使用邮箱。</summary>
        public string UserName { get; set; }
        /// <summary>用于指派、审计等页面的真实人员姓名。</summary>
        [StringLength(80)]
        public string DisplayName { get; set; }
        /// <summary>
        /// 
        /// </summary>
        public Guid CustomerId { get; set; }
        /// <summary>Explicit Identity role names; null keeps legacy NormalUser default.</summary>
        public List<string>? RoleNames { get; set; }

        /// <summary>
        /// 用户名密码
        /// </summary>
        [Required]
        [StringLength(100, MinimumLength = 6)]
        public string Password { get; set; }
    }
}
