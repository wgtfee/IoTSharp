using Castle.Components.DictionaryAdapter;
using EasyCaching.Core;
using IoTSharp.Data;
using IoTSharp.Interpreter;
using IoTSharp.TaskActions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.Dynamic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using IoTSharp.Extensions;
using IoTSharp.Contracts;
using IoTSharp.Data.Extensions;
using IoTSharp.EventBus;
using IoTSharp.Services.RuleAudit;

namespace IoTSharp.FlowRuleEngine
{
    public class FlowRuleProcessor
    {
        private readonly IServiceScopeFactory _scopeFactor;
        private readonly ILogger<FlowRuleProcessor> _logger;
        private readonly AppSettings _setting;
        private readonly IEasyCachingProvider _caching;
        private readonly IMemoryCache _memoryCache;
        private readonly FlowRuleAuditPipeline _auditPipeline;
        private readonly FlowRuleRuntimeExecutor _runtimeExecutor;
        private readonly TaskExecutorHelper _helper;
        private readonly int _maximumiteration = 1000;


        public FlowRuleProcessor(ILogger<FlowRuleProcessor> logger, IServiceScopeFactory scopeFactor, IOptions<AppSettings> options, TaskExecutorHelper helper, IEasyCachingProviderFactory factory, IMemoryCache memoryCache, FlowRuleAuditPipeline auditPipeline, FlowRuleRuntimeExecutor runtimeExecutor)
        {
            string _hc_Caching = $"{nameof(CachingUseIn)}-{Enum.GetName(options.Value.CachingUseIn)}";
            _scopeFactor = scopeFactor;
            _logger = logger;
            _setting = options.Value;
            _caching = factory.GetCachingProvider(_hc_Caching);
            _memoryCache = memoryCache;
            _auditPipeline = auditPipeline;
            _runtimeExecutor = runtimeExecutor;
            _helper = helper;
        }

        public async Task RunRules(Guid devid, object obj, EventType mountType)
        {
            try
            {
                var localCacheKey = $"flowrule:ruleids:l1:{devid:N}:{(int)mountType}";
                CacheValue<Guid[]> rules;
                if (!_memoryCache.TryGetValue(localCacheKey, out rules) || !rules.HasValue)
                {
                    rules = await _caching.GetAsync($"ruleid_{devid}_{Enum.GetName(mountType)}", async () =>
                    {
                        using (var scope = _scopeFactor.CreateScope())
                        using (var _dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>())
                        {
                            return await _dbContext.GerDeviceRulesIdList(devid, mountType);
                        }
                    }, GetLocalCacheDuration());

                    if (rules.HasValue)
                    {
                        _memoryCache.Set(localCacheKey, rules, GetLocalCacheDuration());
                    }
                }
                if (rules.HasValue && rules.Value != null)
                {
                    var ruleIds = rules.Value;
                    var maxConcurrency = Math.Clamp(_setting.RuleExecutionMaxConcurrency, 1, Math.Max(1, ruleIds.Length));

                    async Task ExecuteRuleAsync(Guid ruleId)
                    {
                        try
                        {
                            await RunFlowRules(ruleId, obj, devid, FlowRuleRunType.Normal, null);
                        }
                        catch (Exception ex)
                        {
                            _logger.LogError(ex, $"为设备{devid}执行规则链{ruleId}时遇到错误{ex.Message}");
                        }
                    }

                    if (ruleIds.Length <= maxConcurrency)
                    {
                        await Task.WhenAll(ruleIds.Select(ExecuteRuleAsync));
                    }
                    else
                    {
                        await Parallel.ForEachAsync(
                            ruleIds,
                            new ParallelOptions { MaxDegreeOfParallelism = maxConcurrency },
                            async (ruleId, _) => await ExecuteRuleAsync(ruleId));
                    }
                }
                else
                {
                    _logger.LogDebug($"{devid}的数据无相关规则链处理。");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"{devid}处理规则链时遇到异常:{ex.Message}");

            }
        }

        public async Task<bool> HasTelemetryRules(Guid devid)
            => await GetTelemetryRuleDispatchMode(devid) != TelemetryRuleDispatchMode.None;

