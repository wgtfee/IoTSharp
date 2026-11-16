import type { TwinSceneManifest } from '../contracts';

/**
 * V2 源场景派生的余丝缓存工位专用物理输送闸口。
 *
 * Graph edge alone is NOT a conveyor. Every A/B bagging handoff must be
 * covered end-to-end by a real configured conveyor component, and the two
 * operator-corrected blue arrows must remain the actual driving direction.
 * The original V19 scene has no arc rack; it is not affected.
 */
export function inspectStudioV2PhysicalRoutes(manifest: TwinSceneManifest): string[] {
  const objects = manifest.objects as any[];
  if (!objects.some(o => o.objectId === 'studio-v2-surplus-silk-arc-rack')) return [];
  const route = manifest.routes.find(r => r.routeId === 'component-route-d045206d');
  if (!route) return ['Studio V2 物理输送：缺少小托盘主闭环'];
  const errors: string[] = [];
  const object = (id: string) => objects.find(o => o.objectId === id);
  const point = (id: string) => route.points.find(p => p.pointId === id);
  const edge = (id: string) => route.edges.find(e => e.edgeId === id && e.enabled !== false);
  const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.035;
  const directed = (id: string, from: string, to: string, component: string) => {
    const e = edge(id);
    if (!e || e.fromPointId !== from || e.toPointId !== to || e.componentObjectId !== component) {
      errors.push(`Studio V2 物理输送：路线 ${id} 方向或所属设备不匹配`);
    }
  };
  for (const spec of [
    {lane: 'a', center: 15, z: -12.9, entry: 20, exit: 6.8,
      upstream: 'ref-bag-a-right', station: 'ref-bag-a', downstream: 'ref-a-bag-left'},
    {lane: 'b', center: 14.5, z: -5.5, entry: 20, exit: 6.8,
      upstream: 'ref-bag-b-right', station: 'ref-bag-b', downstream: 'ref-b-bag-left'},
  ]) {
    const id = spec.lane, machineId = `reference-bagging-${id}`;
    const machine = object(machineId), machineLength = Number(machine?.component?.properties?.length);
    const machineX = Number(machine?.transform?.position?.[0]);
    const machineZ = Number(machine?.transform?.position?.[2]);
    const yaw = Number(machine?.transform?.rotation?.[1]);
    if (!machine || !near(machineX, spec.center) || !near(machineZ, spec.z)
      || !near(machineLength, 6.4) || !near(Math.abs(yaw), Math.PI)) {
      errors.push(`Studio V2 物理输送：套袋机 ${id.toUpperCase()} 入口/出口必须按图从右向左布置`);
      continue;
    }
    const physicalInputX = machineX + machineLength/2, physicalOutputX = machineX - machineLength/2;
    const inId = `studio-v2-bag-${id}-infeed-roller`;
    const outId = `studio-v2-bag-${id}-outfeed-roller`;
    for (const [componentId,x0,x1,which] of [
      [inId,physicalInputX,spec.entry,'入口'],
      [outId,spec.exit,physicalOutputX,'出口'],
    ] as const) {
      const roller = object(componentId);
      if (!roller || roller.component?.componentType !== 'roller-conveyor') {
        errors.push(`Studio V2 物理输送：套袋机 ${id.toUpperCase()} ${which}没有实体辊道，禁止小托盘悬空运行`);
        continue;
      }
      const p = roller.transform?.position;
      const properties = roller.component?.properties;
      if (!near(Number(p?.[0]), (x0+x1)/2) || !near(Number(p?.[2]), spec.z)
        || !near(Number(properties?.length), x1-x0)
        || !near(Number(properties?.height), 0.9)
        || !near(Math.abs(Number(roller.transform?.rotation?.[1])), Math.PI)) {
        errors.push(`Studio V2 物理输送：套袋 ${id.toUpperCase()} ${which}辊道位置/长度/方向不连续，不能靠逻辑路线跨空运行`);
      }
    }
    const inPoint = `studio-v2-bag-${id}-physical-input`;
    const outPoint = `studio-v2-bag-${id}-physical-output`;
    if (!near(Number(point(inPoint)?.position?.[0]), physicalInputX)
      || !near(Number(point(outPoint)?.position?.[0]), physicalOutputX)
      || !near(Number(point(inPoint)?.position?.[2]), spec.z)
      || !near(Number(point(outPoint)?.position?.[2]), spec.z)) {
      errors.push(`Studio V2 物理输送：套袋 ${id.toUpperCase()} 实体出入口路线点未与辊道对齐`);
    }
    directed(`ref-edge-bag-${id}`,spec.upstream,inPoint,inId);
    directed(`ref-edge-bag-${id}-in-machine`,inPoint,spec.station,machineId);
    directed(`ref-edge-bag-${id}-out-machine`,spec.station,outPoint,machineId);
    directed(`ref-edge-bag-${id}-out`,outPoint,spec.downstream,outId);
  }
  // User's blue arrows: under the arc rack RIGHT, beside the rack UP.
  directed('ref-edge-loaded-upper-right-in','ref-loaded-inner-up','ref-loaded-upper-right-in',
    'reference-conveyor-ref-edge-loaded-upper-right-in');
  directed('ref-edge-loaded-upper-right','ref-loaded-upper-right-in','ref-loaded-upper-right-out',
    'reference-double-small-upper-right');
  const horizontalFrom = point('ref-loaded-inner-up')?.position, horizontalTo = point('ref-loaded-upper-right-in')?.position;
  const verticalFrom = point('ref-loaded-upper-right-in')?.position, verticalTo = point('ref-loaded-upper-right-out')?.position;
  if (!horizontalFrom || !horizontalTo || horizontalTo[0]-horizontalFrom[0] < 1
    || !near(horizontalFrom[2],horizontalTo[2])) {
    errors.push('Studio V2 物理输送：缓存架下方蓝色箭头必须从左向右');
  }
  if (!verticalFrom || !verticalTo || verticalFrom[2]-verticalTo[2] < 1
    || !near(verticalFrom[0],verticalTo[0])) {
    errors.push('Studio V2 物理输送：缓存架右侧内排蓝色箭头必须从下向上');
  }
  const double = object('reference-double-small-upper-right');
  if (!double || double.component?.properties?.laneAReverse !== false
    || double.component?.properties?.laneBReverse !== true) {
    errors.push('Studio V2 物理输送：右上双排辊道 A 排必须上行、B 排必须下行');
  }
  // Bag A joins the B lane at the center of the line, not at its remote
  // endpoint. A direct b-input connection would visually skip 4.8 metres.
  const taps = double?.component?.properties?.routeTaps;
  const tap = Array.isArray(taps) ? taps.find((item: any) => item.tapId === 'bag-a-outfeed' && item.lane === 'B') : undefined;
  if (!tap || !near(Number(tap.localX),1.4)
    || !(manifest.connections || []).some(connection =>
      connection.from.objectId === 'studio-v2-bag-a-outfeed-roller'
      && connection.from.portId === 'output'
      && connection.to.objectId === 'reference-double-small-upper-right'
      && connection.to.portId === 'b-bag-a-outfeed')) {
    errors.push('Studio V2 物理输送：套袋 A 出口必须连接右侧双排 B 道中途接驳口，不能连接远端入口');
  }
  return errors;
}
