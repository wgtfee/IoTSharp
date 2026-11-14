# PdM Synthetic Offline Lab (NON-PRODUCTION)

Standalone .NET 10 experiment. Its simulated labels, failure cycles and RUL are
**not physical maintenance records**. No IoTSharp service, DB, PLC, MES, alert,
worker, production model registry or order dispatcher references this tool.

Run from the repository root:

```powershell
dotnet run --project tools/pdm-synthetic-lab/PdmSyntheticLab.csproj -- --run-id pilot-a
```

All files are created, without overwrite, under
`tools/pdm-synthetic-lab/output/<run-id>/` (git ignored).
They include feature records and separate artificial future labels, a learned
logistic risk-scoring model, learned log-RUL regression, SHA256 artifact checksum,
metrics, and a manifest explicitly forbidding production activation.

The generator uses 30 artificial devices, different degradation mechanisms,
load and ambient effects, sensor noise, maintenance resets and a fixed seed.
Train: 18 devices, first 27 days. Validation: 6 disjoint devices, days 28–38.
Blind test: 6 further disjoint devices, days 40–51. The 24-hour purge window
prevents feature/target horizon overlap. Statistics and weights come only from
training data, risk threshold only from validation; the blind test is not used
to fit or select the model.

Scores are **uncalibrated synthetic scores**, not field failure probabilities.
RUL MAE is also synthetic. Site telemetry, actual fault/repair evidence,
reviewed labels, source-data provenance, safety costs, cross-line drift and
independent prospective evaluations remain necessary for real-world claims.
