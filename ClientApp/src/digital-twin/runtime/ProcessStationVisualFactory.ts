import * as THREE from 'three';
import type { TwinProcessType } from '../contracts';

export interface ProcessStationVisualOptions {
	stationId: string;
	name: string;
	processType: TwinProcessType;
	position: [number, number, number];
	size: [number, number, number];
	color: number;
}

const createMachineLabel = (text: string) => {
	if (typeof document === 'undefined') {
		const label = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff }));
		label.name = `${text}-label`;
		label.scale.set(3.6, 1.12, 1);
		return label;
	}
	const canvas = document.createElement('canvas');
	canvas.width = 512;
	canvas.height = 160;
	const context = canvas.getContext('2d');
	if (context) {
		context.fillStyle = 'rgba(2, 6, 23, 0.86)';
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.strokeStyle = '#e2e8f0';
		context.lineWidth = 8;
		context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
		context.fillStyle = '#ffffff';
		context.font = 'bold 72px sans-serif';
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		context.fillText(text, canvas.width / 2, canvas.height / 2);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
	label.scale.set(3.6, 1.12, 1);
	return label;
};

/** 创建可复用的半透明工艺罩、状态灯和中文 Canvas 标签。 */
export const createProcessStationVisual = (options: ProcessStationVisualOptions) => {
	const root = new THREE.Group();
	root.name = options.name;
	root.position.set(...options.position);
	root.userData.twinObjectType = 'process-station';
	root.userData.stationId = options.stationId;
	root.userData.processType = options.processType;

	const enclosure = new THREE.Mesh(
		new THREE.BoxGeometry(...options.size),
		new THREE.MeshStandardMaterial({ color: options.color, transparent: true, opacity: 0.2, roughness: 0.35, metalness: 0.18, side: THREE.DoubleSide }),
	);
	enclosure.position.y = options.size[1] / 2;
	root.add(enclosure);

	const frame = new THREE.LineSegments(
		new THREE.EdgesGeometry(enclosure.geometry),
		new THREE.LineBasicMaterial({ color: options.color, transparent: true, opacity: 0.95 }),
	);
	frame.position.copy(enclosure.position);
	root.add(frame);

	const label = createMachineLabel(options.name);
	label.position.set(0, options.size[1] + 0.45, 0);
	root.add(label);

	const lamp = new THREE.Mesh(
		new THREE.SphereGeometry(0.18, 18, 12),
		new THREE.MeshStandardMaterial({ color: 0x94a3b8, emissive: 0x334155, emissiveIntensity: 0.8 }),
	);
	lamp.name = `${options.stationId}-status-lamp`;
	lamp.position.set(options.size[0] / 2 - 0.3, options.size[1] + 0.2, options.size[2] / 2 - 0.25);
	root.add(lamp);
	return root;
};
