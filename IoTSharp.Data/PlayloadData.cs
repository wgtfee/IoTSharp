using IoTSharp.Contracts;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace IoTSharp.Data
{
    public class PlayloadData
    {
        public DateTime ts { get; set; } = DateTime.UtcNow;
        /// <summary>
        /// Server UTC time captured when telemetry enters the IoTSharp ingest pipeline.
        /// It is used only for internal persistence-lag measurement and never changes business timestamps.
        /// </summary>
        public DateTime ServerIngestedAtUtc { get; set; }
        public Guid DeviceId { get; set; }
        public Dictionary<string, object> MsgBody { get; set; }
        public DataSide DataSide { get; set; }
        public DataCatalog DataCatalog { get; set; }
    }
}
