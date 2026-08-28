import type { SilkLineSimulationOptions, TwinRouteDefinition } from '/@/digital-twin/contracts';
import type { TwinRouteRoutingContext } from '/@/digital-twin/routes/RouteEngine';
import { GantryStackController } from '/@/digital-twin/runtime/GantryStackController';
import { PalletFlowController } from '/@/digital-twin/runtime/PalletFlowController';
import { ProceduralSilkCakeLine } from '/@/digital-twin/runtime/ProceduralSilkCakeLine';
import { ProcessStationManager } from '/@/digital-twin/runtime/ProcessStationManager';
import { RobotLoadingController } from '/@/digital-twin/runtime/RobotLoadingController';
import { RotaryTableController } from '/@/digital-twin/runtime/RotaryTableController';
import { SilkMaterialRuntime } from '/@/digital-twin/runtime/SilkMaterialRuntime';
import { StackAreaManager } from '/@/digital-twin/runtime/StackAreaManager';
import { TwinMaterialFlowRuntime } from '/@/digital-twin/runtime/TwinMaterialFlowRuntime';
import { TwinSectionGeometryResolver } from '/@/digital-twin/runtime/TwinSectionGeometryResolver';

export const defaultSilkLineSimulationOptions = (palletCount = 50): SilkLineSimulationOptions => ({
	palletCount,
	silkCakesPerCart: 36,
	cartChangeDelaySeconds: 4,
	robotCycleSeconds: 5,
	gantryCycleSeconds: 5,
	palletReleaseIntervalSeconds: 0.8,
	loopEmptyPallets: true,
	autoReplaceSilkCart: true,
	stackRows: 2,
	stackColumns: 3,
	stackLayers: 8,
	coverCycleSeconds: 3,
	labelCycleSeconds: 2,
	wrappingCycleSeconds: 8,
	warehouseInboundCycleSeconds: 5,
	emptyWoodPalletFeedSeconds: 1,
	autoFeedWoodPallet: true,
});

/** 丝饼线业务编排层：先状态、后可视化；渲染器没有业务写权限。 */
export class SilkCakeLineRuntime {
	readonly group: any;
	readonly geometry: TwinSectionGeometryResolver;
	readonly stations: ProcessStationManager;
	readonly materials: SilkMaterialRuntime;
	readonly pallets: PalletFlowController;
	readonly rotary: RotaryTableController;
	readonly robot: RobotLoadingController;
	readonly stack: StackAreaManager;
	readonly gantry: GantryStackController;
	readonly renderer: ProceduralSilkCakeLine;
	private running = false;

	constructor(private route: TwinRouteDefinition, private readonly flow: TwinMaterialFlowRuntime, private options: SilkLineSimulationOptions) {
		this.geometry = new TwinSectionGeometryResolver(route);
		this.stations = new ProcessStationManager([
			{ stationId: 'LoadingStation-01', sectionId: 'silk-edge-loading', type: 'robot-loading' },
			{ stationId: 'GantryStation-01', sectionId: 'silk-edge-gantry', type: 'gantry-stacking' },
		]);
		this.materials = new SilkMaterialRuntime(options);
		this.stack = new StackAreaManager(options);
		this.rotary = new RotaryTableController();
		this.pallets = new PalletFlowController(route, flow, this.geometry, this.stations, this.materials, options);
		this.robot = new RobotLoadingController(this.pallets, this.stations, this.materials, this.rotary, options);
		this.gantry = new GantryStackController(this.pallets, this.stations, this.materials, this.stack, options);
		this.renderer = new ProceduralSilkCakeLine(route, this.geometry, options.palletCount);
		this.group = this.renderer.group;
		this.renderCurrentState();
	}

	setRunning(running: boolean) {
		this.running = running;
		this.pallets.setRunning(running);
	}

	setSpeed(speed: number) {
		this.pallets.setSpeed(speed);
	}

	setRoutingContext(context: TwinRouteRoutingContext) {
		this.pallets.setRoutingContext(context);
	}

	setRoute(route: TwinRouteDefinition) {
		this.route = structuredClone(route);
		this.geometry.setRoute(route);
		this.pallets.setRoute(route);
		this.renderer.setRoute(route);
	}

	updateFixed(deltaSeconds: number) {
		if (!this.running) return;
		this.materials.updateFixed(deltaSeconds);
		this.rotary.updateFixed(deltaSeconds);
		this.robot.updateFixed(deltaSeconds);
		this.gantry.updateFixed(deltaSeconds);
		this.pallets.updateFixed(deltaSeconds);
		this.renderCurrentState();
	}

	reset() {
		this.running = false;
		this.robot.reset();
		this.gantry.reset();
		this.stack.reset(this.options);
		this.materials.reset();
		this.rotary.setCart(this.materials.getCart()?.cartId);
		this.rotary.reset();
		this.pallets.reset();
		this.renderCurrentState();
	}

	getSnapshot() {
		const palletFlow = this.pallets.getSnapshot();
		const sections = this.flow.sections.getSnapshots();
		return {
			palletFlow,
			sections,
			stations: this.stations.getAll(),
			cart: this.materials.getCart(),
			rotary: this.rotary.getSnapshot(),
			robot: this.robot.getSnapshot(),
			gantry: this.gantry.getSnapshot(),
			stack: this.stack.getSnapshot(),
			blockedSections: sections.filter((section) => section.state !== 'available').map((section) => section.sectionId),
		};
	}

	/** 给工作台/MCP 适配层提供业务只读快照，Three.js 节点本身不承载业务真相。 */
	getEntityDetail(entityType: string, entityId: string): Record<string, unknown> | undefined {
		switch (entityType) {
			case 'plastic-pallet':
				return this.pallets.getPallet(entityId) as unknown as Record<string, unknown> | undefined;
			case 'silk-cake':
				return this.materials.getCake(entityId) as unknown as Record<string, unknown> | undefined;
			case 'silk-cart': {
				const cart = this.materials.getCart();
				return cart?.cartId === entityId ? { ...cart, slots: this.materials.getSlots() } as unknown as Record<string, unknown> : undefined;
			}
			case 'rotary-table':
				return this.rotary.getSnapshot() as unknown as Record<string, unknown>;
			case 'loading-robot':
				return this.robot.getSnapshot() as unknown as Record<string, unknown>;
			case 'gantry-stacker':
				return this.gantry.getSnapshot() as unknown as Record<string, unknown>;
			case 'stack-area':
				return this.stack.getSnapshot() as unknown as Record<string, unknown>;
			default:
				return undefined;
		}
	}

	private renderCurrentState() {
		this.renderer.updateVisuals({
			palletFlow: this.pallets.getSnapshot(),
			cakes: this.materials.getCakes(),
			cart: this.materials.getCart(),
			slots: this.materials.getSlots(),
			rotary: this.rotary.getSnapshot(),
			robot: this.robot.getSnapshot(),
			gantry: this.gantry.getSnapshot(),
			stack: this.stack.getSnapshot(),
		});
	}
}
