export interface RotaryTableRuntimeSnapshot {
	tableId: string;
	currentCartId?: string;
	currentAngle: number;
	targetAngle: number;
	state: 'idle' | 'positioning' | 'rotating' | 'ready' | 'locked' | 'fault';
	currentPickSlotId?: string;
}

const normalizeAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));

/** 把业务 Slot 旋转到固定抓取角，未到位时 Robot 不得启动。 */
export class RotaryTableController {
	private snapshot: RotaryTableRuntimeSnapshot = {
		tableId: 'RotaryTable-01',
		currentAngle: 0,
		targetAngle: 0,
		state: 'ready',
	};

	setCart(cartId?: string) {
		if (this.snapshot.currentCartId === cartId) return;
		this.snapshot.currentCartId = cartId;
		this.snapshot.currentAngle = 0;
		this.snapshot.targetAngle = 0;
		this.snapshot.state = cartId ? 'ready' : 'idle';
		delete this.snapshot.currentPickSlotId;
	}

	requestSlot(slotId: string, slotIndex: number, slotCount: number) {
		if (this.snapshot.currentPickSlotId === slotId && ['rotating', 'ready', 'locked'].includes(this.snapshot.state)) return;
		this.snapshot.currentPickSlotId = slotId;
		this.snapshot.targetAngle = normalizeAngle(-(slotIndex % Math.min(12, slotCount)) / Math.min(12, slotCount) * Math.PI * 2);
		this.snapshot.state = Math.abs(normalizeAngle(this.snapshot.targetAngle - this.snapshot.currentAngle)) < 0.01 ? 'ready' : 'rotating';
	}

	updateFixed(deltaSeconds: number) {
		if (this.snapshot.state !== 'rotating') return;
		const error = normalizeAngle(this.snapshot.targetAngle - this.snapshot.currentAngle);
		const step = Math.min(Math.abs(error), deltaSeconds * 1.35) * Math.sign(error);
		this.snapshot.currentAngle = normalizeAngle(this.snapshot.currentAngle + step);
		if (Math.abs(error) <= 0.012) {
			this.snapshot.currentAngle = this.snapshot.targetAngle;
			this.snapshot.state = 'ready';
		}
	}

	lock() {
		if (this.snapshot.state !== 'ready') return false;
		this.snapshot.state = 'locked';
		return true;
	}

	release() {
		if (this.snapshot.state === 'locked') this.snapshot.state = 'ready';
	}

	isReady(slotId: string) {
		return this.snapshot.currentPickSlotId === slotId && ['ready', 'locked'].includes(this.snapshot.state);
	}

	getSnapshot() {
		return structuredClone(this.snapshot);
	}

	reset() {
		const cartId = this.snapshot.currentCartId;
		this.snapshot = { tableId: 'RotaryTable-01', currentCartId: cartId, currentAngle: 0, targetAngle: 0, state: cartId ? 'ready' : 'idle' };
	}
}
