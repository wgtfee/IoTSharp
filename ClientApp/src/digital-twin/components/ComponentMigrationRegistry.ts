export interface TwinComponentMigration {
	generator: string;
	fromVersion: number;
	toVersion: number;
	migrate(properties: Record<string, unknown>): Record<string, unknown>;
}

const migrationKey = (generator: string, fromVersion: number, toVersion: number) => `${generator}@${fromVersion}->${toVersion}`;

/**
 * 组件属性升级必须由用户显式触发；Published Scene 加载不会调用本注册表。
 * 每次只允许连续升级一版，以保证升级链可审计、可测试。
 */
export class ComponentMigrationRegistry {
	private readonly migrations = new Map<string, TwinComponentMigration>();

	register(migration: TwinComponentMigration) {
		if (!migration.generator.trim() || migration.fromVersion <= 0 || migration.toVersion !== migration.fromVersion + 1) {
			throw new Error('组件迁移必须声明非空 generator，并且只能连续升级一个版本');
		}
		const key = migrationKey(migration.generator, migration.fromVersion, migration.toVersion);
		if (this.migrations.has(key)) throw new Error(`组件迁移重复注册: ${key}`);
		this.migrations.set(key, migration);
		return this;
	}

	has(generator: string, fromVersion: number, toVersion: number) {
		return this.migrations.has(migrationKey(generator, fromVersion, toVersion));
	}

	migrate(generator: string, fromVersion: number, toVersion: number, properties: Record<string, unknown>) {
		if (toVersion < fromVersion) throw new Error('组件不支持自动降级');
		let currentVersion = fromVersion;
		let current = structuredClone(properties);
		while (currentVersion < toVersion) {
			const nextVersion = currentVersion + 1;
			const migration = this.migrations.get(migrationKey(generator, currentVersion, nextVersion));
			if (!migration) throw new Error(`缺少组件迁移: ${generator}@${currentVersion}->${nextVersion}`);
			current = migration.migrate(structuredClone(current));
			currentVersion = nextVersion;
		}
		return current;
	}
}

export const defaultComponentMigrationRegistry = new ComponentMigrationRegistry();
