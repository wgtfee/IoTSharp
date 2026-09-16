using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.TaskActions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

namespace IoTSharp.FlowRuleEngine
{
    public class TaskExecutorHelper
    {

        private readonly IServiceScopeFactory _scopeFactory;
        private readonly Lazy<ExecutorCatalog> _catalog;

        public TaskExecutorHelper(ILogger<TaskExecutorHelper> logger, IServiceScopeFactory scopeFactor, IOptions<AppSettings> options)
        {
            _scopeFactory = scopeFactor;
            _catalog = new Lazy<ExecutorCatalog>(BuildCatalog, true);
        }
        public Dictionary<string, Type> GetTaskExecutorList()
        {
            return new Dictionary<string, Type>(_catalog.Value.ByName, StringComparer.Ordinal);
        }
        public TaskAction CreateInstance(string name)
        {
            return _catalog.Value.ByName.TryGetValue(name, out var type)
                ? CreateDetachedInstance(type)
                : null;

        }
        public TaskAction CreateInstanceByTypeName(string typename)
        {
            return _catalog.Value.ByTypeName.TryGetValue(typename, out var type)
                ? CreateDetachedInstance(type)
                : null;
        }

        public TaskAction CreateInstance(Type t)
        {
            return CreateDetachedInstance(t);
        }

        public TaskExecutorLease CreateLeaseByTypeName(string typeName)
        {
            return _catalog.Value.ByTypeName.TryGetValue(typeName, out var type)
                ? CreateLease(type)
                : null;
        }

        public TaskExecutorLease CreateLease(string name)
        {
            return _catalog.Value.ByName.TryGetValue(name, out var type)
                ? CreateLease(type)
                : null;
        }

        private TaskExecutorLease CreateLease(Type type)
        {
            var scope = _scopeFactory.CreateScope();
            try
            {
                TaskAction executor;
                if (type.GetConstructors().FirstOrDefault()?.GetParameters().Any() == true)
                {
                    executor = scope.ServiceProvider.GetRequiredService(type) as TaskAction;
                }
                else
                {
                    executor = Activator.CreateInstance(type) as TaskAction;
                }

                if (executor == null)
                {
                    scope.Dispose();
                    return null;
                }

                executor.ServiceProvider = scope.ServiceProvider;
                return new TaskExecutorLease(scope, executor);
            }
            catch
            {
                scope.Dispose();
                throw;
            }
        }

        private static TaskAction CreateDetachedInstance(Type type)
        {
            if (type == null || type.GetConstructors().FirstOrDefault()?.GetParameters().Any() == true)
                return null;
            return Activator.CreateInstance(type) as TaskAction;
        }

        private static ExecutorCatalog BuildCatalog()
        {
            var byName = new Dictionary<string, Type>(StringComparer.Ordinal);
            AddTaskActions(Assembly.GetEntryAssembly(), byName);
            AddTaskActions(typeof(TaskAction).Assembly, byName);
            var byTypeName = new Dictionary<string, Type>(StringComparer.Ordinal);
            foreach (var type in byName.Values)
            {
                if (!string.IsNullOrEmpty(type.FullName))
                    byTypeName.TryAdd(type.FullName, type);
            }
            return new ExecutorCatalog(byName, byTypeName);
        }

        private static void AddTaskActions(Assembly assembly, Dictionary<string, Type> target)
        {
            if (assembly == null)
                return;
            foreach (var type in assembly.GetTypes())
            {
                if (type.IsAbstract || !typeof(TaskAction).IsAssignableFrom(type) || type == typeof(TaskAction))
                    continue;
                var key = type.GetCustomAttribute<DisplayNameAttribute>()?.DisplayName ?? type.FullName;
                if (!string.IsNullOrEmpty(key))
                {
                    target.TryAdd(key, type);
                }
            }
        }

        private sealed record ExecutorCatalog(
            Dictionary<string, Type> ByName,
            Dictionary<string, Type> ByTypeName);
    }

    public sealed class TaskExecutorLease : IDisposable
    {
        private readonly IServiceScope _scope;

        internal TaskExecutorLease(IServiceScope scope, TaskAction executor)
        {
            _scope = scope;
            Executor = executor;
        }

        public TaskAction Executor { get; }

        public void Dispose() => _scope.Dispose();
    }
}

