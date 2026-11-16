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
    directed(`ref-edge-bag-${id}-out`,outPoint,
      id === 'a' ? 'ref-post-bag-merge' : spec.downstream,outId);
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
    || double.component?.properties?.laneBReverse !== false) {
    errors.push('Studio V2 物理输送：右上双排辊道 A/B 两排必须都向上，B 排不能把套袋出口向下输送');
  }
  // Bag A joins the B lane at the center of the line, not at its remote
  // endpoint. A direct b-input connection would visually skip 4.8 metres.
  const taps = double?.component?.properties?.routeTaps;
  const tap = Array.isArray(taps) ? taps.find((item: any) => item.tapId === 'bag-a-upward-merge' && item.lane === 'B') : undefined;
  if (!tap || !near(Number(tap.localX),1.4)
    || !(manifest.connections || []).some(connection =>
      connection.from.objectId === 'studio-v2-bag-a-outfeed-roller'
      && connection.from.portId === 'output'
      && connection.to.objectId === 'reference-double-small-upper-right'
      && connection.to.portId === 'b-bag-a-upward-merge')) {
    errors.push('Studio V2 物理输送：套袋 A 左侧出口必须接入上行 B 道中部合流口，不能连接远端入口');
  }
  const joint=point('ref-post-bag-merge')?.position, lower=point('ref-b-bag-left')?.position;
  const upperTop=point('studio-v2-post-bag-upper-top')?.position;
  if(!joint || !lower || !upperTop || !near(joint[0],6.8) || !near(joint[2],-12.9)
    || !near(upperTop[0],6.8) || !near(upperTop[2],-17.7)
    || !near(lower[0],6.8) || !(joint[2]<lower[2] && upperTop[2]<joint[2])) {
    errors.push('Studio V2 物理输送：A/B 必须在上方套袋机左侧合流，再向上到顶部，不准先向下再返回');
  }
  directed('ref-edge-bag-b-merge','ref-b-bag-left','ref-post-bag-merge','reference-double-small-upper-right');
  directed('ref-edge-post-bag-up','ref-post-bag-merge','studio-v2-post-bag-upper-top','reference-double-small-upper-right');
  directed('studio-v2-post-bag-top-west','studio-v2-post-bag-upper-top','ref-loaded-upper-right-out',
    'studio-v2-post-bag-top-west-roller');
  if(edge('ref-edge-bag-a-lane-down') || object('reference-conveyor-ref-edge-post-bag-up')) {
    errors.push('Studio V2 物理输送：套袋合流后旧的向下绕行路段仍存在，禁止原路运行');
  }
  const northRoller=object('studio-v2-post-bag-top-west-roller');
  if(!northRoller || northRoller.component?.componentType!=='roller-conveyor'
    || !near(Number(northRoller.component.properties.length),1.9)
    || !near(Number(northRoller.transform.position?.[0]),5.85)
    || !near(Number(northRoller.transform.position?.[2]),-17.7)) {
    errors.push('Studio V2 物理输送：合流上行后顶部向左转弯必须存在实体 1.9 米过渡辊道');
  }
  if(!(manifest.connections||[]).some(c=>
    c.from.objectId==='studio-v2-bag-b-outfeed-roller'
    && c.to.objectId==='reference-double-small-upper-right'
    && c.to.portId==='b-input')) {
    errors.push('Studio V2 物理输送：套袋 B 出口必须接到右侧双排 B 线南端，然后向北合流');
  }

  // User's floor plan: directly below the arc cache robot are TWO separate
  // horizontal conveyor lanes. Inner A goes RIGHT (+X); outer B goes LEFT
  // (-X). A shared bidirectional single-lane route must never pass this guard.
  const handoffId='studio-v2-surplus-silk-handoff-roller';
  const handoff=object(handoffId);
  const handoffProps=handoff?.component?.properties;
  const routeHandoff=manifest.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
  if(!handoff || handoff.component?.componentType!=='double-small-roller-conveyor'
    || handoff.component.generator!=='double-small-roller-conveyor-v1'
    || handoff.component.resourceKey!=='builtin-double-small-roller-conveyor'
    || handoffProps?.laneAReverse!==false || handoffProps?.laneBReverse!==true
    || !near(Number(handoffProps?.length),5.4)
    || !near(Number(handoffProps?.laneWidth),1.55)
    || !near(Number(handoffProps?.laneSpacing),1.9)
    || !near(Number(handoff?.transform?.position?.[0]),-4)
    || !near(Number(handoff?.transform?.position?.[2]),-7.2)
    || !near(Number(handoff?.transform?.rotation?.[1]),0)) {
    errors.push('Studio V2 物理输送：缓存机器人下必须有真正的双排小辊道，内排 A 向右、外排 B 向左；单条双向辊道禁止运行');
  }
  const turnId='studio-v2-cache-pallet-empty-u-turn';
  const turn=object(turnId);
  if(!turn || turn.component?.componentType!=='turn-conveyor-90'
    || !near(Number(turn.component?.properties?.sweepDegrees),180)
    || !near(Number(turn.component?.properties?.radius),.95)
    || !near(Number(turn?.transform?.position?.[0]),-1.3)
    || !near(Number(turn?.transform?.position?.[2]),-7.2)
    || turn.component?.properties?.emptyPalletOnly!==true
    || !(manifest.connections||[]).some(c=>c.from.objectId===handoffId
      && c.from.portId==='a-output' && c.to.objectId===turnId && c.to.portId==='input')
    || !(manifest.connections||[]).some(c=>c.from.objectId===turnId
      && c.from.portId==='output' && c.to.objectId===handoffId && c.to.portId==='b-input')) {
    errors.push('Studio V2 物理输送：机器人取丝后空托必须经右端实体 180 度 U 形辊道下到 B 排，禁止从 A 跳到 B');
  }
  if(!routeHandoff || routeHandoff.points.length!==6 || routeHandoff.edges.length!==5
    || routeHandoff.edges.some(e=>e.enabled===false || e.bidirectional===true)) {
    errors.push('Studio V2 物理输送：缓存交接必须含 A 载丝向右、实体 U 转向下、B 空托向左的连续单向路径（6 点5边）');
  } else {
    const handoffPoint=(id:string)=>routeHandoff.points.find(p=>p.pointId===id)?.position;
    const directedHandoff=(id:string,from:string,to:string)=>{
      const e=routeHandoff.edges.find(edge=>edge.edgeId===id);
      if(!e || e.fromPointId!==from || e.toPointId!==to) {
        errors.push(`Studio V2 物理输送：缓存交接 ${id} 与图纸箭头方向不一致`);
      }
    };
    for(const [id,xyz] of [
      ['surplus-a-west',[-6.7,0.9,-8.15]],
      ['surplus-a-robot',[-4,0.9,-8.15]],
      ['surplus-a-east',[-1.3,0.9,-8.15]],
      ['surplus-b-east',[-1.3,0.9,-6.25]],
      ['surplus-b-robot',[-4,0.9,-6.25]],
      ['surplus-b-west',[-6.7,0.9,-6.25]],
    ] as Array<[string,number[]]>) {
      const actual=handoffPoint(id);
      if(!actual || !xyz.every((value,i)=>near(Number(actual[i]),value))) {
        errors.push(`Studio V2 物理输送：缓存交接 ${id} 脱离物理双排辊道`);
      }
    }
    directedHandoff('surplus-a-west-to-robot','surplus-a-west','surplus-a-robot');
    directedHandoff('surplus-a-robot-to-east','surplus-a-robot','surplus-a-east');
    directedHandoff('surplus-b-east-to-robot','surplus-b-east','surplus-b-robot');
    directedHandoff('surplus-b-robot-to-west','surplus-b-robot','surplus-b-west');
    directedHandoff('surplus-empty-after-pick-u-turn','surplus-a-east','surplus-b-east');
    for(const routeEdge of routeHandoff.edges) {
      const carrierEdge=routeEdge as typeof routeEdge & {loadedPalletOnly?: boolean;emptyPalletOnly?: boolean};
      const isTurn=routeEdge.edgeId==='surplus-empty-after-pick-u-turn';
      const isLoaded=routeEdge.edgeId.startsWith('surplus-a-');
      if(routeEdge.componentObjectId!==(isTurn?turnId:handoffId)
        || (isLoaded && carrierEdge.loadedPalletOnly!==true)
        || (!isLoaded && carrierEdge.emptyPalletOnly!==true)) {
        errors.push(`Studio V2 物理输送：${routeEdge.edgeId} 载丝或空托用途/所属设备错误`);
      }
    }
  }
  return errors;
}
