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
  // Operator-corrected full-width EMPTY SMALL-PALLET loop:
  // far RIGHT (10.8,6.8) -> 90° SOUTH (10.8,9)
  // -> WEST across entire production floor to (-14.6,9)
  // -> second 90° SOUTH to (-14.6,15.2).
  // Do NOT confuse this with the robot-local half-length red conveyor.
  const fullSpan='reference-conveyor-ref-empty-return-merge';
  const rightDown='reference-conveyor-ref-empty-return-down';
  const leftDown='reference-conveyor-ref-return-edge-outer-down';
  const leftMerger='reference-gantry-merger';
  const full=object(fullSpan), right=object(rightDown);
  const left=object(leftDown), merger=object(leftMerger);
  const coordinates=[
    ['ref-empty-return-diverter',[10.8,.9,6.8]],
    ['ref-empty-return-turn-b',[10.8,.9,9]],
    ['ref-gantry-merger',[-14.6,.9,9]],
    ['ref-return-outer-bottom',[-14.6,.9,15.2]],
  ] as Array<[string, number[]]>;
  for(const [id,expected] of coordinates){
    const actual=point(id)?.position;
    if(!actual||!expected.every((v,i)=>near(Number(actual[i]),v)))
      errors.push(`Studio V2：完整空小托回流直角位置错误：${id}`);
  }
  directed('ref-empty-return-down','ref-empty-return-diverter','ref-empty-return-turn-b',rightDown);
  directed('ref-empty-return-merge','ref-empty-return-turn-b','ref-gantry-merger',fullSpan);
  directed('ref-return-edge-outer-down','ref-gantry-merger','ref-return-outer-bottom',leftDown);
  if(!full || full.component?.componentType!=='roller-conveyor'
    || !near(Number(full.component?.properties?.length),25.4)
    || !near(Number(full.transform?.position?.[0]),-1.9)
    || !near(Number(full.transform?.position?.[2]),9)
    || !near(Math.abs(Number(full.transform?.rotation?.[1])),Math.PI)
    || full.component?.properties?.fullSpanTwoSquareElbows!==true
    || full.component?.properties?.squareCornerSequence!=='right-down-west-left-down'
    || full.component?.properties?.emptySmallPalletOnly!==true
    || !right || !near(Number(right.transform?.position?.[0]),10.8)
    || !near(Number(right.transform?.position?.[2]),7.9)
    || !left || !near(Number(left.transform?.position?.[0]),-14.6)
    || !near(Number(left.transform?.position?.[2]),12.1)
    || !merger || merger.component?.properties?.emptyReturnSquareThirdInput!==true) {
    errors.push('Studio V2：整线从最右到最左的空小托回流必须保留两次90度直角（右侧下转、横向向左、左侧下转），不可仅有一根直辊道');
  }
  if(!(manifest.connections||[]).some(c=>
      c.from.objectId===rightDown&&c.from.portId==='output'
      &&c.to.objectId===fullSpan&&c.to.portId==='square-right-input')
    || !(manifest.connections||[]).some(c=>
      c.from.objectId===fullSpan&&c.from.portId==='output'
      &&c.to.objectId===leftMerger&&c.to.portId==='empty-return-square-input')) {
    errors.push('Studio V2：整线空小托回流右端与左端两个90度转角必须有实体端口连接，不允许画成无接驳的直线');
  }
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

  // r13: the THIRD line was the already-existing, 108-pallet loaded main
  // conveyor. It was wrong to draw another blue line overlapping that line.
  // Reuse the original as blue and allow exactly ONE additional red below it.
  const extraBlueId='studio-v2-surplus-silk-handoff-roller';
  const handoffId='reference-conveyor-ref-edge-loaded-upper-right-in';
  const handoff=object(handoffId);
  const handoffProps=handoff?.component?.properties;
  const redId='studio-v2-surplus-silk-empty-return-roller';
  const red=object(redId);
  const redProps=red?.component?.properties;
  const routeHandoff=manifest.routes.find(r=>r.routeId==='studio-v2-surplus-silk-bidirectional-handoff');
  const horizontalNearRobot=objects.filter(o=>
    o.kind==='component'&&o.component?.componentType==='roller-conveyor'
    &&Math.abs(Math.sin(Number(o.transform?.rotation?.[1]||0)))<.01
    &&Number(o.transform?.position?.[2])>=-7.2&&Number(o.transform?.position?.[2])<=-2.5
    &&Number(o.transform?.position?.[0])>=-13.8&&Number(o.transform?.position?.[0])<=5.5);
  if(object(extraBlueId) || horizontalNearRobot.length!==2
    || !horizontalNearRobot.some(o=>o.objectId===handoffId)
    || !horizontalNearRobot.some(o=>o.objectId===redId)) {
    errors.push('Studio V2：机器人下方只能有原108托盘主回路蓝线和下方一条独立红线；禁止重叠生成第三条水平辊道');
  }
  if(!handoff || handoff.component?.componentType!=='roller-conveyor'
    || handoff.component.generator!=='roller-conveyor-v1'
    || handoffProps?.componentOwnedRoute!==true
    || handoffProps?.cacheBranchOutput!==true
    || handoffProps?.cacheReturnEntry!==true
    || !near(Number(handoffProps?.length),15.7)
    || !near(Number(handoffProps?.width),1.55)
    || !near(Number(handoff?.transform?.position?.[0]),-2.95)
    || !near(Number(handoff?.transform?.position?.[2]),-5.3)
    || !near(Number(handoff?.transform?.rotation?.[1]),0)) {
    errors.push('Studio V2：蓝线必须直接复用108托盘原始向右主辊道，不得以新对象复制或修改原有辊道');
  }
  if(!red || red.component?.componentType!=='roller-conveyor'
    || red.component?.generator!=='roller-conveyor-v1'
    || redProps?.emptyPalletOnly!==true
    || redProps?.emptyLaneRole!=='red-westbound-below-existing-blue'
    || !near(Number(redProps?.length),Number(handoffProps?.length)/2)
    || redProps?.halfOfBlue!==true
    || redProps?.alignEastWithBlue!==true
    || !near(Number(redProps?.width),1.55)
    || !near(Number(red?.transform?.position?.[0]),0.975)
    || !near(Number(red?.transform?.position?.[2]),-3.4)
    || !near(Math.abs(Number(red?.transform?.rotation?.[1])),Math.PI)
    || !handoff || Number(red?.transform?.position?.[2])-Number(handoff?.transform?.position?.[2])<1.88) {
    errors.push('Studio V2：下方红色空托辊道必须只有原蓝色主辊道的一半长(7.85米)，右端对齐、向左，不能延长至左侧主回流道');
  }
  const turnId='studio-v2-cache-pallet-empty-u-turn';
  const turn=object(turnId);
  if(!turn || turn.component?.componentType!=='roller-conveyor'
    || turn.component?.generator!=='roller-conveyor-v1'
    || !near(Number(turn.component?.properties?.length),1.9)
    || !near(Number(turn.component?.properties?.width),1.55)
    || turn.component?.properties?.cornerGeometry!=='two-square-90-degree-transfers'
    || turn.component?.properties?.rounded!==false
    || turn.component?.properties?.squareRightAngleTransfer!==true
    || !near(Number(turn?.transform?.position?.[0]),4.9)
    || !near(Number(turn?.transform?.position?.[2]),-4.35)
    || !near(Number(turn?.transform?.rotation?.[1]),-Math.PI/2)
    || turn.component?.properties?.emptyPalletOnly!==true
    || !(manifest.connections||[]).some(c=>c.from.objectId===handoffId
      && c.from.portId==='cache-branch-output' && c.to.objectId===turnId && c.to.portId==='input')
    || !(manifest.connections||[]).some(c=>c.from.objectId===turnId
      && c.from.portId==='output' && c.to.objectId===redId && c.to.portId==='input')) {
    errors.push('Studio V2：右端必须是两次90度直角转接与中间垂直短辊道，禁止半圆弧形 U 转弯');
  }
  const leftUpId='studio-v2-cache-empty-left-square-up';
  const leftUp=object(leftUpId);
  const blueMergeX=Number(handoff?.transform?.position?.[0]);
  const upperBlueZ=Number(handoff?.transform?.position?.[2]);
  const redZ=Number(red?.transform?.position?.[2]);
  const redHalf=Number(redProps?.length)/2;
  const redWestX=Number(red?.transform?.position?.[0])-redHalf;
  const blueEastX=Number(handoff?.transform?.position?.[0])+Number(handoffProps?.length)/2;
  const redEastX=Number(red?.transform?.position?.[0])+redHalf;
  const oldLeft=object('reference-double-small-upper-left');
  if(!leftUp || leftUp.component?.componentType!=='roller-conveyor'
    || leftUp.component?.generator!=='roller-conveyor-v1'
    || leftUp.component?.properties?.squareRightAngleTransfer!==true
    || leftUp.component?.properties?.rounded!==false
    || leftUp.component?.properties?.leftReturnToBlue!==true
    || !near(Number(leftUp.component?.properties?.length),1.9)
    || !near(Number(leftUp.transform?.position?.[0]),blueMergeX)
    || !near(Number(leftUp.transform?.position?.[2]),(upperBlueZ+redZ)/2)
    || !near(Number(leftUp.transform?.rotation?.[1]),Math.PI/2)
    || !near(redWestX,blueMergeX) || !near(redEastX,blueEastX)
    || (oldLeft?.component?.properties?.routeTaps||[]).some((t:any)=>t.tapId==='cache-empty-lower-return')
    || (manifest.connections||[]).some(c=>c.connectionId==='studio-v2-cache-red-lower-empty-return-to-left-downward-lane')
    || !(manifest.connections||[]).some(c=>
      c.from.objectId===redId&&c.from.portId==='output'&&c.to.objectId===leftUpId&&c.to.portId==='input')
    || !(manifest.connections||[]).some(c=>
      c.from.objectId===leftUpId&&c.from.portId==='output'
      &&c.to.objectId===handoffId&&c.to.portId==='cache-return-entry')) {
    errors.push('Studio V2：下方半长红线左端必须以90度直角向上，接入原蓝色辊道中段；不得接到最左侧的长回流竖道');
  }
  if(!routeHandoff || routeHandoff.points.length!==7 || routeHandoff.edges.length!==6
    || routeHandoff.edges.some(e=>e.enabled===false || e.bidirectional===true)) {
    errors.push('Studio V2 物理输送：缓存交接必须含原蓝载丝向右、右端直角向下、半长红空托向左、左端直角向上接蓝线（7 点6边）');
  } else {
    const handoffPoint=(id:string)=>routeHandoff.points.find(p=>p.pointId===id)?.position;
    const directedHandoff=(id:string,from:string,to:string)=>{
      const e=routeHandoff.edges.find(edge=>edge.edgeId===id);
      if(!e || e.fromPointId!==from || e.toPointId!==to) {
        errors.push(`Studio V2 物理输送：缓存交接 ${id} 与图纸箭头方向不一致`);
      }
    };
    for(const [id,xyz] of [
      ['surplus-a-west',[-10.8,0.9,-5.3]],
      ['surplus-a-robot',[-4,0.9,-5.3]],
      ['surplus-a-east',[4.9,0.9,-5.3]],
      ['surplus-b-east',[4.9,0.9,-3.4]],
      ['surplus-b-robot',[1,0.9,-3.4]],
      ['surplus-b-west',[-2.95,0.9,-3.4]],
      ['surplus-empty-downstream-main',[-2.95,0.9,-5.3]],
    ] as Array<[string,number[]]>) {
      const actual=handoffPoint(id);
      if(!actual || !xyz.every((value,i)=>near(Number(actual[i]),value))) {
        errors.push(`Studio V2 物理输送：缓存交接 ${id} 脱离蓝/红独立实体辊道`);
      }
    }
    directedHandoff('surplus-a-west-to-robot','surplus-a-west','surplus-a-robot');
    directedHandoff('surplus-a-robot-to-east','surplus-a-robot','surplus-a-east');
    directedHandoff('surplus-b-east-to-robot','surplus-b-east','surplus-b-robot');
    directedHandoff('surplus-b-robot-to-west','surplus-b-robot','surplus-b-west');
    directedHandoff('surplus-empty-after-pick-u-turn','surplus-a-east','surplus-b-east');
    directedHandoff('surplus-empty-return-left-square-up','surplus-b-west','surplus-empty-downstream-main');
    for(const routeEdge of routeHandoff.edges) {
      const carrierEdge=routeEdge as typeof routeEdge & {loadedPalletOnly?: boolean;emptyPalletOnly?: boolean};
      const isTurn=routeEdge.edgeId==='surplus-empty-after-pick-u-turn';
      const isUp=routeEdge.edgeId==='surplus-empty-return-left-square-up';
      const isLoaded=routeEdge.edgeId.startsWith('surplus-a-');
      if(routeEdge.componentObjectId!==(isTurn?turnId:isUp?leftUpId:isLoaded?handoffId:redId)
        || (isLoaded && carrierEdge.loadedPalletOnly!==true)
        || (!isLoaded && carrierEdge.emptyPalletOnly!==true)) {
        errors.push(`Studio V2 物理输送：${routeEdge.edgeId} 载丝或空托用途/所属设备错误`);
      }
    }
  }
  return errors;
}
