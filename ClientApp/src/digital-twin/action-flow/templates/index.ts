import type { TwinActionFlowDefinitionV2, TwinActionFlowNode, TwinActionFlowNodeType } from '../contracts/action-flow-v2';

export type ActionFlowTemplateKind = 'robot-pick-place' | 'gantry-stacking' | 'process-handshake' | 'diverter-routing' | 'empty-pallet-return';
export interface ActionFlowTemplateOptions { actorObjectId?: string; sourceWorkPointId?: string; targetWorkPointId?: string; sourceSlotId?: string; targetSlotId?: string; toolFrameId?: string; routeId?: string; sectionId?: string; readyBindingId?: string; commandBindingId?: string; ackBindingId?: string; busyBindingId?: string; doneBindingId?: string; faultBindingId?: string; interlockIds?: string[]; }
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
const node = (type: TwinActionFlowNodeType, name: string, x: number, y: number, actorObjectId?: string, config: Record<string, unknown> = {}): TwinActionFlowNode => ({ nodeId: id(type.toLowerCase()), type, name, actorObjectId, config, editor: { x, y } });
const build = (name: string, key: string, nodes: TwinActionFlowNode[], edgePairs: Array<[TwinActionFlowNode, TwinActionFlowNode, string?]>, actorObjectIds: string[] = []): TwinActionFlowDefinitionV2 => ({ flowId: id('flow'), key: `${key}-${Date.now().toString(36)}`, name, contractVersion: '2.0', actorObjectIds: [...new Set(actorObjectIds.filter(Boolean))], variables: [], nodes, edges: edgePairs.map(([a, b, port], index) => ({ edgeId: id(`edge-${index}`), sourceNodeId: a.nodeId, sourcePort: port || 'success', targetNodeId: b.nodeId })), policies: { defaultTimeoutSeconds: 300, maxLoopIterations: 100, requireInterlockForCommands: true }, enabled: true, revision: 1, status: 'Draft' });

export const createRobotPickPlaceTemplate = (o: ActionFlowTemplateOptions = {}) => {
	const a = o.actorObjectId; const s = node('Start', '开始 / 安全联锁', 40, 160, undefined, { interlockIds: o.interlockIds || [] });
	const reserve = node('ReserveSlot', '预留目标槽', 240, 160, undefined, { slotId: o.targetSlotId || '' }); reserve.timeoutPolicy = { seconds: 30, onTimeout: 'fault' };
	const movePick = node('MoveTo', '到抓取位', 440, 160, a, { workPointId: o.sourceWorkPointId || '', speedRatio: 0.7, interlockIds: o.interlockIds || [] });
	const close = node('GripClose', '夹紧', 640, 160, a, { interlockIds: o.interlockIds || [] });
	const attach = node('Attach', '确认抓取 / 物料归属到工具', 840, 160, a, { sourceSlotId: o.sourceSlotId || '', toolFrameId: o.toolFrameId || '' });
	const place = node('MoveTo', '到放置位', 1040, 160, a, { workPointId: o.targetWorkPointId || '', speedRatio: 0.7, interlockIds: o.interlockIds || [] });
	const detach = node('Detach', '放置 / 物料归属到目标槽', 1240, 160, a, { targetSlotId: o.targetSlotId || '', toolFrameId: o.toolFrameId || '' });
	const open = node('GripOpen', '松开', 1440, 160, a, { interlockIds: o.interlockIds || [] }); const home = node('Home', '返回 Home', 1640, 160, a, { interlockIds: o.interlockIds || [] }); const end = node('End', '结束', 1840, 160);
	return build('机器人取放模板', 'robot-pick-place', [s, reserve, movePick, close, attach, place, detach, open, home, end], [[s,reserve],[reserve,movePick],[movePick,close],[close,attach],[attach,place],[place,detach],[detach,open],[open,home],[home,end]], a ? [a] : []);
};

export const createGantryStackingTemplate = (o: ActionFlowTemplateOptions = {}) => {
	const a=o.actorObjectId; const s=node('Start','开始',40,180,undefined,{interlockIds:o.interlockIds||[]}); const reserve=node('ReserveSlot','预留木托层位',240,180,undefined,{slotId:o.targetSlotId||''}); reserve.timeoutPolicy={seconds:60,onTimeout:'manualConfirm'}; const pick=node('MoveTo','桁架到取料位',440,180,a,{workPointId:o.sourceWorkPointId||'',interlockIds:o.interlockIds||[]}); const attach=node('Attach','抓取',640,180,a,{sourceSlotId:o.sourceSlotId||'',toolFrameId:o.toolFrameId||''}); const place=node('MoveTo','到参数化码垛位',840,180,a,{workPointId:o.targetWorkPointId||'',interlockIds:o.interlockIds||[]}); const detach=node('Detach','放置并更新层位',1040,180,a,{targetSlotId:o.targetSlotId||'',toolFrameId:o.toolFrameId||''}); const release=node('ReleaseSlot','提交层位占用',1240,180,undefined,{slotId:o.targetSlotId||''}); const end=node('End','结束',1440,180); return build('桁架码垛模板','gantry-stacking',[s,reserve,pick,attach,place,detach,release,end],[[s,reserve],[reserve,pick],[pick,attach],[attach,place],[place,detach],[detach,release],[release,end]],a?[a]:[]);
};

