using RulesEngine.Models;
using Microsoft.Extensions.Caching.Memory;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace IoTSharp.FlowRuleEngine
{
    public interface IFlowExcutor<T>
    {
        Task<List<RuleResultTree>> Excute(T Input);
    }

    public interface IFlowEntity
    {
    }

    public class FlowExcuteEntity : IFlowEntity
    {
        public dynamic Params { get; set; }
        public BaseRuleTask Task { get; set; }
        //public Action Action { get; set; }
        //public int WaitTime { get; set; }
    }

    public class SimpleFlowExcutor : IFlowExcutor<FlowExcuteEntity>
    {
        private static readonly MemoryCache EngineCache = new(new MemoryCacheOptions
        {
            SizeLimit = 1024
        });

        /// <summary>
        /// 调用规则引擎处理线上的逻辑，判断是否为 True，用来判断是否继续进行下一步节点。
        /// </summary>
        /// <param name="Input">流程执行上下文，包含当前任务、外连线规则和输入参数。</param>
        /// <returns>每条外连线规则的执行结果。</returns>
        public async Task<List<RuleResultTree>> Excute(FlowExcuteEntity Input)
        {
            ArgumentNullException.ThrowIfNull(Input);
            ArgumentNullException.ThrowIfNull(Input.Task);
            var key = BuildEngineCacheKey(Input.Task);
            var bre = EngineCache.GetOrCreate(key, entry =>
            {
                entry.Size = 1;
                entry.SetSlidingExpiration(TimeSpan.FromMinutes(10));
                var mainRules = new Workflow
                {
                    WorkflowName = Input.Task.id,
                    Rules = Input.Task.outgoing.Select(c => c.Rule).ToList()
                };
                return new RulesEngine.RulesEngine(new[] { mainRules }, null);
            });
            return await bre.ExecuteAllRulesAsync(Input.Task.id, Input.Params);
        }

        private static string BuildEngineCacheKey(BaseRuleTask task)
        {
            var builder = new StringBuilder(task.id?.Length + 64 ?? 64);
            builder.Append(task.id).Append('|').Append(task.outgoing?.Count ?? 0);
            if (task.outgoing != null)
            {
                foreach (var rule in task.outgoing)
                {
                    builder.Append('|').Append(rule.id)
                        .Append(':').Append(rule.Expression);
                }
            }
            return builder.ToString();
        }
    }
}
