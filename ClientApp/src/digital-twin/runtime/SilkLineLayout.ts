/**
 * V6 丝饼线统一坐标。前处理或产能布局变化时只调整这里，避免运行路线、辊道和设备模型各自漂移。
 */
export const silkLineLayout = {
	lineY: 0.94,
	conveyorY: 0.55,
	lineZ: -5.8,
	loadingX: -6.125,
	loadBufferX: 3.2,
	// 主线位于 z=-5.8，旋转台与丝车进场通道位于主线负 Z 一侧。空托短回流必须
	// 放到主线反侧（正 Z），并以反方向返回机器人；取 z=0 可完整释放丝车进出通道。
	emptyReturnZ: 0,
	emptyReturnWestX: -12.8,
	externalInspectionX: 7,
	inspectionBufferX: 10.5,
	baggingX: 14.5,
	baggingBufferX: 18,
	diverterX: 21,
	gantryStartX: 24,
	gantryLaneEndX: 29.4,
	gantryExitX: 31.2,
	woodPalletX: 26,
	// 木托盘后包装线按“码垛 -> 天盖 -> 缠膜 -> 贴标 -> 入库”展开，
	// 各工位之间保留独立的大辊道缓冲段，避免设备机架互相重叠。
	coverX: 40,
	wrappingX: 50,
	labelX: 60,
	inboundX: 70,
	storedX: 76,
	returnEastX: 58,
	returnNorthZ: 34,
	returnWestX: -42,
} as const;