export const createProcessHandshakeTemplate = (o: ActionFlowTemplateOptions = {}) => {
	const s=node('Start','开始',40,180,undefined,{interlockIds:o.interlockIds||[]}); const ready=node('WaitSignal','等待 Ready',240,180,undefined,{bindingId:o.readyBindingId||'',operator:'truthy'}); ready.timeoutPolicy={seconds:60,onTimeout:'fault'}; const cmd=node('WriteCommand','下发 commandId / recipe',440,180,o.actorObjectId,{bindingId:o.commandBindingId||'',interlockIds:o.interlockIds||[],payload:{}}); cmd.timeoutPolicy={seconds:30,onTimeout:'retry'}; cmd.retryPolicy={maxAttempts:3,backoffSeconds:1,backoffMultiplier:2}; const ack=node('WaitAck','等待 Ack(commandId)',640,180,undefined,{bindingId:o.ackBindingId||'',operator:'truthy'}); ack.timeoutPolicy={seconds:30,onTimeout:'retry'}; ack.retryPolicy={maxAttempts:3,backoffSeconds:1}; const busy=node('WaitSignal','等待 Busy',840,180,undefined,{bindingId:o.busyBindingId||'',operator:'truthy'}); busy.timeoutPolicy={seconds:60,onTimeout:'fault'}; const done=node('WaitSignal','等待 Done/cycleId',1040,180,undefined,{bindingId:o.doneBindingId||'',operator:'truthy'}); done.timeoutPolicy={seconds:300,onTimeout:'manualConfirm'}; const end=node('End','结束',1240,180); return build('工艺设备标准握手模板','process-handshake',[s,ready,cmd,ack,busy,done,end],[[s,ready],[ready,cmd],[cmd,ack],[ack,busy],[busy,done],[done,end]],o.actorObjectId?[o.actorObjectId]:[]);
};

export const createDiverterRoutingTemplate = (o: ActionFlowTemplateOptions = {}) => {
	const s=node('Start','识别运输单元',40,180); const reserve=node('ReserveSection','预占岔口/下游区段',260,180,undefined,{routeId:o.routeId||'',sectionId:o.sectionId||''}); reserve.timeoutPolicy={seconds:30,onTimeout:'fault'}; const select=node('SelectRoute','计算并选择目标路线',500,180,undefined,{routeId:o.routeId||''}); const enter=node('EnterSection','放行进入共享区',740,180,undefined,{routeId:o.routeId||'',sectionId:o.sectionId||''}); const leave=node('LeaveSection','离开并释放区段',980,180,undefined,{routeId:o.routeId||'',sectionId:o.sectionId||''}); const end=node('End','结束',1220,180); return build('岔口分流模板','diverter-routing',[s,reserve,select,enter,leave,end],[[s,reserve],[reserve,select],[select,enter],[enter,leave],[leave,end]]);
};

export const createEmptyPalletReturnTemplate = (o: ActionFlowTemplateOptions = {}) => {
	const s=node('Start','外检后判断载荷',40,180); const cond=node('Condition','是否空托',260,180,undefined,{predicate:{logic:'and',items:[{source:'material',ref:'payload.count',operator:'eq',value:0}]}}); const reserve=node('ReserveSection','预占空托回流区',500,100,undefined,{routeId:o.routeId||'',sectionId:o.sectionId||''}); reserve.timeoutPolicy={seconds:30,onTimeout:'fault'}; const enter=node('EnterSection','进入空托反向回流',740,100,undefined,{routeId:o.routeId||'',sectionId:o.sectionId||''}); const release=node('LeaveSection','回到机器人入口并释放',980,100,undefined,{routeId:o.routeId||'',sectionId:o.sectionId||''}); const normal=node('Merge','有料继续下游',740,280); const end=node('End','结束',1220,180); const flow=build('空托盘回流模板','empty-pallet-return',[s,cond,reserve,enter,release,normal,end],[[s,cond],[cond,reserve,'true'],[reserve,enter],[enter,release],[release,end],[cond,normal,'false'],[normal,end]]); return flow;
};

export const actionFlowTemplates = [
	{ kind:'robot-pick-place' as const, name:'机器人取放', create:createRobotPickPlaceTemplate },
	{ kind:'gantry-stacking' as const, name:'桁架码垛', create:createGantryStackingTemplate },
	{ kind:'process-handshake' as const, name:'工艺设备握手', create:createProcessHandshakeTemplate },
	{ kind:'diverter-routing' as const, name:'岔口分流', create:createDiverterRoutingTemplate },
	{ kind:'empty-pallet-return' as const, name:'空托盘回流', create:createEmptyPalletReturnTemplate },
];

export const createActionFlowTemplate = (kind: ActionFlowTemplateKind, options: ActionFlowTemplateOptions = {}) => actionFlowTemplates.find((item) => item.kind === kind)?.create(options) || createRobotPickPlaceTemplate(options);
