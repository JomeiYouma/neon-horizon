import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js';
import { init } from './lib/three-init';
import { getAudio, setAnalyserSource } from './lib/audio.js';
import { createRhythmGame } from './rhythm.js';

// No FPS panel in the production build
const {scene, camera, renderer, canvas, stats} = init(import.meta.env.PROD);

/**
 * Camera
 */
camera.near = 0.01;
camera.far = 20;
camera.position.set(0, 0.06, 1.1);
camera.updateProjectionMatrix();

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

/**
 * Distance fade (replaces the fog)
 * The fog turned the far terrain black, so its silhouette popped in front of the sun.
 * Instead, the terrain becomes transparent with the distance to the camera, revealing the sun behind.
 * dithering: true -> fade with a dithered pattern (Material.alphaHash) instead of real transparency
 */
const fade = {
    uFadeNear: { value: 2.5 },
    uFadeFar: { value: 3.5 },
    dithering: true
};

/**
 * Textures
 */
const textureLoader = new THREE.TextureLoader();
// BASE_URL: the build is served from a sub-folder on GitHub Pages
const staticUrl = (file) => `${import.meta.env.BASE_URL}${file}`;
const gridTexture = textureLoader.load(staticUrl('grid-6.png'));
const heightTexture = textureLoader.load(staticUrl('displacement-7.png'));
const metalnessTexture = textureLoader.load(staticUrl('metalness-2.png'));

/**
 * Colors
 */
const colors = {
    grid: '#00ff41',      // grid lines
    spotlight: '#39ff14', // electric green reflections
    sunTop: '#e4ff4a',    // sun gradient, top (lime yellow)
    sunBottom: '#00c853'  // sun gradient, bottom (deep green)
};

/**
 * Terrain: three planes following each other to loop endlessly
 * (three so the far edge always stays beyond uFadeFar)
 */
const geometry = new THREE.PlaneGeometry(1, 2, 24, 24);
const material = new THREE.MeshStandardMaterial({
    map: gridTexture,
    color: colors.grid,
    displacementMap: heightTexture,
    displacementScale: 0.4,
    metalnessMap: metalnessTexture,
    metalness: 1,
    roughness: 0.5,
    transparent: !fade.dithering,
    alphaHash: fade.dithering
});

/**
 * Morphing peaks: each vertex height oscillates slowly with its own random phase.
 * The flat middle (black in the displacement map) stays flat since heights are multiplied.
 * The phase uses fract(uv.y) so the far edge of a plane matches the near edge of the next one.
 */
const morph = {
    speed: 0.8,                 // oscillation speed
    uTime: { value: 0 },
    uAmplitude: { value: 0.7 }  // 0 = static mountains, 1 = peaks go down to the ground
};

