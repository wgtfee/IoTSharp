import type { TwinActuatorDefinition, TwinPoseDefinition, TwinSceneManifest } from '../contracts';
import { buildComponentFromTemplate } from './ComponentTemplateFactory';

export interface ComponentActuatorSyncResult {
	addedActuatorIds: string[];
	addedPoseIds: string[];
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
	const filterIds = objectIds ? new Set(objectIds) : undefined;
	const result: ComponentActuatorSyncResult = { addedActuatorIds: [], addedPoseIds: [] };

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
