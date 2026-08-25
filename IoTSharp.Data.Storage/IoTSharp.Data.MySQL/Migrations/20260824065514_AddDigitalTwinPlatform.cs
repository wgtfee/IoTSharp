using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.MySQL.Migrations
{
    /// <inheritdoc />
    public partial class AddDigitalTwinPlatform : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "TwinModelResources",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    ResourceKey = table.Column<string>(type: "varchar(128)", maxLength: 128, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Name = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    SourceType = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    RuntimeFormat = table.Column<string>(type: "varchar(128)", maxLength: 128, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    OriginalFileName = table.Column<string>(type: "varchar(512)", maxLength: 512, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    StoragePath = table.Column<string>(type: "varchar(1024)", maxLength: 1024, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    FileSize = table.Column<long>(type: "bigint", nullable: false),
                    ContentHash = table.Column<string>(type: "varchar(128)", maxLength: 128, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    NodeIndex = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ModelMetadata = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ProcessingStatus = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    LicenseMetadata = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ProductId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    PreviewResourcePath = table.Column<string>(type: "varchar(1024)", maxLength: 1024, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    CreatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    CreatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    UpdatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Deleted = table.Column<bool>(type: "tinyint(1)", nullable: false),
                    TenantId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    CustomerId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinModelResources", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinModelResources_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelResources_Products_ProductId",
                        column: x => x.ProductId,
                        principalTable: "Products",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelResources_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateTable(
                name: "DigitalTwinScenes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    SceneKey = table.Column<string>(type: "varchar(128)", maxLength: 128, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Name = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Description = table.Column<string>(type: "varchar(2048)", maxLength: 2048, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    RootAssetId = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    Status = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    DraftPayload = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    PublishedVersionId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    CreatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    UpdatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Deleted = table.Column<bool>(type: "tinyint(1)", nullable: false),
                    TenantId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    CustomerId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DigitalTwinScenes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DigitalTwinScenes_Assets_RootAssetId",
                        column: x => x.RootAssetId,
                        principalTable: "Assets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinScenes_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinScenes_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateTable(
                name: "DigitalTwinSceneVersions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    SceneId = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    Version = table.Column<int>(type: "int", nullable: false),
                    SchemaVersion = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Manifest = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ManifestHash = table.Column<string>(type: "varchar(128)", maxLength: 128, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ValidationReport = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ChangeSummary = table.Column<string>(type: "varchar(1024)", maxLength: 1024, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    CreatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    CreatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    TenantId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    CustomerId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DigitalTwinSceneVersions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DigitalTwinSceneVersions_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinSceneVersions_DigitalTwinScenes_SceneId",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinSceneVersions_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateTable(
                name: "TwinObjectBindings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    SceneId = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    SceneVersionId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    BindingKey = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ObjectId = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    NodePath = table.Column<string>(type: "varchar(1024)", maxLength: 1024, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    ModelResourceId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    AssetId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    DeviceId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    SemanticId = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    SourceKind = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    SourceKey = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    TargetKind = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    TargetPath = table.Column<string>(type: "varchar(512)", maxLength: 512, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    TransformKind = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    TransformConfig = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Priority = table.Column<int>(type: "int", nullable: false),
                    StaleAfterMs = table.Column<int>(type: "int", nullable: false),
                    Enabled = table.Column<bool>(type: "tinyint(1)", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    CreatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    UpdatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Deleted = table.Column<bool>(type: "tinyint(1)", nullable: false),
                    TenantId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    CustomerId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinObjectBindings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Assets_AssetId",
                        column: x => x.AssetId,
                        principalTable: "Assets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Device_DeviceId",
                        column: x => x.DeviceId,
                        principalTable: "Device",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_DigitalTwinSceneVersions_SceneVersionId",
                        column: x => x.SceneVersionId,
                        principalTable: "DigitalTwinSceneVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_DigitalTwinScenes_SceneId",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_TwinModelResources_ModelResourceId",
                        column: x => x.ModelResourceId,
                        principalTable: "TwinModelResources",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateTable(
                name: "TwinRoutes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    SceneId = table.Column<Guid>(type: "char(36)", nullable: false, collation: "ascii_general_ci"),
                    SceneVersionId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    RouteKey = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Name = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    RouteType = table.Column<string>(type: "varchar(64)", maxLength: 64, nullable: false)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    GraphPayload = table.Column<string>(type: "longtext", nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Revision = table.Column<long>(type: "bigint", nullable: false),
                    Enabled = table.Column<bool>(type: "tinyint(1)", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "datetime(6)", nullable: false),
                    CreatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    UpdatedBy = table.Column<string>(type: "varchar(256)", maxLength: 256, nullable: true)
                        .Annotation("MySql:CharSet", "utf8mb4"),
                    Deleted = table.Column<bool>(type: "tinyint(1)", nullable: false),
                    TenantId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci"),
                    CustomerId = table.Column<Guid>(type: "char(36)", nullable: true, collation: "ascii_general_ci")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinRoutes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_Customer_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_DigitalTwinSceneVersions_SceneVersionId",
                        column: x => x.SceneVersionId,
                        principalTable: "DigitalTwinSceneVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_DigitalTwinScenes_SceneId",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                })
                .Annotation("MySql:CharSet", "utf8mb4");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_CustomerId",
                table: "DigitalTwinScenes",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_PublishedVersionId",
                table: "DigitalTwinScenes",
                column: "PublishedVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_RootAssetId_Status_Deleted",
                table: "DigitalTwinScenes",
                columns: new[] { "RootAssetId", "Status", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_TenantId_CustomerId_SceneKey_Deleted",
                table: "DigitalTwinScenes",
                columns: new[] { "TenantId", "CustomerId", "SceneKey", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinSceneVersions_CustomerId",
                table: "DigitalTwinSceneVersions",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinSceneVersions_SceneId_Version",
                table: "DigitalTwinSceneVersions",
                columns: new[] { "SceneId", "Version" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinSceneVersions_TenantId_CustomerId_CreatedAt",
                table: "DigitalTwinSceneVersions",
                columns: new[] { "TenantId", "CustomerId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_ContentHash",
                table: "TwinModelResources",
                column: "ContentHash");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_CustomerId",
                table: "TwinModelResources",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_ProductId",
                table: "TwinModelResources",
                column: "ProductId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_TenantId_CustomerId_ProcessingStatus_Dele~",
                table: "TwinModelResources",
                columns: new[] { "TenantId", "CustomerId", "ProcessingStatus", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_TenantId_CustomerId_ResourceKey_Deleted",
                table: "TwinModelResources",
                columns: new[] { "TenantId", "CustomerId", "ResourceKey", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_AssetId_SceneId_Deleted",
                table: "TwinObjectBindings",
                columns: new[] { "AssetId", "SceneId", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_CustomerId",
                table: "TwinObjectBindings",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_DeviceId_SourceKind_SourceKey_Enabled_Del~",
                table: "TwinObjectBindings",
                columns: new[] { "DeviceId", "SourceKind", "SourceKey", "Enabled", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_ModelResourceId_SceneId_Deleted",
                table: "TwinObjectBindings",
                columns: new[] { "ModelResourceId", "SceneId", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_SceneId_SceneVersionId_BindingKey_Deleted",
                table: "TwinObjectBindings",
                columns: new[] { "SceneId", "SceneVersionId", "BindingKey", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_SceneVersionId",
                table: "TwinObjectBindings",
                column: "SceneVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_TenantId",
                table: "TwinObjectBindings",
                column: "TenantId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinRoutes_CustomerId",
                table: "TwinRoutes",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinRoutes_SceneId_SceneVersionId_RouteKey_Deleted",
                table: "TwinRoutes",
                columns: new[] { "SceneId", "SceneVersionId", "RouteKey", "Deleted" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_TwinRoutes_SceneVersionId",
                table: "TwinRoutes",
                column: "SceneVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinRoutes_TenantId_CustomerId_Enabled_Deleted",
                table: "TwinRoutes",
                columns: new[] { "TenantId", "CustomerId", "Enabled", "Deleted" });

            migrationBuilder.AddForeignKey(
                name: "FK_DigitalTwinScenes_DigitalTwinSceneVersions_PublishedVersionId",
                table: "DigitalTwinScenes",
                column: "PublishedVersionId",
                principalTable: "DigitalTwinSceneVersions",
                principalColumn: "Id",
                onDelete: ReferentialAction.Restrict);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_DigitalTwinScenes_DigitalTwinSceneVersions_PublishedVersionId",
                table: "DigitalTwinScenes");

            migrationBuilder.DropTable(
                name: "TwinObjectBindings");

            migrationBuilder.DropTable(
                name: "TwinRoutes");

            migrationBuilder.DropTable(
                name: "TwinModelResources");

            migrationBuilder.DropTable(
                name: "DigitalTwinSceneVersions");

            migrationBuilder.DropTable(
                name: "DigitalTwinScenes");
        }
    }
}
