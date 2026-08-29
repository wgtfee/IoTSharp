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
	private readonly generators = new Map<TwinComponentType, TwinComponentGenerator>();

	register(generator: TwinComponentGenerator) {
		this.generators.set(generator.componentType, generator);
		return this;
	}

	has(componentType: TwinComponentType) {
		return this.generators.has(componentType);
	}

	get(componentType: TwinComponentType) {
		return this.generators.get(componentType);
	}

	create(definition: TwinComponentDefinition): TwinComponentBuildResult {
		const generator = this.generators.get(definition.componentType);
		if (!generator) throw new Error(`未注册数字孪生组件生成器: ${definition.componentType}`);
		const context: TwinComponentBuildContext = { definition };
		return generator.create(context);
	}

	listTypes() {
		return [...this.generators.keys()];
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
