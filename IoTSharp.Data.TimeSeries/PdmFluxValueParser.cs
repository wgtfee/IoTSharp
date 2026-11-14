using System.Globalization;
using IoTSharp.Contracts;

namespace IoTSharp.Storage;

/// <summary>
/// Flux group(columns: []) requires a common _value column type across the
/// integer/float/bool fields. PdM normalizes values to strings in Flux, then
/// strictly restores finite numeric or boolean values without machine-local culture.
/// </summary>
public static class PdmFluxValueParser
{
    public static (object Value, DataType Type) Parse(object? raw)
    {
        if (raw is not string text || string.IsNullOrWhiteSpace(text))
            throw new InvalidOperationException("Bounded Flux query did not return normalized telemetry text.");
        if (bool.TryParse(text, out var boolean))
            return (boolean, DataType.Boolean);
        if (long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integer))
            return (integer, DataType.Long);
        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) &&
            double.IsFinite(number))
            return (number, DataType.Double);
        throw new InvalidOperationException("Bounded Flux telemetry was not a finite numeric or boolean value.");
    }

    public static DateTime RequireUtcInstant(DateTime timestamp)
    {
        if (timestamp.Kind == DateTimeKind.Local)
            throw new InvalidOperationException("Flux SDK returned local-time DateTime; provider UTC contract is unverified.");
        // Flux _time represents an absolute UTC instant; some SDKs lose Kind.
        return DateTime.SpecifyKind(timestamp, DateTimeKind.Utc);
    }
}

