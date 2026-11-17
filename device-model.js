
    import * as THREE from 'three';
    import {FBXLoader} from 'three/addons/loaders/FBXLoader.js';
    import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
    import {loadEpaperSequenceZip} from './epaper-unzip.js';


export function mountDeviceModel(modelHost) {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
    camera.position.set(-1.92, -4.76, 1.93);
    camera.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, powerPreference:'high-performance'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    modelHost.prepend(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xc4cec5, 2.5));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
    keyLight.position.set(3, -4, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xb8ddff, 2.2);
    rimLight.position.set(-4, 1, -3);
    scene.add(rimLight);
    const frontLight = new THREE.DirectionalLight(0xffffff, 2.5);
    frontLight.position.set(0, -5, 2);
    scene.add(frontLight);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = true;
    controls.enableRotate = true;
    controls.rotateSpeed = 0.5;
    controls.panSpeed = 0.6;
    controls.minDistance = 1.1;
    controls.maxDistance = 8;
    controls.target.set(0, 0, 0);

    const EPAPER_FRAME_COUNT = 100;
    const screenCanvas = document.createElement('canvas');
    screenCanvas.width = 1200;
    screenCanvas.height = 900;
    const screenContext = screenCanvas.getContext('2d');
    const screenTexture = new THREE.CanvasTexture(screenCanvas);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.generateMipmaps = false;
    let displayMaterial = null;
    let screenFrameIndex = 0;
    const screenFrameCache = new Map();
    let epaperFrames = null; // Map<帧索引, objectURL>，由 loadEpaperSequenceZip 解包填充
    function loadScreenFrame(frameIndex) {
        if (!screenFrameCache.has(frameIndex)) {
            const url = epaperFrames?.get(frameIndex);
            screenFrameCache.set(frameIndex, new Promise((resolve, reject) => {
                const frame = new Image();
                frame.onload = () => resolve(frame);
                frame.onerror = () => {
                    screenFrameCache.delete(frameIndex);
                    reject(new Error('screen frame failed to load'));
                };
                // 优先用解包后的单文件资源；解包未完成或缺失时回退到逐帧请求。
                frame.src = url || `assets/epaper-sequence/f${String(frameIndex + 1).padStart(4, '0')}.png`;
            }));
        }
        return screenFrameCache.get(frameIndex);
    }
    let active = false, lifecycle = 0, frameTimer = 0, animationFrame = 0;
    let sequenceReady = false;
    async function playScreenFrame(frameIndex, token = lifecycle) {
        if (!active || token !== lifecycle) return;
        try {
            const frame = await loadScreenFrame(frameIndex);
            if (!active || token !== lifecycle) return;
            screenContext.clearRect(0, 0, screenCanvas.width, screenCanvas.height);
            screenContext.drawImage(frame, 0, 0, screenCanvas.width, screenCanvas.height);
            screenTexture.needsUpdate = true;
            if (displayMaterial) displayMaterial.needsUpdate = true;
            screenFrameIndex = (frameIndex + 1) % EPAPER_FRAME_COUNT;
            frameTimer = window.setTimeout(() => playScreenFrame(screenFrameIndex, token), 1000 / 12);
        } catch {
            if (active && token === lifecycle) frameTimer = window.setTimeout(() => playScreenFrame(frameIndex, token), 1000);
        }
    }
    // 一次性拉取并解包 100 帧（100 个请求 -> 1 个），解包失败则回退到逐帧请求。
    loadEpaperSequenceZip('assets/epaper-sequence.zip')
        .then(frames => { epaperFrames = frames; sequenceReady = true; playScreenFrame(screenFrameIndex); })
        .catch(error => {
            console.warn('epaper 序列 zip 解包失败，回退到逐帧请求：', error);
            sequenceReady = true;
            playScreenFrame(screenFrameIndex);
        });
    function createDisplayGeometry(screenMesh) {
        const sourceGeometry = screenMesh.geometry;
        const bounds = sourceGeometry.boundingBox;
        const positions = sourceGeometry.getAttribute('position');
        const normals = sourceGeometry.getAttribute('normal');
        const displayBounds = new THREE.Box3();
        const vertex = new THREE.Vector3();

        // The actual display is the inset +Z face, not the whole panel's bounds.
        // In this FBX: X = 0.20..8.92, Y = -6.77..-0.20, Z = 0.10.
        // Its Y center is -3.485; the whole panel's center (-3.92) is too low.
        for (let index = 0; index < positions.count; index++) {
            const z = positions.getZ(index);
            if (normals.getZ(index) > 0.99 &&
                z > bounds.min.z + 0.00001 &&
                z < bounds.max.z - 0.00001) {
                displayBounds.expandByPoint(vertex.fromBufferAttribute(positions, index));
            }
        }
        if (displayBounds.isEmpty()) {
            throw new Error('Screen inset face not found in FBX geometry');
        }

        const displaySize = displayBounds.getSize(new THREE.Vector3());
        const displayCenter = displayBounds.getCenter(new THREE.Vector3());
        const geometry = new THREE.PlaneGeometry(displaySize.x, displaySize.y);
        geometry.translate(
            displayCenter.x,
            displayCenter.y,
            displayCenter.z + 0.001
        );

        return geometry;
    }
    const loader = new FBXLoader();
    let modelObject = null;
    let screenMesh = null;
    loader.load('assets/ink-display.fbx', object => {
        const bounds = new THREE.Box3().setFromObject(object);
        const size = bounds.getSize(new THREE.Vector3());
        const largest = Math.max(size.x, size.y, size.z) || 1;
        object.scale.setScalar(2.35 / largest);
        object.rotation.set(0, 0, 0);
        const scaledCenter = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
        object.position.sub(scaledCenter);
        object.updateMatrixWorld(true);
        object.traverse(child => {
            if (!child.isMesh) return;
            const meshName = child.name || "mesh";
            const isScreen = meshName === "42寸屏幕";
            const isButton = meshName.includes("按钮");
            const isBoard = meshName.includes("PCB");
            const isTray = meshName.includes("屏幕托盒");
            const materialOptions = isButton
                ? {color: 0xf28a2e, metalness: 0.08, roughness: 0.32}
                : isScreen
                    ? {color: 0xe6dcc7, metalness: 0.02, roughness: 0.76}
                    : isBoard
                        ? {color: 0x7d8178, metalness: 0.2, roughness: 0.55}
                        : isTray
                            ? {color: 0xd3c8b2, metalness: 0.08, roughness: 0.62}
                            : {color: 0xeee5d2, metalness: 0.06, roughness: 0.68};
            child.castShadow = true;
            child.receiveShadow = true;
            child.visible = true;
            child.geometry.clearGroups();
            child.material = new THREE.MeshStandardMaterial({...materialOptions, side: THREE.DoubleSide});
            if (isScreen) {
                screenMesh = child;
            }
        });
        if (screenMesh) {
            screenMesh.geometry.computeBoundingBox();
            displayMaterial = new THREE.MeshBasicMaterial({map: screenTexture, side: THREE.FrontSide, toneMapped: false,
                polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1});
            const displaySurface = new THREE.Mesh(
                createDisplayGeometry(screenMesh),
                displayMaterial
            );
            displaySurface.name = 'display-surface';
            displaySurface.renderOrder = 10;
            screenMesh.add(displaySurface);
        }
        modelObject = object;
        scene.add(object);
        controls.target.set(0, 0, 0);
        if (object.animations?.length) {
            const mixer = new THREE.AnimationMixer(object);
            object.animations.forEach(clip => mixer.clipAction(clip).play());
            object.userData.mixer = mixer;
        }
        modelHost.dataset.ready = 'true';
    }, undefined, error => {
        modelHost.dataset.error = 'true';
        console.error('3D model failed to load', error);
    });

    const clock = new THREE.Clock();
    let lastModelWidth = 0, lastModelHeight = 0;
    function resizeModel() {
        const width = modelHost.clientWidth, height = modelHost.clientHeight;
        /* 页面隐藏时尺寸为 0，别把相机和绘制缓冲写成 1×1；切回概览会重新校准。 */
        if (width < 1 || height < 1) return;
        if (width === lastModelWidth && height === lastModelHeight) return;
        lastModelWidth = width; lastModelHeight = height;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
    }
    const resizeObserver = new ResizeObserver(resizeModel);
    resizeObserver.observe(modelHost);
    window.addEventListener('resize', resizeModel);
    resizeModel();
    function renderModel() {
        if (!active) return;
        /* 每帧按实际尺寸校准，避免首屏布局未稳定时算错高度后一直不修正。 */
        resizeModel();
        const delta = clock.getDelta();
        modelObject?.userData.mixer?.update(delta);
        controls.update();
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(renderModel);
    }
    function syncVisibility() {
        const visible = !document.hidden && !modelHost.closest('.tab-page').hidden;
        if (visible === active) return;
        active = visible;
        lifecycle++;
        if (active) {
            clock.getDelta();
            resizeModel();
            renderModel();
            if (sequenceReady) playScreenFrame(screenFrameIndex);
        } else {
            cancelAnimationFrame(animationFrame);
            clearTimeout(frameTimer);
        }
    }
    document.addEventListener('visibilitychange', syncVisibility);
    window.addEventListener('thplot:tab-changed', syncVisibility);
    syncVisibility();

}
