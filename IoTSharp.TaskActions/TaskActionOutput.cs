using IoTSharp.Extensions;
using System;
using System.Dynamic;

namespace IoTSharp.TaskActions
{
    public class TaskActionOutput
    {
        private string _value;
        private dynamic _DynamicOutput;
        private bool _dynamicInitialized;
        private bool _valueInitialized;
        public Guid DeviceId { get; set; }
        public bool ExecutionStatus { get; set; }
        public string ExecutionInfo { get; set; }

        public dynamic DynamicOutput
        {
            get
            {
                if (!_dynamicInitialized && _valueInitialized)
                {
                    _DynamicOutput = JsonObjectSerializer.DeserializeExpando(_value);
                    _dynamicInitialized = true;
                }
                return _DynamicOutput;
            }
            set
            {
                _DynamicOutput = value;
                _dynamicInitialized = true;
                _value = null;
                _valueInitialized = false;
            }
        }

        public string Output
        {
            get
            {
                if (!_valueInitialized && _dynamicInitialized)
                {
                    _value = JsonObjectSerializer.Serialize(_DynamicOutput);
                    _valueInitialized = true;
                }
                return _value;
            }
            set
            {
                _value = value;
                _valueInitialized = true;
                _DynamicOutput = null;
                _dynamicInitialized = false;
            }
        }
    }
}