        /// <summary>
        /// 获取设备实际挂载的遥测规则类型，用于在热路径上只构造需要的规则输入。
        /// 查询异常时返回 All，保持 fail-open，避免因为优化判断失败而漏执行规则。
        /// </summary>
        public async Task<TelemetryRuleDispatchMode> GetTelemetryRuleDispatchMode(Guid devid)
        {
            var localCacheKey = $"flowrule:telemetry-mode:l1:{devid:N}";
            if (_memoryCache.TryGetValue(localCacheKey, out TelemetryRuleDispatchMode localMode))
            {
                return localMode;
            }

            try
            {
                var cached = await _caching.GetAsync($"telemetryrules_mode_{devid}", async () =>
                {
                    using var scope = _scopeFactor.CreateScope();
                    using var dbContext = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
                    var mountTypes = await dbContext.DeviceRules.AsNoTracking()
                        .Where(rule => rule.Device.Id == devid
                            && (rule.FlowRule.MountType == EventType.Telemetry
                                || rule.FlowRule.MountType == EventType.TelemetryArray))
                        .Select(rule => rule.FlowRule.MountType)
                        .Distinct()
                        .ToListAsync();
                    var mode = TelemetryRuleDispatchMode.None;
                    foreach (var mountType in mountTypes)
                    {
                        mode |= mountType == EventType.Telemetry
                            ? TelemetryRuleDispatchMode.Telemetry
                            : TelemetryRuleDispatchMode.TelemetryArray;
                    }
                    return mode;
                }, GetLocalCacheDuration());
                if (cached.HasValue)
                {
                    _memoryCache.Set(localCacheKey, cached.Value, GetLocalCacheDuration());
                    return cached.Value;
                }

                return TelemetryRuleDispatchMode.All;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to check telemetry rule dispatch mode for device {DeviceId}; dispatching all telemetry rules fail-open.", devid);
                return TelemetryRuleDispatchMode.All;
            }
        }

        /// <summary>
        ///运行指定规则链的规则
        /// </summary>
        /// <param name="ruleid"> 规则Id</param>
        /// <param name="data">数据</param>
        /// <param name="deviceId">创建者(可以是模拟器(测试)，可以是设备，在EventType中区分一下)</param>
        /// <param name="type">类型</param>
        /// <param name="bizId">业务Id(第三方唯一Id，用于取回事件以及记录的标识)</param>
        /// <returns> 返回所有节点的记录信息，需要保存则保存</returns>

