using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace IoTSharp.Data.Oracle.Migrations
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
                    Id = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    ResourceKey = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    Name = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    SourceType = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    RuntimeFormat = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: true),
                    OriginalFileName = table.Column<string>(type: "NVARCHAR2(512)", maxLength: 512, nullable: true),
                    StoragePath = table.Column<string>(type: "NVARCHAR2(1024)", maxLength: 1024, nullable: true),
                    FileSize = table.Column<long>(type: "NUMBER(19)", nullable: false),
                    ContentHash = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: true),
                    NodeIndex = table.Column<string>(type: "NCLOB", nullable: true),
                    ModelMetadata = table.Column<string>(type: "NCLOB", nullable: true),
                    ProcessingStatus = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    LicenseMetadata = table.Column<string>(type: "NCLOB", nullable: true),
                    ProductId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    PreviewResourcePath = table.Column<string>(type: "NVARCHAR2(1024)", maxLength: 1024, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    CreatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    TenantId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    CustomerId = table.Column<Guid>(type: "RAW(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinModelResources", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinModelResources_Custome~",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelResources_Product~",
                        column: x => x.ProductId,
                        principalTable: "Products",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinModelResources_Tenant_~",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "DigitalTwinScenes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    SceneKey = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    Name = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    Description = table.Column<string>(type: "NCLOB", maxLength: 2048, nullable: true),
                    RootAssetId = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    Status = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    DraftPayload = table.Column<string>(type: "NCLOB", nullable: true),
                    PublishedVersionId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    Revision = table.Column<long>(type: "NUMBER(19)", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    CreatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    TenantId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    CustomerId = table.Column<Guid>(type: "RAW(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DigitalTwinScenes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DigitalTwinScenes_Assets_R~",
                        column: x => x.RootAssetId,
                        principalTable: "Assets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinScenes_Customer~",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinScenes_Tenant_T~",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "DigitalTwinSceneVersions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    SceneId = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    Version = table.Column<int>(type: "NUMBER(10)", nullable: false),
                    SchemaVersion = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    Manifest = table.Column<string>(type: "NCLOB", nullable: true),
                    ManifestHash = table.Column<string>(type: "NVARCHAR2(128)", maxLength: 128, nullable: false),
                    ValidationReport = table.Column<string>(type: "NCLOB", nullable: true),
                    ChangeSummary = table.Column<string>(type: "NVARCHAR2(1024)", maxLength: 1024, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    CreatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    TenantId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    CustomerId = table.Column<Guid>(type: "RAW(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DigitalTwinSceneVersions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DigitalTwinSceneVersions_C~",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinSceneVersions_D~",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_DigitalTwinSceneVersions_T~",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinObjectBindings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    SceneId = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    SceneVersionId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    BindingKey = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    ObjectId = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    NodePath = table.Column<string>(type: "NVARCHAR2(1024)", maxLength: 1024, nullable: true),
                    ModelResourceId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    AssetId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    DeviceId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    SemanticId = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    SourceKind = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    SourceKey = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    TargetKind = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    TargetPath = table.Column<string>(type: "NVARCHAR2(512)", maxLength: 512, nullable: true),
                    TransformKind = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: true),
                    TransformConfig = table.Column<string>(type: "NCLOB", nullable: true),
                    Priority = table.Column<int>(type: "NUMBER(10)", nullable: false),
                    StaleAfterMs = table.Column<int>(type: "NUMBER(10)", nullable: false),
                    Enabled = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    CreatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    TenantId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    CustomerId = table.Column<Guid>(type: "RAW(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinObjectBindings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Assets_~",
                        column: x => x.AssetId,
                        principalTable: "Assets",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Custome~",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Device_~",
                        column: x => x.DeviceId,
                        principalTable: "Device",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Digital~",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Digita~1",
                        column: x => x.SceneVersionId,
                        principalTable: "DigitalTwinSceneVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_Tenant_~",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinObjectBindings_TwinMod~",
                        column: x => x.ModelResourceId,
                        principalTable: "TwinModelResources",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "TwinRoutes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    SceneId = table.Column<Guid>(type: "RAW(16)", nullable: false),
                    SceneVersionId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    RouteKey = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    Name = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: false),
                    RouteType = table.Column<string>(type: "NVARCHAR2(64)", maxLength: 64, nullable: false),
                    GraphPayload = table.Column<string>(type: "NCLOB", nullable: true),
                    Revision = table.Column<long>(type: "NUMBER(19)", nullable: false),
                    Enabled = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "TIMESTAMP(7)", nullable: false),
                    CreatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    UpdatedBy = table.Column<string>(type: "NVARCHAR2(256)", maxLength: 256, nullable: true),
                    Deleted = table.Column<bool>(type: "BOOLEAN", nullable: false),
                    TenantId = table.Column<Guid>(type: "RAW(16)", nullable: true),
                    CustomerId = table.Column<Guid>(type: "RAW(16)", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_TwinRoutes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_Customer_Custom~",
                        column: x => x.CustomerId,
                        principalTable: "Customer",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_DigitalTwinScen~",
                        column: x => x.SceneId,
                        principalTable: "DigitalTwinScenes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_DigitalTwinSce~1",
                        column: x => x.SceneVersionId,
                        principalTable: "DigitalTwinSceneVersions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_TwinRoutes_Tenant_TenantId",
                        column: x => x.TenantId,
                        principalTable: "Tenant",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_Customer~",
                table: "DigitalTwinScenes",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_Publishe~",
                table: "DigitalTwinScenes",
                column: "PublishedVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_RootAsse~",
                table: "DigitalTwinScenes",
                columns: new[] { "RootAssetId", "Status", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinScenes_TenantId~",
                table: "DigitalTwinScenes",
                columns: new[] { "TenantId", "CustomerId", "SceneKey", "Deleted" },
                unique: true,
                filter: "\"TenantId\" IS NOT NULL AND \"CustomerId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinSceneVersions_C~",
                table: "DigitalTwinSceneVersions",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinSceneVersions_S~",
                table: "DigitalTwinSceneVersions",
                columns: new[] { "SceneId", "Version" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_DigitalTwinSceneVersions_T~",
                table: "DigitalTwinSceneVersions",
                columns: new[] { "TenantId", "CustomerId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_Content~",
                table: "TwinModelResources",
                column: "ContentHash");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_Custome~",
                table: "TwinModelResources",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_Product~",
                table: "TwinModelResources",
                column: "ProductId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_Tenant~1",
                table: "TwinModelResources",
                columns: new[] { "TenantId", "CustomerId", "ResourceKey", "Deleted" },
                unique: true,
                filter: "\"TenantId\" IS NOT NULL AND \"CustomerId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinModelResources_TenantI~",
                table: "TwinModelResources",
                columns: new[] { "TenantId", "CustomerId", "ProcessingStatus", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_AssetId~",
                table: "TwinObjectBindings",
                columns: new[] { "AssetId", "SceneId", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_Custome~",
                table: "TwinObjectBindings",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_DeviceI~",
                table: "TwinObjectBindings",
                columns: new[] { "DeviceId", "SourceKind", "SourceKey", "Enabled", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_ModelRe~",
                table: "TwinObjectBindings",
                columns: new[] { "ModelResourceId", "SceneId", "Deleted" });

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_SceneId~",
                table: "TwinObjectBindings",
                columns: new[] { "SceneId", "SceneVersionId", "BindingKey", "Deleted" },
                unique: true,
                filter: "\"SceneVersionId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinObjectBindings_SceneVe~",
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
                name: "IX_TwinRoutes_SceneId_SceneVe~",
                table: "TwinRoutes",
                columns: new[] { "SceneId", "SceneVersionId", "RouteKey", "Deleted" },
                unique: true,
                filter: "\"SceneVersionId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_TwinRoutes_SceneVersionId",
                table: "TwinRoutes",
                column: "SceneVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_TwinRoutes_TenantId_Custom~",
                table: "TwinRoutes",
                columns: new[] { "TenantId", "CustomerId", "Enabled", "Deleted" });

            migrationBuilder.AddForeignKey(
                name: "FK_DigitalTwinScenes_DigitalT~",
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
                name: "FK_DigitalTwinScenes_DigitalT~",
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
