import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js';
import { init, run } from './lib/three-init';

const {scene, camera, renderer, canvas} = init();

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
 * Fog
 */
scene.fog = new THREE.Fog('#000000', 1, 2.5);

/**
 * Textures
 */
const textureLoader = new THREE.TextureLoader();
const gridTexture = textureLoader.load('/grid-6.png');
const heightTexture = textureLoader.load('/displacement-7.png');
const metalnessTexture = textureLoader.load('/metalness-2.png');

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
 * Terrain: two planes following each other to loop endlessly
 */
const geometry = new THREE.PlaneGeometry(1, 2, 24, 24);
const material = new THREE.MeshStandardMaterial({
    map: gridTexture,
    color: colors.grid,
    displacementMap: heightTexture,
    displacementScale: 0.4,
    metalnessMap: metalnessTexture,
    metalness: 1,
    roughness: 0.5
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

    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `
            #include <common>
            uniform float uTime;
            uniform float uAmplitude;
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
        .replace('#include <map_fragment>', `
            #ifdef USE_MAP
                vec4 sampledDiffuseColor = texture2D( map, vMapUv );
                float gridIntensity = max( max( sampledDiffuseColor.r, sampledDiffuseColor.g ), sampledDiffuseColor.b );
                diffuseColor *= vec4( vec3( gridIntensity ), sampledDiffuseColor.a );
            #endif
        `);
};

const plane = new THREE.Mesh(geometry, material);
const plane2 = new THREE.Mesh(geometry, material);

plane.rotation.x = -Math.PI / 2;
plane2.rotation.x = -Math.PI / 2;

plane.position.z = 0.15;
plane2.position.z = -1.85;

scene.add(plane, plane2);

/**
 * Synthwave sun: gradient disc with horizontal stripes scrolling down in its lower half
 * Placed far behind the terrain, not affected by the fog (ShaderMaterial ignores it)
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

        void main() {
            vUv = uv;
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

        void main() {
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
rgbShiftPass.uniforms['amount'].value = 0.001;
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
 * Animation loop
 */
let elapsedTime = 0;

const animation = (delta)=>{
    elapsedTime += delta;

    morph.uTime.value = elapsedTime * morph.speed;
    sunMaterial.uniforms.uTime.value = elapsedTime;

    plane.position.z = (elapsedTime * 0.15) % 2;
    plane2.position.z = ((elapsedTime * 0.15) % 2) - 2;

    controls.update();

    // Always face the camera, even when orbiting
    sun.lookAt(camera.position);
}

run(animation, () => effectComposer.render());