        public async Task<List<FlowOperation>> RunFlowRules(Guid ruleid, object data, Guid deviceId, FlowRuleRunType type, string bizId)
        {
            var cacheRule = await GetFlowRule(ruleid);
            if (cacheRule.HasValue)
            {
                FlowRule rule = cacheRule.Value.rule;
                var _allFlows = cacheRule.Value._allFlows;
                _logger.LogDebug("开始执行规则链 {RuleName}({RuleId})", rule?.Name, ruleid);
                var serializedData = JsonObjectSerializer.Serialize(data);
                var flows = _allFlows.Where(c => c.FlowType != "label").ToList();
                var start = flows.FirstOrDefault(c => c.FlowType == "bpmn:StartEvent");

                if (type == FlowRuleRunType.Normal)
                {
                    var eventId = Guid.NewGuid();
                    var createdAt = DateTime.UtcNow;
                    await _auditPipeline.EnqueueAsync(new FlowRuleAuditRecord(
                        eventId,
                        $"开始执行规则链{rule?.Name}({ruleid})",
                        $"Event Rule:{rule?.Name}({ruleid}) device is {deviceId}",
                        1,
                        type,
                        serializedData,
                        deviceId,
                        rule.RuleId,
                        bizId,
                        createdAt,
                        null));

                    if (start == null)
                    {
                        _logger.LogWarning("规则链 {RuleId} 未找到启动节点", ruleid);
                        return new List<FlowOperation>(0);
                    }

                    await _runtimeExecutor.ExecuteAsync(_allFlows, start, data, deviceId, serializedData);
                    return new List<FlowOperation>(0);
                }

                var _allflowoperation = new List<FlowOperation>();
                var @event = new BaseEvent()
                {
                    EventId = Guid.NewGuid(),
                    CreaterDateTime = DateTime.UtcNow,
                    Creator = deviceId,
                    EventDesc = $"Event Rule:{rule?.Name}({ruleid}) device is {deviceId}",
                    EventName = $"开始执行规则链{rule?.Name}({ruleid})",
                    MataData = serializedData,
                    FlowRule = rule,
                    Bizid = bizId,
                    Type = type,
                    EventStaus = 1
                };
                await PersistBaseEventAsync(@event, rule.RuleId);

                if (start == null)
                {
                    _allflowoperation.Add(new FlowOperation()
                    {
                        OperationId = Guid.NewGuid(),
                        bpmnid = "",
                        AddDate = DateTime.UtcNow,
                        FlowRule = rule,
                        Flow = start,
                        Data = serializedData,
                        NodeStatus = 1,
                        OperationDesc = "未能找到启动节点",
                        Step = 1,
                        BaseEvent = @event
                    });

                    return _allflowoperation;
                }
                var startoperation = new FlowOperation()
                {
                    OperationId = Guid.NewGuid(),
                    bpmnid = start.bpmnid,
                    AddDate = DateTime.UtcNow,
                    FlowRule = rule,
                    Flow = start,
                    Data = serializedData,
                    NodeStatus = 1,
                    OperationDesc = "进入开始节点",
                    Step = 1,
                    BaseEvent = @event
                };

                _allflowoperation.Add(startoperation);
                //从“开始节点”上链接的线节点对象进行规则判断，通过线对象上的规则才能进行后续逻辑
                var nextflows = await ProcessCondition(_allFlows, start.FlowId, data);
                //获取到的通过规则判断的后续节点列表
                if (nextflows != null)
                {
                    var step = startoperation.Step + 1;
                    foreach (var item in nextflows)
                    {
                        var flowOperation = new FlowOperation()
                        {
                            OperationId = Guid.NewGuid(),
                            AddDate = DateTime.UtcNow,
                            FlowRule = rule,
                            BaseEvent = @event,
                            Flow = item,
                            Data = serializedData,
                            NodeStatus = 1,
                            OperationDesc = "Condition（" + (string.IsNullOrEmpty(item.Conditionexpression)
                                ? "Empty Condition"
                                : item.Conditionexpression) + ")",
                            Step = step,
                            bpmnid = item.bpmnid,
                        };

                        _allflowoperation.Add(flowOperation);
                        //执行节点逻辑
                        await Process(_allFlows, _allflowoperation, flowOperation.OperationId, data, deviceId, serializedData);
                    }
                    return _allflowoperation;
                }
            }
            return null;
        }

        private async Task PersistBaseEventAsync(BaseEvent @event, Guid ruleId)
        {
            using var scope = _scopeFactor.CreateScope();
            await using var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var rule = await context.FlowRules
                .Include(c => c.Customer)
                .Include(c => c.Tenant)
                .FirstOrDefaultAsync(c => c.RuleId == ruleId);
            if (rule == null)
            {
                return;
            }

            @event.FlowRule = rule;
            @event.Tenant = rule.Tenant;
            @event.Customer = rule.Customer;
            context.BaseEvents.Add(@event);
            await context.SaveChangesAsync();
        }

