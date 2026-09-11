import * as THREE from 'three'
import { createScene, disposeScene, setStats, setCamera, setRenderer, setControls, setTransformControls, setEffectComposer, setCss2DRenderer, setCss3DRenderer, setFpsClock } from '../Api/ThreeApi'
import { initSceneEditor } from '../Editor/Editor.js'

/* 初始化场景 */
export function initScene(DOM, initParams, sceneParams, saveScene) {

    // 创建场景
    const scene = createScene()

    // 创建相机
    const camera = setCamera(scene, DOM)

    // 渲染场景
    const renderer = setRenderer(initParams, DOM)

    // 轨道控制
    const controls = setControls(camera, renderer)

    // 变换控制
    const transformControls = setTransformControls(scene, camera, renderer, controls)

    // 后期渲染
    const { Composer } = setEffectComposer(scene, camera, renderer, DOM)

    // Css3DOM
    const { Css3Render, CSS3DObject } = setCss3DRenderer(DOM)

    // Css2DOM
    const { CssRender, CSS2DObject } = setCss2DRenderer(DOM)

    // 模型动画
    const MixerList = []

    // 着色动画
    const ShaderList = []

    // 公共动画
    const CommonFrameList = []

    // 性能监控
    const Stats = setStats(DOM)

    // 控制面板
    const args = initSceneEditor(scene, camera, renderer, controls, transformControls, Composer, MixerList, ShaderList, CommonFrameList, Stats, DOM, { ...sceneParams }, (sceneParams, meshListParams) => saveScene(sceneParams, meshListParams), initParams.userPermissions)

    // 帧率控制
    const renderFps = setFpsClock(initParams.fps)
    const demandRender = initParams.performanceMode === true
    const preferComposerWhenIdle = initParams.preferComposerWhenIdle === true
    // Preserve upstream behavior unless a professional engineering editor opts out.
    const continuousAnimation = initParams.continuousAnimation !== false
    const hasContinuousAnimation = () => MixerList.length > 0 || ShaderList.length > 0 || CommonFrameList.length > 0

    let RENDER_ID = null
    let destroyed = false
    let lastControlsChanged = false
    let viewportInteracting = false

    function requestRender() {

        if (destroyed || RENDER_ID !== null) return

        RENDER_ID = requestAnimationFrame(render)

    }

    function handleViewChange() {

        requestRender()

    }

    function handleInteractionStart() {

        viewportInteracting = true
        requestRender()

    }

    function handleInteractionEnd() {

        viewportInteracting = false
        requestRender()

    }

    function handleTransformDraggingChanged(event) {

        viewportInteracting = Boolean(event.value)
        requestRender()

    }

    controls.addEventListener('change', handleViewChange)
    controls.addEventListener('start', handleInteractionStart)
    controls.addEventListener('end', handleInteractionEnd)
    transformControls.addEventListener('change', handleViewChange)
    transformControls.addEventListener('dragging-changed', handleTransformDraggingChanged)

    // 初始只请求一帧；非 performanceMode 仍保持原来的连续渲染。
    requestRender()

    // 窗口变化
    function renderSceneResize() {

        camera.aspect = DOM.clientWidth / DOM.clientHeight

        camera.updateProjectionMatrix()

        renderer.setSize(DOM.clientWidth, DOM.clientHeight)

        Composer.resize()

        ShaderList.forEach(shaderMesh => shaderMesh.uniforms.iResolution && (shaderMesh.uniforms.iResolution.value = new THREE.Vector2(DOM.clientWidth, DOM.clientHeight)))

        Css3Render.resize()

        CssRender.resize()

        requestRender()

    }

    // 销毁场景
    function destroySceneRender() {

        destroyed = true

        if (RENDER_ID !== null) cancelAnimationFrame(RENDER_ID)
        RENDER_ID = null

        controls.removeEventListener('change', handleViewChange)
        controls.removeEventListener('start', handleInteractionStart)
        controls.removeEventListener('end', handleInteractionEnd)
        transformControls.removeEventListener('change', handleViewChange)
        transformControls.removeEventListener('dragging-changed', handleTransformDraggingChanged)

        disposeScene(scene)

        renderer.dispose()

        args.GUI?.destroy?.()

        while (DOM.children.length) DOM.removeChild(DOM.firstChild)

    }

    // 渲染函数
    function render() {

        RENDER_ID = null
        if (destroyed) return
        lastControlsChanged = false

        renderFps(() => {

            if (!initParams.disableStats) Stats.update()

            lastControlsChanged = controls.update() === true

            MixerList.forEach(mixer => mixer.mixerRender())

            ShaderList.forEach(shader => shader.ShaderAnimateRender())

            CommonFrameList.forEach(object => object.frameAnimationRender?.())

            const useDirectRender = initParams.sourceRender && (!preferComposerWhenIdle || viewportInteracting || transformControls.dragging || lastControlsChanged)
            if (useDirectRender) renderer.render(scene, camera)
            else Composer.EffectComposerRender()

            if (!initParams.disableCssRender) {
                Css3Render.render(scene, camera)
                CssRender.render(scene, camera)
            }

        })

        // 专业设计器静止时停止 RAF；拖动、相机阻尼、动画存在时继续。
        if (!demandRender || lastControlsChanged || transformControls.dragging || (continuousAnimation && hasContinuousAnimation())) requestRender()

    }

    return { scene, camera, renderer, controls, transformControls, MixerList, ShaderList, CommonFrameList, Stats, Composer, CSS3DObject, CSS2DObject, renderScene: requestRender, renderSceneResize, destroySceneRender, ...args }

}
