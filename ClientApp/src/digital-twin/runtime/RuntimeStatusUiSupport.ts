import type { CSSProperties } from 'vue';

export type RuntimeCardSide = 'above' | 'below';
export interface RuntimeStatusAnchorLike { x:number; y:number; width:number; height:number; visible:boolean }
export interface RuntimeStatusCardPlacement { side:RuntimeCardSide; cardStyle:CSSProperties; arrowStyle:CSSProperties }

export const buildRuntimeStatusCardPlacement=(anchor:RuntimeStatusAnchorLike,cardWidth:number,verticalGap=16,topGuard=14):RuntimeStatusCardPlacement=>{
	const margin=10,half=cardWidth/2;
	const centerX=Math.max(margin+half,Math.min(anchor.x,Math.max(margin+half,anchor.width-margin-half)));
	const anchorY=Math.max(topGuard,Math.min(anchor.y,Math.max(topGuard,anchor.height-margin)));
	const side:RuntimeCardSide=anchorY>Math.max(190,anchor.height*.44)?'above':'below';
	const cardLeft=centerX-half;
	const arrowX=Math.max(20,Math.min(cardWidth-20,anchor.x-cardLeft));
	return{side,cardStyle:{left:`${centerX}px`,top:`${anchorY}px`,transform:side==='above'?`translate(-50%,calc(-100% - ${verticalGap}px))`:`translate(-50%,${verticalGap}px)`},arrowStyle:{left:`${arrowX}px`}};
};

export interface RuntimeSummaryRow{label:string;value:string}
const text=(v:unknown)=>v===undefined||v===null||v===''?'-':String(v);
const pct=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?`${(v*100).toFixed(1)}%`:text(v);
export const buildRuntimeSummaryRows=(data?:Record<string,unknown>):RuntimeSummaryRow[]=>{
	if(!data)return[];
	const rows:RuntimeSummaryRow[]=[];
	const push=(label:string,value:unknown)=>{if(value!==undefined&&value!==null&&value!=='')rows.push({label,value:text(value)})};
	if(data.palletId){
		push('\u6258\u76d8\u53f7',data.palletId);push('\u72b6\u6001',data.state??data.stage);push('\u5f53\u524d\u5de5\u4f4d',data.section);push('\u8def\u7ebf\u8fdb\u5ea6',typeof data.progress==='number'?pct(data.progress):data.progress);push('\u5faa\u73af\u6b21\u6570',data.cycleCount);
		const carried=data.content as Record<string,unknown>|undefined;push('\u88c5\u8f7d\u4e1d\u997c',carried?.silkCakeId??data.silkCakeId??(data.loaded===false?'\u7a7a\u6258\u76d8':undefined));push('\u4e1d\u997c\u8d28\u91cf',carried?.quality);
		const inspection=carried?.appearanceInspection as Record<string,unknown>|undefined;push('\u5916\u68c0\u7ed3\u679c',inspection?.result??inspection?.state);const bagging=carried?.bagging as Record<string,unknown>|undefined;push('\u5957\u888b\u72b6\u6001',bagging?.state);push('\u7b49\u5f85\u539f\u56e0',data.waitingReason);return rows.slice(0,10);
	}
	if(data.woodenPalletId||(data.id&&data.maxSilkCakeCount)){push('\u6728\u6258\u76d8\u53f7',data.woodenPalletId??data.id);push('\u9636\u6bb5',data.state??data.stage);push('\u5c42\u6570',data.layer!==undefined?`${data.layer}/${data.maxLayers??'-'}`:undefined);push('\u4e1d\u997c\u6570\u91cf',data.silkCakeCount!==undefined?`${data.silkCakeCount}/${data.capacity??data.maxSilkCakeCount??'-'}`:undefined);push('\u4e0a\u76d6',data.coverApplied);push('\u8d34\u6807',data.labelApplied);push('\u7f20\u819c',data.wrapped);return rows.slice(0,8)}
	if(data.station==='external-inspection'){push('\u5de5\u4f4d','\u5916\u68c0\u673a');push('\u72b6\u6001',data.state);push('\u5f53\u524d\u6258\u76d8',data.currentPalletId);push('\u8fdb\u5ea6',typeof data.progress==='number'?pct(data.progress):data.progress);push('\u901a\u8fc7',data.passed);push('NG',data.ng);return rows}
	if(data.station==='bagging'){push('\u5de5\u4f4d','\u5957\u888b\u673a');push('\u72b6\u6001',data.state);push('\u5f53\u524d\u6258\u76d8',data.currentPalletId);push('\u8fdb\u5ea6',typeof data.progress==='number'?pct(data.progress):data.progress);push('\u5df2\u5b8c\u6210',data.completed);return rows}
	if('laneA'in data||'laneB'in data||'targetLayer'in data){push('\u72b6\u6001',data.state);push('\u9636\u6bb5',data.phase);push('\u8fdb\u5ea6',typeof data.progress==='number'?pct(data.progress):data.progress);push('A \u901a\u9053',data.laneA);push('B \u901a\u9053',data.laneB);push('\u76ee\u6807\u5c42',data.targetLayer);return rows}
	if('batchSize'in data||('side'in data&&'row'in data)){push('\u72b6\u6001',data.state);push('\u8fdb\u5ea6',typeof data.progress==='number'?pct(data.progress):data.progress);push('\u6279\u6b21\u6570',data.batchSize);push('\u4e1d\u8f66\u4fa7',data.side);push('\u5f53\u524d\u884c',data.row);push('\u7a7a\u6258\u5c31\u7eea',data.emptyPalletsReady);return rows}
	for(const[key,value]of Object.entries(data)){if(rows.length>=6)break;if(['string','number','boolean'].includes(typeof value))push(key,value)}return rows;
};