        private async Task<CacheValue<(FlowRule rule, List<Flow> _allFlows)>> GetFlowRule(Guid ruleid)
        {
            var localCacheKey = $"flowrule:definition:l1:{ruleid:N}";
            if (_memoryCache.TryGetValue(localCacheKey, out CacheValue<(FlowRule rule, List<Flow> _allFlows)> localRule)
                && localRule.HasValue)
            {
                return localRule;
            }

            var cached = await _caching.GetAsync($"RunFlowRules_{ruleid}", async () =>
            {
                FlowRule rule;
                List<Flow> allFlows;
                using (var sp = _scopeFactor.CreateScope())
                {
                    using (var context = sp.ServiceProvider.GetRequiredService<ApplicationDbContext>())
                    {
                        rule = await context.FlowRules.AsNoTracking().FirstOrDefaultAsync(c => c.RuleId == ruleid);
                        allFlows = await context.Flows.AsNoTracking().Where(c => c.FlowRule == rule && c.FlowStatus > 0).ToListAsync();
                        _logger.LogDebug("读取规则链 {RuleName}({RuleId}), 子流程共计 {FlowCount}", rule?.Name, ruleid, allFlows.Count);
                    }
                }
                return (rule, _allFlows: allFlows);
            }, GetLocalCacheDuration());

            if (cached.HasValue)
            {
                _memoryCache.Set(localCacheKey, cached, GetLocalCacheDuration());
            }

            return cached;
        }

        private TimeSpan GetLocalCacheDuration()
            => TimeSpan.FromSeconds(Math.Max(1, _setting.RuleCachingExpiration));

        private TResult UseScopedService<TService, TResult>(Func<TService, TResult> action)
            where TService : notnull
        {
            using var scope = _scopeFactor.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<TService>();
            return action(service);
        }

