import type { TwinActuatorDefinition, TwinMaterialSlotDefinition, TwinPoseDefinition, TwinSceneManifest, TwinToolFrameDefinition } from '../contracts';
import { buildComponentFromTemplate } from './ComponentTemplateFactory';

export interface ComponentActuatorSyncResult {
	addedActuatorIds: string[];
	addedPoseIds: string[];
	addedMaterialSlotIds: string[];
	addedToolFrameIds: string[];
}

type GeneratedActuatorDefinition = {
	actuatorId?: unknown;
	name?: unknown;
	kind?: unknown;
	nodePath?: unknown;
	motionAxis?: unknown;
	unit?: unknown;
	minValue?: unknown;
	maxValue?: unknown;
	homeValue?: unknown;
	speed?: unknown;
};

const actuatorKinds = new Set<TwinActuatorDefinition['kind']>(['rotary-joint', 'linear-axis', 'gripper']);
const actuatorUnits = new Set<TwinActuatorDefinition['unit']>(['rad', 'degree', 'meter', 'millimeter', 'boolean']);
const motionAxes = new Set<NonNullable<TwinActuatorDefinition['motionAxis']>>(['x', 'y', 'z']);

const finiteNumber = (value: unknown) => {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : undefined;
};

const generatedUnit = (definition: GeneratedActuatorDefinition, kind: TwinActuatorDefinition['kind']): TwinActuatorDefinition['unit'] => {
	const unit = String(definition.unit || '').trim() as TwinActuatorDefinition['unit'];
	if (actuatorUnits.has(unit)) return unit;
	if (kind === 'gripper') return 'boolean';
	if (kind === 'linear-axis') return 'meter';
	return 'rad';
};

const findExistingActuator = (
	manifest: TwinSceneManifest,
	objectId: string,
	candidateId: string,
	localId: string,
	nodePath: string,
	kind: TwinActuatorDefinition['kind'],
) => (manifest.actuators || []).find((item) => item.actuatorId === candidateId)
	|| (manifest.actuators || []).find((item) => item.objectId === objectId && item.nodePath === nodePath && item.kind === kind)
	|| (manifest.actuators || []).find((item) => item.objectId === objectId
		&& item.kind === kind
		&& (item.actuatorId === localId || item.actuatorId.endsWith(`:${localId}`) || item.actuatorId.endsWith(`-${localId}`)));