material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = morph.uTime;
    shader.uniforms.uAmplitude = morph.uAmplitude;
    shader.uniforms.uFadeNear = fade.uFadeNear;
    shader.uniforms.uFadeFar = fade.uFadeFar;

    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
            #include <common>
            uniform float uTime;
            uniform float uAmplitude;
            varying float vViewDepth;
        `)
        .replace('#include <project_vertex>', `
            #include <project_vertex>
            vViewDepth = -mvPosition.z;
        `)
        .replace('#include <displacementmap_vertex>', `
            #ifdef USE_DISPLACEMENTMAP
                vec2 cell = floor(vec2(uv.x, fract(uv.y)) * 24.0 + 0.5);
                float phase = rand(cell) * 6.2831;
                float morphFactor = 1.0 - uAmplitude * (0.5 + 0.5 * sin(uTime + phase));
                transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale * morphFactor + displacementBias );
            #endif
        `);

    // The grid texture is red: keep only its brightness so material.color sets the hue
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `
            #include <common>
            uniform float uFadeNear;
            uniform float uFadeFar;
            varying float vViewDepth;
        `)
        .replace('#include <map_fragment>', `
            #ifdef USE_MAP
                vec4 sampledDiffuseColor = texture2D( map, vMapUv );
                float gridIntensity = max( max( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b );
                diffuseColor *= vec4( vec3( gridIntensity ), sampledDiffuseColor.a );
            #endif

            // Distance fade (used by alphaHash or by the transparency blending)
            diffuseColor.a *= 1.0 - smoothstep( uFadeNear, uFadeFar, vViewDepth );
        `);
};

const planes = [];

for (let i = 0; i < 3; i++) {
    const plane = new THREE.Mesh(geometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.z = 0.15 - i * 2;
    scene.add(plane);
    planes.push(plane);
}

/**
 * Synthwave sun: gradient disc with horizontal stripes scrolling down in its lower half
 * Placed far behind the terrain, cut at the horizon (y = 0)
 */
const sunMaterial = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
        uTime: { value: 0 },
        uColorTop: { value: new THREE.Color(colors.sunTop) },
        uColorBottom: { value: new THREE.Color(colors.sunBottom) },
        uStripes: { value: 14 },     // number of stripes on the sun height
        uStripeSpeed: { value: 0.25 }
    },
    vertexShader: `
        varying vec2 vUv;
        varying float vWorldY;

        void main() {
            vUv = uv;
            vWorldY = (modelMatrix * vec4(position, 1.0)).y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform vec3 uColorTop;
        uniform vec3 uColorBottom;
        uniform float uStripes;
        uniform float uStripeSpeed;
        varying vec2 vUv;
        varying float vWorldY;

        void main() {
            // Nothing below the horizon (the far terrain is transparent now)
            if (vWorldY < 0.0) discard;

            // Disc with a soft edge
            float dist = length(vUv - 0.5) * 2.0;
            float disc = 1.0 - smoothstep(0.98, 1.0, dist);

            // Vertical gradient
            vec3 color = mix(uColorBottom, uColorTop, smoothstep(0.1, 0.9, vUv.y));

            // Stripes: gaps start at the middle and get thicker towards the bottom
            float stripe = fract(vUv.y * uStripes + uTime * uStripeSpeed);
            float gapSize = smoothstep(0.55, 0.0, vUv.y) * 0.75;
            float stripes = step(gapSize, stripe);

            float alpha = disc * stripes;
            if (alpha < 0.01) discard;

            gl_FragColor = vec4(color, alpha);
        }
    `
});

const sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunMaterial);
sun.scale.setScalar(3.2);
sun.position.set(0, 0.9, -6);
scene.add(sun);

/**
 * Sound wave drawn on the central line of the grid (x = 0), lying on the ground,
 * from the foot of the sun to the front of the scene.
 * The waveform moves the line sideways: seen in perspective, it forms a sine
 * that shrinks towards the horizon.
 */
const wave = {
    points: 512,       // resolution of the line
    zNear: 1,          // front of the scene
    zFar: sun.position.z, // where the central line meets the sun
    maxWidth: 0.08,    // lateral offset at full volume
    y: 0.002,          // just above the ground to avoid z-fighting
    analyser: null,
    data: null
};

const wavePositions = new Float32Array(wave.points * 3);

const waveGeometry = new THREE.BufferGeometry();
waveGeometry.setAttribute('position', new THREE.BufferAttribute(wavePositions, 3));

const waveLine = new THREE.Line(
    waveGeometry,
    new THREE.LineBasicMaterial({ color: colors.spotlight })
);
waveLine.frustumCulled = false;
scene.add(waveLine);

const updateWave = () => {
    if (wave.analyser) wave.analyser.getByteTimeDomainData(wave.data);

    for (let i = 0; i < wave.points; i++) {
        const progress = i / (wave.points - 1);
        const z = wave.zNear + (wave.zFar - wave.zNear) * progress;

        // Time domain samples: 128 = silence, 0 / 255 = full volume
        const sample = wave.data
            ? (wave.data[Math.floor(progress * (wave.data.length - 1))] - 128) / 128
            : 0;

        wavePositions.set([sample * wave.maxWidth, wave.y, z], i * 3);
    }

    waveGeometry.attributes.position.needsUpdate = true;
};

/**
 * Audio input (lib/audio.js): the terrain and the wave react to the song or to the microphone
 */
const { analyser } = getAudio();
wave.analyser = analyser;
wave.data = new Uint8Array(analyser.fftSize);
wave.frequencies = new Uint8Array(analyser.frequencyBinCount);

const sourceButtons = document.querySelectorAll('.source button');

sourceButtons.forEach((button) => {
    button.addEventListener('click', async () => {
        const next = button.dataset.source;

        try {
            await setAnalyserSource(next);
            sourceButtons.forEach((b) => b.setAttribute('aria-pressed', b === button));
        } catch (error) {
            // Microphone refused: stays on the music
            console.error(error);
            button.textContent = 'Refusé';
            setTimeout(() => (button.textContent = 'Micro'), 1500);
        }
    });
});

/**
 * Lights
 * The article uses three r136 (legacy lights): intensities are multiplied by PI
 * and the spotlight decay forced to 1 to get the same result with r186
 */
const ambientLight = new THREE.AmbientLight('#ffffff', 10 * Math.PI);
scene.add(ambientLight);

const spotlight = new THREE.SpotLight(colors.spotlight, 40 * Math.PI, 25, Math.PI * 0.1, 0.25, 1);
spotlight.position.set(0.5, 0.75, 2.1);
spotlight.target.position.set(-0.25, 0.25, 0.25);
scene.add(spotlight, spotlight.target);

const spotlight2 = new THREE.SpotLight(colors.spotlight, 40 * Math.PI, 25, Math.PI * 0.1, 0.25, 1);
spotlight2.position.set(-0.5, 0.75, 2.1);
spotlight2.target.position.set(0.25, 0.25, 0.25);
scene.add(spotlight2, spotlight2.target);

/**
 * Post-processing
 */
const effectComposer = new EffectComposer(renderer);
effectComposer.setSize(window.innerWidth, window.innerHeight);
effectComposer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

effectComposer.addPass(new RenderPass(scene, camera));

const rgbShiftPass = new ShaderPass(RGBShiftShader);
rgbShiftPass.uniforms['amount'].value = 0.0115;
effectComposer.addPass(rgbShiftPass);

const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.2, 0.4, 0);
effectComposer.addPass(bloomPass);

// Replaces the article's GammaCorrectionShader (color space conversion, must stay last)
effectComposer.addPass(new OutputPass());

window.addEventListener('resize', () => {
    effectComposer.setSize(window.innerWidth, window.innerHeight);
    effectComposer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/**
 * Rhythm game (rhythm.js): spheres on the grid lines, A Z O P to hit them
 * While it runs, the song's beats drive the terrain scroll (one row per 16th note)
 * so the spheres stay on the grid lines
 *
 * The default track is a local file used in development only (static/*.mp3 is not
 * versioned). The production build ships without music: the start screen asks the
 * player for an audio file instead.
 */
const song = import.meta.env.DEV
    ? { url: staticUrl('one-more-time--aerodynamic.mp3'), title: 'One More Time — Aerodynamic' }
    : null;
const game = createRhythmGame({ scene, camera, fade, colors, song });

const scroll = { idleSpeed: 0.15, distance: 0, offsetRows: 0, playing: false };

/**
 * Peaks parameters
 * base: set by the sliders / live: base modulated by the sound, applied to the terrain
 */
const peaks = {
    base: {
        height: material.displacementScale,
        speed: morph.speed,
        amplitude: morph.uAmplitude.value
    },
    live: {}
};
Object.assign(peaks.live, peaks.base);

/**
 * Audio features (0 -> 1), smoothed to avoid jitter
 * volume -> peaks height / brightness (high pitched sound) -> speed / bass -> amplitude
 */
const audioFeatures = { volume: 0, brightness: 0, bass: 0 };

const updateAudioFeatures = (delta) => {
    let volume = 0, brightness = 0, bass = 0;

    if (wave.analyser) {
        // Volume: RMS of the waveform (already read by updateWave)
        let sum = 0;
        for (const value of wave.data) {
            const sample = (value - 128) / 128;
            sum += sample * sample;
        }
        volume = Math.min(Math.sqrt(sum / wave.data.length) * 4, 1);

        wave.analyser.getByteFrequencyData(wave.frequencies);

        // Brightness: spectral centroid on the first 256 bins (~0 -> 5.5kHz)
        let weighted = 0, total = 0;
        for (let i = 0; i < 256; i++) {
            weighted += i * wave.frequencies[i];
            total += wave.frequencies[i];
        }
        brightness = total > 0 ? Math.min((weighted / total / 256) * 3, 1) : 0;

        // Bass: average of the bins under ~200Hz
        let bassSum = 0;
        for (let i = 1; i <= 10; i++) bassSum += wave.frequencies[i];
        bass = bassSum / 10 / 255;
    }

    const smoothing = 1 - Math.exp(-delta * 8);
    audioFeatures.volume += (volume - audioFeatures.volume) * smoothing;
    audioFeatures.brightness += (brightness - audioFeatures.brightness) * smoothing;
    audioFeatures.bass += (bass - audioFeatures.bass) * smoothing;
};

const updatePeaks = () => {
    const { base, live } = peaks;

    live.height = base.height * (1 + audioFeatures.volume * 3);
    live.speed = base.speed * (1 + audioFeatures.brightness * 8);
    live.amplitude = Math.min(base.amplitude + audioFeatures.bass * 0.3, 3);

    material.displacementScale = live.height;
    morph.speed = live.speed;
    morph.uAmplitude.value = live.amplitude;
};

/**
 * Controls (sliders in index.html)
 * The slider sets the base value, the number next to it shows the live value
 */
const outputs = {};

const bindSlider = (id) => {
    const input = document.getElementById(id);
    outputs[id] = document.getElementById(`${id}-value`);

    input.value = peaks.base[id];
    input.addEventListener('input', () => {
        peaks.base[id] = parseFloat(input.value);
    });
};

bindSlider('height');
bindSlider('speed');
bindSlider('amplitude');

const updateOutputs = () => {
    for (const id in outputs) {
        outputs[id].value = peaks.live[id].toFixed(2);
    }
};

/**
 * Animation loop
 */
const timer = new THREE.Timer();
timer.connect(document); // pauses the timer when the tab is hidden

renderer.setAnimationLoop(() => {
    timer.update();
    const elapsedTime = timer.getElapsed();
    const delta = timer.getDelta();

    // Sound: read the waveform, then turn its features into peaks parameters
    updateWave();
    updateAudioFeatures(delta);
    updatePeaks();
    updateOutputs();

    // Accumulated so changing the speed doesn't make the peaks jump
    morph.uTime.value += delta * morph.speed;
    sunMaterial.uniforms.uTime.value = elapsedTime;

    game.update(delta);

    // Terrain scroll: idle speed outside the game, the song's grid during the game
    if (game.running) {
        if (!scroll.playing) {
            // Whole rows only, so the grid lines pass the rings exactly on the 16th notes
            scroll.offsetRows = Math.round(scroll.distance / game.rowLength - game.stepPosition);
            scroll.playing = true;
        }
        scroll.distance = (game.stepPosition + scroll.offsetRows) * game.rowLength;
    } else {
        scroll.playing = false;
        scroll.distance += scroll.idleSpeed * delta;
    }

    planes.forEach((plane, i) => {
        plane.position.z = ((scroll.distance % 2) + 2) % 2 - i * 2;
    });

    // Post-processing reacts to the game: glitch on a miss, flash on a perfect, pulse on the kick
    rgbShiftPass.uniforms['amount'].value = 0.001 + 0.006 * game.fx.glitch;
    bloomPass.strength = 0.2 + 0.3 * game.fx.flash;
    sun.scale.setScalar(3.2 * (1 + 0.015 * game.fx.beat));

    controls.update();

    // Always face the camera, even when orbiting
    sun.lookAt(camera.position);

    effectComposer.render();

    if (stats) stats.update();
});