        public async Task Process(List<Flow> _allFlows, List<FlowOperation> _allflowoperation, Guid operationid, object data, Guid deviceId, string serializedData = null)
        {
            serializedData ??= JsonObjectSerializer.Serialize(data);
            var peroperation = _allflowoperation.FirstOrDefault(c => c.OperationId == operationid);
            if (peroperation != null)
            {
                if (peroperation.Step > this._maximumiteration)
                {
                    peroperation.OperationDesc = "Maximum iteration depth has been reached";
                    peroperation.NodeStatus = 3;
                    return;
                }

                var flow = _allFlows.FirstOrDefault(c => c.bpmnid == peroperation.Flow.TargetId && c.FlowType != "label");
                switch (flow.FlowType)
                {
                    //线节点对象
                    case "bpmn:SequenceFlow":
                        {
                            var step = peroperation.Step + 1;
                            var operation = new FlowOperation()
                            {
                                OperationId = Guid.NewGuid(),
                                AddDate = DateTime.UtcNow,
                                FlowRule = peroperation.BaseEvent.FlowRule,
                                Flow = flow,
                                Data = serializedData,
                                NodeStatus = 1,
                                OperationDesc = "Condition（" + (string.IsNullOrEmpty(flow.Conditionexpression)
                                    ? "Empty Condition"
                                    : flow.Conditionexpression) + ")",
                                Step = step,
                                bpmnid = flow.bpmnid,
                                BaseEvent = peroperation.BaseEvent
                            };
                            _allflowoperation.Add(operation);
                            await Process(_allFlows, _allflowoperation, operation.OperationId, data, deviceId, serializedData);

                        }

                        break;
                    //中间执行器和脚本节点
                    case "bpmn:Task":
                        {
                            var step = peroperation.Step + 1;
                            var taskoperation = new FlowOperation()
                            {
                                OperationId = Guid.NewGuid(),
                                bpmnid = flow.bpmnid,
                                AddDate = DateTime.UtcNow,
                                FlowRule = peroperation.BaseEvent.FlowRule,
                                Flow = flow,
                                Data = serializedData,
                                NodeStatus = 1,
                                OperationDesc = "Run" + flow.NodeProcessScriptType + "Task:" + flow.Flowname,
                                Step = step,
                                BaseEvent = peroperation.BaseEvent
                            };
                            _allflowoperation.Add(taskoperation);

                            //脚本处理
                            if (!string.IsNullOrEmpty(flow.NodeProcessScriptType) && (!string.IsNullOrEmpty(flow.NodeProcessScript) || !string.IsNullOrEmpty(flow.NodeProcessClass)))
                            {
                                var scriptsrc = flow.NodeProcessScript;

                                dynamic obj = null;
                                switch (flow.NodeProcessScriptType)
                                {
                                    case "executor":

                                        if (!string.IsNullOrEmpty(flow.NodeProcessClass))
                                        {
                                            using var executorLease = _helper.CreateLeaseByTypeName(flow.NodeProcessClass);
                                            TaskAction executor = executorLease?.Executor;
                                            if (executor != null)
                                            {
                                                try
                                                {
                                                    //执行器入口 Input上一个节点向当前节点的传参，DeviceId设备编号，ExecutorConfig当前节点在设计时的配置内容
                                                    var result = await executor.ExecuteAsync(new TaskActionInput()
                                                    {
                                                        Input = taskoperation.Data,
                                                        DeviceId = deviceId,
                                                        ExecutorConfig = flow.NodeProcessParams,
                                                    }
                                                    );

                                                    _logger.LogDebug("执行器 {Executor} 已完成处理", flow.NodeProcessClass);
                                                    obj = result.DynamicOutput;
                                                    taskoperation.OperationDesc += "\r\n" + result.ExecutionInfo;
                                                    if (!result.ExecutionStatus)
                                                    {
                                                        taskoperation.NodeStatus = 2;
                                                        string info = JsonObjectSerializer.Serialize(result.DynamicOutput);
                                                        _logger.LogWarning("执行器执行失败: {ExecutionInfo}; Executor={Executor}; Output={Output}", result.ExecutionInfo, flow.NodeProcessClass, info);
                                                        return;
                                                    }
                                                }
                                                catch (Exception ex)
                                                {
                                                    _logger.LogWarning(ex, "执行器 {Executor} 未能正确处理", flow.NodeProcessClass);

                                                    taskoperation.OperationDesc += "\r\n" + ex.Message;
                                                    taskoperation.NodeStatus = 2;
                                                    return;
                                                }
                                            }
                                            else
                                            {
                                                _logger.Log(LogLevel.Warning, "脚本执行异常,未能实例化执行器");
                                                taskoperation.OperationDesc += "\r\n" + "脚本执行异常,未能实例化执行器";
                                                taskoperation.NodeStatus = 2;
                                                return;
                                            }
                                        }
                                        break;

                                    case "python":
                                        {
                                            try
                                            {
                                                string result = UseScopedService<PythonScriptEngine, string>(pse => pse.Do(scriptsrc, taskoperation.Data));
                                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                                            }
                                            catch (Exception ex)
                                            {
                                                _logger.Log(LogLevel.Warning, "python脚本执行异常");
                                                taskoperation.OperationDesc += ex.Message;
                                                taskoperation.NodeStatus = 2;
                                            }
                                        }
                                        break;

                                    case "sql":
                                        {
                                            try
                                            {
                                                string result = UseScopedService<SQLEngine, string>(pse => pse.Do(scriptsrc, taskoperation.Data));
                                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                                            }
                                            catch (Exception ex)
                                            {
                                                _logger.Log(LogLevel.Warning, "sql脚本执行异常");
                                                taskoperation.OperationDesc += ex.Message;
                                                taskoperation.NodeStatus = 2;
                                            }
                                        }

                                        break;

                                    case "lua":
                                        {

                                            try
                                            {
                                                string result = UseScopedService<LuaScriptEngine, string>(lua => lua.Do(scriptsrc, taskoperation.Data));
                                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                                            }
                                            catch (Exception ex)
                                            {
                                                _logger.Log(LogLevel.Warning, "lua脚本执行异常");
                                                taskoperation.OperationDesc += ex.Message;
                                                taskoperation.NodeStatus = 2;
                                            }

                                        }
                                        break;

                                    case "javascript":
                                        {

                                            try
                                            {
                                                string result = UseScopedService<JavaScriptEngine, string>(js => js.Do(scriptsrc, taskoperation.Data));
                                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                                            }
                                            catch (Exception ex)
                                            {
                                                _logger.Log(LogLevel.Warning, "javascript脚本执行异常");
                                                taskoperation.OperationDesc += ex.Message;
                                                taskoperation.NodeStatus = 2;
                                            }
                                        }
                                        break;

                                    case "csharp":
                                        {
                                            try
                                            {
                                                string result = UseScopedService<CSharpScriptEngine, string>(js => js.Do(scriptsrc, taskoperation.Data));
                                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                                            }
                                            catch (Exception ex)
                                            {
                                                _logger.Log(LogLevel.Warning, "csharp脚本执行异常");
                                                _logger.Log(LogLevel.Warning, ex.Message);
                                                taskoperation.OperationDesc += ex.Message;
                                                taskoperation.NodeStatus = 2;
                                            }
                                        }
                                        break;
                                }

                                if (obj != null)
                                {
                                    var serializedOutput = JsonObjectSerializer.Serialize(obj);
                                    var next = await ProcessCondition(_allFlows, taskoperation.Flow.FlowId, obj);
                                    var cstep = taskoperation.Step + 1;
                                    foreach (var item in next)
                                    {
                                        var flowOperation = new FlowOperation()
                                        {
                                            OperationId = Guid.NewGuid(),
                                            AddDate = DateTime.UtcNow,
                                            FlowRule = peroperation.BaseEvent.FlowRule,
                                            Flow = item,
                                            Data = serializedOutput,
                                            NodeStatus = 1,
                                            OperationDesc = "Execute（" +
                                                            (string.IsNullOrEmpty(item.Conditionexpression)
                                                                ? "Empty Condition"
                                                                : item.Conditionexpression) + ")",
                                            Step = cstep,
                                            bpmnid = item.bpmnid,
                                            BaseEvent = taskoperation.BaseEvent
                                        };
                                        _allflowoperation.Add(flowOperation);
                                        await Process(_allFlows, _allflowoperation, flowOperation.OperationId, obj, deviceId, serializedOutput);
                                    }
                                }
                                else
                                {

                                    taskoperation.NodeStatus = 2;
                                    _logger.Log(LogLevel.Warning, "脚本未能顺利执行");
                                }
                            }
                            else
                            {
                                var next = await ProcessCondition(_allFlows, taskoperation.Flow.FlowId, data);
                                var cstep = taskoperation.Step + 1;
                                foreach (var item in next)
                                {
                                    var flowOperation = new FlowOperation()
                                    {
                                        OperationId = Guid.NewGuid(),
                                        AddDate = DateTime.UtcNow,
                                        FlowRule = peroperation.BaseEvent.FlowRule,
                                        Flow = item,
                                        Data = serializedData,
                                        NodeStatus = 1,
                                        OperationDesc = "Execute（" + (string.IsNullOrEmpty(item.Conditionexpression)
                                            ? "Empty Condition"
                                            : item.Conditionexpression) + ")",
                                        Step = cstep,
                                        bpmnid = item.bpmnid,
                                        BaseEvent = taskoperation.BaseEvent
                                    };
                                    _allflowoperation.Add(flowOperation);
                                    await Process(_allFlows, _allflowoperation, flowOperation.OperationId, data, deviceId, serializedData);
                                }
                            }
                        }

                        break;
                    //结束节点
                    case "bpmn:EndEvent":


                        var end = new FlowOperation();
                        end.BuildFlowOperation(peroperation, flow);
                        end.OperationId = Guid.NewGuid();
                        end.bpmnid = flow.bpmnid;
                        end.AddDate = DateTime.UtcNow;
                        end.FlowRule = peroperation.BaseEvent.FlowRule;
                        end.Flow = flow;
                        end.Data = serializedData;
                        end.NodeStatus = 1;
                        end.OperationDesc = "处理完成";
                        end.Step = 1 + _allflowoperation.Max(c => c.Step);
                        end.BaseEvent = peroperation.BaseEvent;
                        _allflowoperation.Add(end);

                        _logger.LogDebug("规则链执行完成");

                        break;

                    //没有终结点的节点必须留个空标签
                    case "label":

                        break;

                    case "bpmn:Lane":

                        break;

                    case "bpmn:Participant":

                        break;

                    case "bpmn:DataStoreReference":

                        break;

                    case "bpmn:SubProcess":

                        break;

                    default:
                        {
                            break;
                        }
                }
            }
        }
        /// <summary>
        /// 调用规则引擎，判断当前节点后的连线中的规则是否通过校验，如果验证为真则返回满足条件的线对应的目标节点
        /// </summary>
        /// <param name="_allFlows">所有的节点</param>
        /// <param name="flowId">当前节点</param>
        /// <param name="data">进入到当前节点的数据传参</param>
        /// <returns></returns>
        public async Task<List<Flow>> ProcessCondition(List<Flow> _allFlows, Guid flowId, object data)
        {

            var tt = data.GetType();
            var emptyflow = new List<Flow>();
            //根据节点Id获取节点信息
            var flow = _allFlows.FirstOrDefault(c => c.FlowId == flowId);
            if (flow != null)
            {
                //根据节点Id获取到当前节点与以后节点的线对象列表（一个节点可以存在很多线对象关联到下一级节点）
                var flows = _allFlows.Where(c => c.SourceId == flow?.bpmnid).ToList();
                //没有逻辑的线节点对象
                emptyflow = flows.Where(c => c.Conditionexpression == string.Empty || c.Conditionexpression == null).ToList() ?? new List<Flow>();
                var tasks = new BaseRuleTask()
                {
                    Name = flow.Flowname,
                    Eventid = flow.bpmnid,
                    id = flow.bpmnid,
                    outgoing = new EditableList<BaseRuleFlow>()
                };
                foreach (var item in flows.Except(emptyflow))//排除掉没有逻辑的线节点
                {
                    var rule = new BaseRuleFlow();
                    rule.id = item.bpmnid;
                    rule.Name = item.bpmnid;
                    rule.Eventid = item.bpmnid;
                    rule.Expression = item.Conditionexpression;
                    tasks.outgoing.Add(rule);
                }
                if (tasks.outgoing.Count > 0)
                {
                    SimpleFlowExcutor flowExcutor = new SimpleFlowExcutor();
                    var ruleParams = NormalizeRuleInput(data);
                    if (data == null || ruleParams != null)
                    {
                        await ExecuteConditions(flowExcutor, tasks, ruleParams, flows, emptyflow);
                    }
                    else
                    {
                        _logger.LogWarning($"执行 {flowId}的规则链时遇到未预期的数据类型:{data.GetType()}");
                    }
                }
            }
            else
            {
                _logger.LogWarning($"ProcessCondition flowId={flowId}");
            }
            return emptyflow;
        }

