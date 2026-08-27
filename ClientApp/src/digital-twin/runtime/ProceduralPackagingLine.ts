/**
 * 旧文件名兼容层。
 * V3 起真实实现已拆为 SilkCakeLineRuntime（业务）和 ProceduralSilkCakeLine（显示），
 * 禁止再在此处恢复“整圈 distance += speed”的包装 Demo。
 */
export { ProceduralSilkCakeLine as ProceduralPackagingLine } from '/@/digital-twin/runtime/ProceduralSilkCakeLine';