/** Synchronize component-generated actuator metadata into persistent scene definitions. */
export const ensureComponentActuators = (
	manifest: TwinSceneManifest,
	objectIds?: Iterable<string>,
): ComponentActuatorSyncResult => {
	manifest.actuators ||= [];
	manifest.poses ||= [];
	manifest.materialSlots ||= [];
	manifest.toolFrames ||= [];
	const filterIds = objectIds ? new Set(objectIds) : undefined;
	const result: ComponentActuatorSyncResult = { addedActuatorIds: [], addedPoseIds: [], addedMaterialSlotIds: [], addedToolFrameIds: [] };

	for (const sceneObject of manifest.objects as Array<any>) {
		if (sceneObject?.kind !== 'component' || !sceneObject.component?.resourceKey) continue;
		const objectId = String(sceneObject.objectId || '').trim();
		if (!objectId || (filterIds && !filterIds.has(objectId))) continue;
		const objectHadPoses = manifest.poses.some((pose) => pose.objectId === objectId);
		let built: ReturnType<typeof buildComponentFromTemplate> | undefined;
		try {
			built = buildComponentFromTemplate(String(sceneObject.component.resourceKey), {
				objectId,
				name: String(sceneObject.name || objectId),
				properties: { ...(sceneObject.component.properties || {}) },
				transform: sceneObject.transform,
				sectionId: sceneObject.component.sectionId,
				routeEdgeId: sceneObject.component.routeEdgeId,
			});
			const generated = Array.isArray(built.root.userData?.actuatorDefinitions)
				? built.root.userData.actuatorDefinitions as GeneratedActuatorDefinition[]
				: [];
			const generatedSlots = Array.isArray(built.root.userData?.materialSlots) ? built.root.userData.materialSlots as Array<Record<string, unknown>> : [];
			const generatedFrames = Array.isArray(built.root.userData?.toolFrames) ? built.root.userData.toolFrames as Array<Record<string, unknown>> : [];

			for (const definition of generatedSlots) {
				const localId = String(definition.slotId || '').trim();
				if (!localId) continue;
				const candidateId = `${objectId}:${localId}`;
				const nodePath = String(definition.nodePath || '').trim() || undefined;
				const existing = manifest.materialSlots.find((item) => item.slotId === candidateId)
					|| manifest.materialSlots.find((item) => item.objectId === objectId && item.nodePath === nodePath && item.payloadType === definition.payloadType)
					|| manifest.materialSlots.find((item) => item.objectId === objectId && (item.slotId === localId || item.slotId.endsWith(`:${localId}`)));
				if (existing) continue;
				const slot: TwinMaterialSlotDefinition = {
					slotId: candidateId,
					name: String(definition.name || localId),
					objectId,
					role: (definition.role || 'buffer') as TwinMaterialSlotDefinition['role'],
					localPosition: (Array.isArray(definition.localPosition) ? definition.localPosition : [0, 0, 0]) as [number, number, number],
				};
				if (nodePath) slot.nodePath = nodePath;
				if (Array.isArray(definition.localRotation)) slot.localRotation = definition.localRotation as [number, number, number];
				if (definition.payloadType) slot.payloadType = String(definition.payloadType);
				const capacity = finiteNumber(definition.capacity);
				if (capacity !== undefined) slot.capacity = capacity;
				if (definition.metadata && typeof definition.metadata === 'object') slot.metadata = { ...(definition.metadata as Record<string, unknown>) };
				manifest.materialSlots.push(slot);
				result.addedMaterialSlotIds.push(slot.slotId);
			}

			for (const definition of generatedFrames) {
				const localId = String(definition.toolFrameId || '').trim();
				const nodePath = String(definition.nodePath || '').trim();
				if (!localId || !nodePath) continue;
				const candidateId = `${objectId}:${localId}`;
				const existing = manifest.toolFrames.find((item) => item.toolFrameId === candidateId)
					|| manifest.toolFrames.find((item) => item.objectId === objectId && item.nodePath === nodePath)
					|| manifest.toolFrames.find((item) => item.objectId === objectId && (item.toolFrameId === localId || item.toolFrameId.endsWith(`:${localId}`)));
				if (existing) continue;
				const frame: TwinToolFrameDefinition = { toolFrameId: candidateId, name: String(definition.name || localId), objectId, nodePath };
				if (Array.isArray(definition.localPosition)) frame.localPosition = definition.localPosition as [number, number, number];
				if (Array.isArray(definition.localRotation)) frame.localRotation = definition.localRotation as [number, number, number];
				if (Array.isArray(definition.payloadTypes)) frame.payloadTypes = definition.payloadTypes.map(String);
				manifest.toolFrames.push(frame);
				result.addedToolFrameIds.push(frame.toolFrameId);
			}
			if (!generated.length) continue;

			const homeTargets: TwinPoseDefinition['targets'] = [];
			for (const definition of generated) {
				const localId = String(definition.actuatorId || '').trim();
				const nodePath = String(definition.nodePath || '').trim();
				const kind = String(definition.kind || '').trim() as TwinActuatorDefinition['kind'];
				if (!localId || !nodePath || !actuatorKinds.has(kind)) continue;
				const candidateId = `${objectId}:${localId}`;
				let actuator = findExistingActuator(manifest, objectId, candidateId, localId, nodePath, kind);
				if (!actuator) {
					actuator = {
						actuatorId: candidateId,
						name: String(definition.name || localId),
						objectId,
						nodePath,
						kind,
						unit: generatedUnit(definition, kind),
					};
					const axis = String(definition.motionAxis || '').trim() as NonNullable<TwinActuatorDefinition['motionAxis']>;
					if (motionAxes.has(axis)) actuator.motionAxis = axis;
					for (const field of ['minValue', 'maxValue', 'homeValue', 'speed'] as const) {
						const value = finiteNumber(definition[field]);
						if (value !== undefined) actuator[field] = value;
					}
					manifest.actuators.push(actuator);
					result.addedActuatorIds.push(actuator.actuatorId);
				}

				if (kind === 'gripper') homeTargets.push({ actuatorId: actuator.actuatorId, value: false });
				else {
					const homeValue = finiteNumber(definition.homeValue);
					if (homeValue !== undefined) homeTargets.push({ actuatorId: actuator.actuatorId, value: homeValue });
				}
			}

			const alreadyHasHome = manifest.poses.some((pose) => pose.objectId === objectId && /home/i.test(`${pose.poseId} ${pose.name}`));
			if (!objectHadPoses && !alreadyHasHome && homeTargets.length) {
				const poseId = `${objectId}:home`;
				manifest.poses.push({ poseId, name: `${sceneObject.name || objectId} · Home`, objectId, targets: homeTargets });
				result.addedPoseIds.push(poseId);
			}
		} catch (error) {
			console.warn('组件执行机构元数据同步失败', sceneObject.component.resourceKey, error);
		} finally {
			built?.dispose();
		}
	}
	return result;
};