        private static async Task ExecuteConditions(SimpleFlowExcutor flowExcutor, BaseRuleTask tasks, object ruleParams, List<Flow> flows, List<Flow> matchedFlows)
        {
            var result = await flowExcutor.Excute(new FlowExcuteEntity()
            {
                Params = ruleParams,
                Task = tasks,
            });

            foreach (var item in result.Where(c => c.IsSuccess))
            {
                var nextflow = flows.FirstOrDefault(a => a.bpmnid == item.Rule.SuccessEvent);
                matchedFlows.Add(nextflow);
            }
        }

        private static object NormalizeRuleInput(object data)
        {
            return data switch
            {
                null => null,
                JsonNode node => node.ToClrObject(),
                JsonElement element => element.ToClrObject(),
                IDictionary<string, object> dictionary when data is not ExpandoObject => ToExpandoObject(dictionary),
                _ => data
            };
        }

        private static ExpandoObject ToExpandoObject(IDictionary<string, object> dictionary)
        {
            var expando = new ExpandoObject();
            var target = (IDictionary<string, object>)expando;
            foreach (var item in dictionary)
            {
                target[item.Key] = item.Value;
            }

            return expando;
        }

        public async Task<ScriptTestResult> TestScript(Guid ruleid, Guid flowId, string data)
        {
            var cacheRule = await GetFlowRule(ruleid);
            if (cacheRule.HasValue)
            {
                var flow = cacheRule.Value._allFlows.FirstOrDefault(c => c.FlowId == flowId);

                if (!string.IsNullOrEmpty(flow?.NodeProcessScriptType) &&
                    (!string.IsNullOrEmpty(flow.NodeProcessScript) || !string.IsNullOrEmpty(flow.NodeProcessClass)))
                {
                    var scriptsrc = flow.NodeProcessScript;

                    dynamic obj = null;

                    switch (flow.NodeProcessScriptType)
                    {
                        case "executor":

                            if (!string.IsNullOrEmpty(flow.NodeProcessClass))
                            {
                                using var executorLease = _helper.CreateLeaseByTypeName(flow.NodeProcessClass);
                                TaskAction executor = executorLease?.Executor;
                                if (executor != null)
                                {
                                    try
                                    {
                                        var result = await executor.ExecuteAsync(new TaskActionInput()
                                        {
                                            Input = data,
                                            ExecutorConfig = flow.NodeProcessParams,
                                            DeviceId = Guid.Empty
                                        });
                                        obj = result.DynamicOutput;
                                    }
                                    catch (Exception ex)
                                    {
                                        _logger.LogWarning($"执行{flow.NodeProcessClass}失败， {ex.Message}");
                                    }
                                }
                                else
                                {
                                    _logger.LogWarning($"{flow.NodeProcessClass},未找到类型 ");
                                }
                            }
                            break;

                        case "python":
                            {
                                string result = UseScopedService<PythonScriptEngine, string>(pse => pse.Do(scriptsrc, data));
                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                            }
                            break;

                        case "sql":
                            {
                                string result = UseScopedService<SQLEngine, string>(pse => pse.Do(scriptsrc, data));
                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                            }

                            break;

                        case "lua":
                            {
                                string result = UseScopedService<LuaScriptEngine, string>(lua => lua.Do(scriptsrc, data));
                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                            }
                            break;

                        case "javascript":
                            {
                                string result = UseScopedService<JavaScriptEngine, string>(js => js.Do(scriptsrc, data));
                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                            }
                            break;

                        case "csharp":
                            {
                                string result = UseScopedService<CSharpScriptEngine, string>(js => js.Do(scriptsrc, data));
                                obj = JsonObjectSerializer.DeserializeUntyped(result);
                            }
                            break;
                    }

                    if (obj != null)
                    {
                        return new ScriptTestResult() { Data = obj, IsExecuted = true };
                    }
                }
            }

            return new ScriptTestResult() { Data = null, IsExecuted = false }; ;
        }

