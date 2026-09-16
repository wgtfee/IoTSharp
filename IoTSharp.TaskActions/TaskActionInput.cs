using IoTSharp.Extensions;
using System;

namespace IoTSharp.TaskActions
{
    public class TaskActionInput
    {
        private dynamic _DynamicOutput;
        private string _value;
        private bool _dynamicInitialized;
        private bool _valueInitialized;
        public Guid DeviceId { get; set; }
        public String ExecutorConfig { get; set; }

        public dynamic DynamicInput
        {
            get
            {
                if (!_dynamicInitialized && _valueInitialized)
                {
                    _DynamicOutput = JsonObjectSerializer.DeserializeUntyped(_value);
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

        public string Input
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
