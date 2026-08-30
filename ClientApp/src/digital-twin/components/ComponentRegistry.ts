import type { TwinComponentBuildContext, TwinComponentBuildResult, TwinComponentDefinition, TwinComponentGenerator, TwinComponentType } from './types';
import { RollerConveyorComponent } from './RollerConveyorComponent';
import { TurnConveyor90Component } from './TurnConveyor90Component';
import { DiverterConveyorComponent } from './DiverterConveyorComponent';
import { MergerConveyorComponent } from './MergerConveyorComponent';
import { LiftComponent } from './LiftComponent';
import { TurntableComponent } from './TurntableComponent';
import { ExternalInspectionComponent } from './ExternalInspectionComponent';
import { BaggingMachineComponent } from './BaggingMachineComponent';

export class ComponentRegistry {
	private readonly generators = new Map<string, TwinComponentGenerator>();
	private readonly generatorsByType = new Map<TwinComponentType, TwinComponentGenerator[]>();

	private key(generator: string, generatorVersion: number) {
		return `${generator}@${generatorVersion}`;
	}

	register(generator: TwinComponentGenerator) {
		const key = this.key(generator.generator, generator.generatorVersion);
		if (this.generators.has(key)) throw new Error(`数字孪生组件生成器重复注册: ${key}`);
		this.generators.set(key, generator);
		this.generatorsByType.set(generator.componentType, [...(this.generatorsByType.get(generator.componentType) || []), generator]);
		return this;
	}

	has(generator: string, generatorVersion?: number) {
		if (generatorVersion === undefined) return this.generatorsByType.has(generator as TwinComponentType);
		return this.generators.has(this.key(generator, generatorVersion));
	}

	get(generator: string, generatorVersion: number) {
		return this.generators.get(this.key(generator, generatorVersion));
	}

	create(definition: TwinComponentDefinition): TwinComponentBuildResult {
		if (!definition.generator || !Number.isInteger(definition.generatorVersion) || definition.generatorVersion <= 0) {
			throw new Error(`组件 ${definition.objectId} 缺少有效的 generator + generatorVersion`);
		}
		const generatorKey = this.key(definition.generator, definition.generatorVersion);
		const generator = this.generators.get(generatorKey);
		if (!generator) throw new Error(`未注册数字孪生组件生成器: ${generatorKey}`);
		if (generator.componentType !== definition.componentType) {
			throw new Error(`组件类型与 Generator 不匹配: ${definition.componentType} != ${generator.componentType} (${generatorKey})`);
		}
		const context: TwinComponentBuildContext = { definition };
		return generator.create(context);
	}

	listTypes() {
		return [...this.generatorsByType.keys()];
	}

	listGenerators() {
		return [...this.generators.entries()].map(([key, implementation]) => ({ key, implementation }));
	}
}

export const createDefaultComponentRegistry = () => new ComponentRegistry()
	.register(new RollerConveyorComponent())
	.register(new TurnConveyor90Component())
	.register(new DiverterConveyorComponent())
	.register(new MergerConveyorComponent())
	.register(new LiftComponent())
	.register(new TurntableComponent())
	.register(new ExternalInspectionComponent())
	.register(new BaggingMachineComponent());

export const defaultComponentRegistry = createDefaultComponentRegistry();