        public async Task<ConditionTestResult> TestCondition(Guid ruleid, Guid flowId, dynamic data)
        {
            var cacheRule = await GetFlowRule(ruleid);
            if (cacheRule.HasValue)
            {
                var _allFlows = cacheRule.Value._allFlows;
                var flow = _allFlows.FirstOrDefault(c => c.FlowId == flowId);
                var flows = _allFlows.Where(c => c.SourceId == flow.bpmnid).ToList();
                var emptyflow = flows.Where(c => c.Conditionexpression == string.Empty).ToList() ?? new List<Flow>();
                var tasks = new BaseRuleTask()
                {
                    Name = flow.Flowname,
                    Eventid = flow.bpmnid,
                    id = flow.bpmnid,
                    outgoing = new EditableList<BaseRuleFlow>()
                };
                foreach (var item in flows.Except(emptyflow))
                {
                    var rule = new BaseRuleFlow();
                    rule.id = item.bpmnid;
                    rule.Name = item.bpmnid;
                    rule.Eventid = item.bpmnid;
                    rule.Expression = item.Conditionexpression;
                    tasks.outgoing.Add(rule);
                }
                if (tasks.outgoing.Count > 0)
                {
                    SimpleFlowExcutor flowExcutor = new SimpleFlowExcutor();
                    var result = await flowExcutor.Excute(new FlowExcuteEntity()
                    {
                        Params = data,
                        Task = tasks,
                    });
                    var next = result.Where(c => c.IsSuccess).ToList();
                    foreach (var item in next)
                    {
                        var nextflow = flows.FirstOrDefault(a => a.bpmnid == item.Rule.SuccessEvent);
                        emptyflow.Add(nextflow);
                    }
                }
                return new ConditionTestResult { Failed = flows.Except(emptyflow).ToList(), Passed = emptyflow };
            }
            else
            {
                return null;
            }
        }
    }
}
