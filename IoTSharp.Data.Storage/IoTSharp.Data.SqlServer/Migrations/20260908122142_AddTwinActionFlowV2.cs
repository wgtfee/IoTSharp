using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.SqlServer.Migrations
{
    /// <inheritdoc />
    public partial class AddTwinActionFlowV2 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TwinActionFlows",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SceneId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SceneVersionId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    FlowKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    ContractVersion = table.Column<string>(type: "nvarchar(32)", maxLength: 32, nullable: false),
                    ActorScope = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    GraphPayload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    GraphHash = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    CompiledPayload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CompiledPlanHash = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    Enabled = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinActionFlows", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinActionFlows_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlows_DigitalTwinSceneVersions_SceneVersionId",
                        column: x => x.SceneVersionId,
                        principalTable: "DigitalTwinSceneVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlows_DigitalTwinScenes_SceneId",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlows_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinMaterialRuntimes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SceneId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    MaterialInstanceId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    TransportUnitId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    MaterialType = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    OwnerType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    OwnerId = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    PoseSource = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    LastEventSequence = table.Column<long>(type: "bigint", nullable: false),
                    Metadata = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinMaterialRuntimes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinMaterialRuntimes_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinMaterialRuntimes_DigitalTwinScenes_SceneId",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinMaterialRuntimes_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinActionFlowRuns",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SceneId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    SceneVersionId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ActionFlowId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    IdempotencyKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    InputPayload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    RuntimePayload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    CurrentSequence = table.Column<long>(type: "bigint", nullable: false),
                    ConcurrencyVersion = table.Column<long>(type: "bigint", nullable: false),
                    GraphHash = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    CompiledPlanHash = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    FaultCode = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    FaultMessage = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    StartedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    EndedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinActionFlowRuns", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRuns_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRuns_DigitalTwinSceneVersions_SceneVersionId",
                        column: x => x.SceneVersionId,
                        principalTable: "DigitalTwinSceneVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRuns_DigitalTwinScenes_SceneId",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRuns_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRuns_TwinActionFlows_ActionFlowId",
                        column: x => x.ActionFlowId,
                        principalTable: "TwinActionFlows",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinActionFlowEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    Sequence = table.Column<long>(type: "bigint", nullable: false),
                    EventType = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    NodeId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    StepInstanceId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    CorrelationId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Source = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    OccurredAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinActionFlowEvents", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowEvents_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowEvents_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowEvents_TwinActionFlowRuns_RunId",
                        column: x => x.RunId,
                        principalTable: "TwinActionFlowRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinActionFlowRunSteps",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    StepInstanceId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    NodeId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Attempt = table.Column<int>(type: "int", nullable: false),
                    Status = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    InputPayload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    OutputPayload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    ErrorCode = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: true),
                    ErrorMessage = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    DeadlineAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    StartedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    EndedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    LastSequence = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinActionFlowRunSteps", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRunSteps_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRunSteps_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinActionFlowRunSteps_TwinActionFlowRuns_RunId",
                        column: x => x.RunId,
                        principalTable: "TwinActionFlowRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinDeviceCommands",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    RunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    StepId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CommandId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    CorrelationId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    BindingKey = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    Payload = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    PayloadHash = table.Column<string>(type: "nvarchar(128)", maxLength: 128, nullable: false),
                    Status = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    DeviceCycleId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    LastError = table.Column<string>(type: "nvarchar(4000)", maxLength: 4000, nullable: true),
                    SentAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    AcknowledgedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    BusyAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CompletedAt = table.Column<DateTime>(type: "datetime2", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinDeviceCommands", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinDeviceCommands_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinDeviceCommands_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinDeviceCommands_TwinActionFlowRunSteps_StepId",
                        column: x => x.StepId,
                        principalTable: "TwinActionFlowRunSteps",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinDeviceCommands_TwinActionFlowRuns_RunId",
                        column: x => x.RunId,
                        principalTable: "TwinActionFlowRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinResourceReservations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    ReservationId = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: false),
                    ResourceType = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    ResourceId = table.Column<string>(type: "nvarchar(512)", maxLength: 512, nullable: false),
                    OwnerRunId = table.Column<Guid>(type: "uniqueidentifier", nullable: false),
                    OwnerStepId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    Status = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    LeaseUntil = table.Column<DateTime>(type: "datetime2", nullable: false),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime2", nullable: false),
                    CreatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "nvarchar(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "bit", nullable: false),
                    TenantId = table.Column<Guid>(type: "uniqueidentifier", nullable: true),
                    CustomerId = table.Column<Guid>(type: "uniqueidentifier", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinResourceReservations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinResourceReservations_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinResourceReservations_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinResourceReservations_TwinActionFlowRunSteps_OwnerStepId",
                        column: x => x.OwnerStepId,
                        principalTable: "TwinActionFlowRunSteps",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinResourceReservations_TwinActionFlowRuns_OwnerRunId",
                        column: x => x.OwnerRunId,
                        principalTable: "TwinActionFlowRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowEvents_CustomerId",
                table: "TwinActionFlowEvents",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowEvents_RunId_Sequence",
                table: "TwinActionFlowEvents",
                columns: new[] { "RunId", "Sequence" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowEvents_TenantId_CustomerId_OccurredAt",
                table: "TwinActionFlowEvents",
                columns: new[] { "TenantId", "CustomerId", "OccurredAt" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRuns_ActionFlowId",
                table: "TwinActionFlowRuns",
                column: "ActionFlowId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRuns_CustomerId",
                table: "TwinActionFlowRuns",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRuns_SceneId_Status_UpdatedAt_Deleted",
                table: "TwinActionFlowRuns",
                columns: new[] { "SceneId", "Status", "UpdatedAt", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRuns_SceneVersionId",
                table: "TwinActionFlowRuns",
                column: "SceneVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRuns_TenantId_CustomerId_IdempotencyKey_Deleted",
                table: "TwinActionFlowRuns",
                columns: new[] { "TenantId", "CustomerId", "IdempotencyKey", "Deleted" },
                unique: true,
                filter: "[TenantId] IS NOT NULL AND [CustomerId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRunSteps_CustomerId",
                table: "TwinActionFlowRunSteps",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRunSteps_RunId_Status_UpdatedAt_Deleted",
                table: "TwinActionFlowRunSteps",
                columns: new[] { "RunId", "Status", "UpdatedAt", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRunSteps_RunId_StepInstanceId_Deleted",
                table: "TwinActionFlowRunSteps",
                columns: new[] { "RunId", "StepInstanceId", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlowRunSteps_TenantId",
                table: "TwinActionFlowRunSteps",
                column: "TenantId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlows_CustomerId",
                table: "TwinActionFlows",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlows_SceneId_SceneVersionId_FlowKey_Deleted",
                table: "TwinActionFlows",
                columns: new[] { "SceneId", "SceneVersionId", "FlowKey", "Deleted" },
                unique: true,
                filter: "[SceneVersionId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlows_SceneVersionId",
                table: "TwinActionFlows",
                column: "SceneVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinActionFlows_TenantId_CustomerId_Enabled_Deleted",
                table: "TwinActionFlows",
                columns: new[] { "TenantId", "CustomerId", "Enabled", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinDeviceCommands_CustomerId",
                table: "TwinDeviceCommands",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinDeviceCommands_RunId_Status_CreatedAt_Deleted",
                table: "TwinDeviceCommands",
                columns: new[] { "RunId", "Status", "CreatedAt", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinDeviceCommands_StepId",
                table: "TwinDeviceCommands",
                column: "StepId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinDeviceCommands_TenantId_CustomerId_CommandId_Deleted",
                table: "TwinDeviceCommands",
                columns: new[] { "TenantId", "CustomerId", "CommandId", "Deleted" },
                unique: true,
                filter: "[TenantId] IS NOT NULL AND [CustomerId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinMaterialRuntimes_CustomerId",
                table: "TwinMaterialRuntimes",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinMaterialRuntimes_SceneId_MaterialInstanceId_Deleted",
                table: "TwinMaterialRuntimes",
                columns: new[] { "SceneId", "MaterialInstanceId", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinMaterialRuntimes_TenantId_CustomerId_TransportUnitId_Deleted",
                table: "TwinMaterialRuntimes",
                columns: new[] { "TenantId", "CustomerId", "TransportUnitId", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinResourceReservations_CustomerId",
                table: "TwinResourceReservations",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinResourceReservations_OwnerRunId",
                table: "TwinResourceReservations",
                column: "OwnerRunId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinResourceReservations_OwnerStepId",
                table: "TwinResourceReservations",
                column: "OwnerStepId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinResourceReservations_TenantId_CustomerId_ReservationId_Deleted",
                table: "TwinResourceReservations",
                columns: new[] { "TenantId", "CustomerId", "ReservationId", "Deleted" },
                unique: true,
                filter: "[TenantId] IS NOT NULL AND [CustomerId] IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinResourceReservations_TenantId_CustomerId_ResourceType_ResourceId_Status_LeaseUntil_Deleted",
                table: "TwinResourceReservations",
                columns: new[] { "TenantId", "CustomerId", "ResourceType", "ResourceId", "Status", "LeaseUntil", "Deleted" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "TwinActionFlowEvents");

            migrationBuilder.DropTable(
                name: "TwinDeviceCommands");

            migrationBuilder.DropTable(
                name: "TwinMaterialRuntimes");

            migrationBuilder.DropTable(
                name: "TwinResourceReservations");

            migrationBuilder.DropTable(
                name: "TwinActionFlowRunSteps");

            migrationBuilder.DropTable(
                name: "TwinActionFlowRuns");

            migrationBuilder.DropTable(
                name: "TwinActionFlows");
        }
    }
}
