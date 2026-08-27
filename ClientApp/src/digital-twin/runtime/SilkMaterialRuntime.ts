import type { SilkCakeDefinition, SilkCartDefinition, SilkCartSlotDefinition, SilkLineSimulationOptions } from '/@/digital-twin/contracts';

const clone = <T>(value: T): T => structuredClone(value);

/** 丝饼、丝车 Slot 与载具关系的业务真相；不依赖 Three.js。 */
export class SilkMaterialRuntime {
	private readonly cakes = new Map<string, SilkCakeDefinition>();
	private readonly slots = new Map<string, SilkCartSlotDefinition>();
	private cart?: SilkCartDefinition;
	private cakeSequence = 0;
	private cartSequence = 0;
	private cartChangeElapsed = 0;

	constructor(private options: SilkLineSimulationOptions) {
		this.createReplacementCart();
	}

	setOptions(options: SilkLineSimulationOptions) {
		this.options = options;
	}

	getCart() {
		return this.cart ? clone(this.cart) : undefined;
	}

	getSlots() {
		return [...this.slots.values()].filter((slot) => slot.cartId === this.cart?.cartId).map(clone);
	}

	getCakes() {
		return [...this.cakes.values()].map(clone);
	}

	getCake(silkCakeId: string) {
		const cake = this.cakes.get(silkCakeId);
		return cake ? clone(cake) : undefined;
	}

	peekNextOccupiedSlot() {
		return this.getSlots().find((slot) => slot.state === 'occupied');
	}

	reserveSlot(slotId: string) {
		const slot = this.slots.get(slotId);
		if (!slot || slot.state !== 'occupied' || !slot.silkCakeId || slot.cartId !== this.cart?.cartId) return false;
		slot.state = 'reserved';
		if (this.cart) {
			this.cart.currentPickSlotId = slotId;
			this.cart.state = 'positioning';
		}
		return true;
	}

	markCartReady(slotId: string) {
		if (!this.cart || this.cart.currentPickSlotId !== slotId) return false;
		this.cart.state = 'ready';
		return true;
	}

	pickReservedCake(slotId: string, robotGripperId: string) {
		const slot = this.slots.get(slotId);
		if (!slot?.silkCakeId || slot.state !== 'reserved' || slot.cartId !== this.cart?.cartId) return undefined;
		const cake = this.cakes.get(slot.silkCakeId);
		if (!cake) return undefined;
		slot.silkCakeId = undefined;
		slot.state = 'empty';
		cake.state = 'robot-picking';
		cake.currentCarrierType = 'robot-gripper';
		cake.currentCarrierId = robotGripperId;
		if (this.cart) {
			this.cart.remainingCount = Math.max(0, this.cart.remainingCount - 1);
			this.cart.state = this.cart.remainingCount > 0 ? 'feeding' : 'empty';
			delete this.cart.currentPickSlotId;
		}
		return clone(cake);
	}

	placeCakeOnPallet(silkCakeId: string, palletId: string) {
		const cake = this.cakes.get(silkCakeId);
		if (!cake) return false;
		cake.state = 'on-pallet';
		cake.currentCarrierType = 'plastic-pallet';
		cake.currentCarrierId = palletId;
		delete cake.currentSectionId;
		return true;
	}

	markConveying(silkCakeId: string, sectionId: string) {
		const cake = this.cakes.get(silkCakeId);
		if (!cake) return;
		cake.state = 'conveying';
		cake.currentSectionId = sectionId;
	}

	beginGantryPick(silkCakeId: string, gantryGripperId: string) {
		const cake = this.cakes.get(silkCakeId);
		if (!cake || !['on-pallet', 'conveying'].includes(cake.state)) return false;
		cake.state = 'gantry-picking';
		cake.currentCarrierType = 'gantry-gripper';
		cake.currentCarrierId = gantryGripperId;
		delete cake.currentSectionId;
		return true;
	}

	placeCakeInStack(silkCakeId: string, stackId: string, position: { layer: number; row: number; column: number }) {
		const cake = this.cakes.get(silkCakeId);
		if (!cake) return false;
		cake.state = 'stacked';
		cake.currentCarrierType = 'stack-area';
		cake.currentCarrierId = stackId;
		cake.stackPosition = { ...position };
		return true;
	}

	updateFixed(deltaSeconds: number) {
		if (this.cart?.state !== 'empty' && this.cart?.state !== 'replace-required') return;
		this.cartChangeElapsed += deltaSeconds;
		if (!this.options.autoReplaceSilkCart) {
			if (this.cart) this.cart.state = 'replace-required';
			return;
		}
		if (this.cartChangeElapsed >= this.options.cartChangeDelaySeconds) this.createReplacementCart();
	}

	reset() {
		this.cakes.clear();
		this.slots.clear();
		this.cart = undefined;
		this.cakeSequence = 0;
		this.cartSequence = 0;
		this.cartChangeElapsed = 0;
		this.createReplacementCart();
	}

	private createReplacementCart() {
		this.cartSequence += 1;
		this.cartChangeElapsed = 0;
		const cartId = `SilkCart-${String(this.cartSequence).padStart(3, '0')}`;
		const slotIds: string[] = [];
		const count = Math.max(1, Math.floor(this.options.silkCakesPerCart));
		for (let index = 0; index < count; index += 1) {
			this.cakeSequence += 1;
			const silkCakeId = `SilkCake-${String(this.cakeSequence).padStart(5, '0')}`;
			const slotId = `${cartId}-Slot-${String(index + 1).padStart(2, '0')}`;
			const slotsPerRing = Math.min(12, count);
			const angle = (index % slotsPerRing) / slotsPerRing * Math.PI * 2;
			const ring = Math.floor(index / slotsPerRing);
			const localPosition: [number, number, number] = [Math.cos(angle) * 1.32, 0.86 + ring * 0.58, Math.sin(angle) * 1.32];
			this.cakes.set(silkCakeId, {
				silkCakeId,
				batchNo: `B${new Date().getFullYear()}-${String(this.cartSequence).padStart(3, '0')}`,
				materialCode: index % 2 === 0 ? 'SILK-A' : 'SILK-B',
				colorCode: 'IVORY',
				quality: 'normal',
				state: 'on-cart',
				currentCarrierType: 'silk-cart',
				currentCarrierId: cartId,
			});
			this.slots.set(slotId, { slotId, cartId, localPosition, silkCakeId, state: 'occupied' });
			slotIds.push(slotId);
		}
		this.cart = { cartId, stationId: 'RotaryTable-01', state: 'ready', slotIds, remainingCount: count };
	}
}
