# PdM P2 first batch — shadow-only rules

This package contains three parallel isolated modules and one integration coordinator:
- PdmTrendDetector: P1 snapshot history trend; strict UTC, scope, quality and continuity checks.
- PdmAlertPolicyEngine: proposal-only alert conditions, cooldown and escalation.
- PdmMaintenanceAdvisor: human-review maintenance advice, never an issued work order.
- PdmP2ShadowOrchestrator: single-window-consistent, side-effect-free integration.

Build the IoTSharp backend first, then run:
    dotnet test tools/pdm-p2/IoTSharp.PdM.P2.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false

Result: P2 27/27 passed; P1 81/81 and P0 25/25 compatible.
No production DB, HTTP P2 endpoint, alarm notifications or PLC/MES commands are used.
See design-plans/predictive-maintenance/P2_并行开发_第一批验收报告.md.

