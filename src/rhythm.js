import * as THREE from 'three';
import { getAudio, resumeAudio, outputLatency, loadSong, loadSongFile, playSong, musicFx, sounds } from './lib/audio.js';
import { analyzeSong } from './lib/chart.js';

/**
 * Rhythm game
 * Spheres ride the two grid lines on each side of the central line and the player
 * hits A Z O P (one key per line) when they reach the rings in front of the camera.
 * Guitar Hero style: rings and key hints lie flat on the grid, the spheres roll
 * on the grid intersections.
 * The notes come from the song itself (lib/chart.js): one grid row = one 16th note.
 */

const KEYS = ['a', 'z', 'o', 'p'];

const JUDGEMENTS = {
    perfect: { text: 'PERFECT', jp: '完璧', color: '#f4ffb0' },
    good:    { text: 'GOOD',    jp: '良い', color: '#39ff14' },
    miss:    { text: 'MISS',    jp: 'ミス', color: '#ff2d95' }
};

/**
 * Rings and shockwaves: flat on the ground, just a bright rim
 */
const ringVertexShader = `
    varying vec2 vUv;
    varying float vViewDepth;

    void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const ringFragmentShader = `
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uGlow;
    uniform float uFadeNear;
    uniform float uFadeFar;
    varying vec2 vUv;
    varying float vViewDepth;

    void main() {
        float d = length(vUv - 0.5) * 2.0;
        if (d > 1.0) discard;

        // Thin bright rim
        float rim = smoothstep(0.14, 0.0, abs(d - 0.88));

        // Flash: glow filling the ring (kept moderate, the bloom amplifies it)
        vec3 color = uColor + uGlow * 0.6;
        float alpha = rim * uOpacity + uGlow * smoothstep(1.0, 0.0, d) * 0.5;

        // Same distance fade as the terrain
        alpha *= 1.0 - smoothstep(uFadeNear, uFadeFar, vViewDepth);

        gl_FragColor = vec4(color, alpha);
    }
`;

/**
 * Notes: glowing spheres, small striped suns rolling on the grid
 */
const sphereVertexShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying float vViewDepth;

    void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPosition.xyz);
        vViewDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const sphereFragmentShader = `
    uniform vec3 uColor;
    uniform vec3 uColorTop;
    uniform float uOpacity;
    uniform float uGlow;
    uniform float uFlicker;
    uniform float uTime;
    uniform float uFadeNear;
    uniform float uFadeFar;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying float vViewDepth;

    void main() {
        // Bright rim, darker centre: a glowing ball
        float rim = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.5);

        // Horizontal stripes on the lower half, like the sun
        float stripe = step(smoothstep(0.5, 0.0, vUv.y) * 0.6, fract(vUv.y * 8.0 + uTime * 0.5));
        vec3 body = mix(uColor * 0.2, uColorTop * 0.8, smoothstep(0.2, 1.0, vUv.y)) * mix(0.15, 1.0, stripe);

        vec3 color = body + uColor * rim * 1.6 + uGlow;
        float alpha = uOpacity;

        // Glitch flicker (missed notes)
        alpha *= 1.0 - uFlicker * step(0.5, fract(uTime * 25.0 + vUv.y * 3.0));

        // Same distance fade as the terrain
        alpha *= 1.0 - smoothstep(uFadeNear, uFadeFar, vViewDepth);

        gl_FragColor = vec4(color, alpha);
    }
`;

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {THREE.Camera} options.camera
 * @param {object} options.fade - { uFadeNear, uFadeFar } uniforms shared with the terrain
 * @param {object} options.colors - scene palette
 * @param {{ url: string, title: string }} [options.song] - default track; without it the player picks a file
 * @param {number} [options.cell] - width of a grid cell
 */
export const createRhythmGame = ({ scene, camera, fade, colors, song, cell = 1 / 24 }) => {
    const rowLength = 2 * cell;             // one grid row (2 cells deep) per 16th note
    const hitZ = 11 / 12;                   // multiple of a row: the rings sit on a grid line
    const lanesX = [-2, -1, 1, 2].map((i) => i * cell);
    const sphereSize = cell;                // note diameter = one cell
    const ringSize = cell * 0.6;            // ring diameter, well inside a cell
    const groundY = 0.002;
    const windows = { perfect: 0.05, good: 0.12 }; // seconds around the hit time

    // Notes appear where the terrain fades in
    const spawnSteps = (hitZ - (camera.position.z - fade.uFadeFar.value - 0.2)) / rowLength;

    const state = {
        presence: 0,          // rings and key hints: 0 hidden (title / results screens) -> 1 in game
        song: null,           // { buffer, chart } once loaded and analysed
        playback: null,       // { startTime, stop }
        running: false,
        songTime: 0,
        stepPosition: 0,      // current position on the 16th grid (float)
        combo: 0,
        maxCombo: 0,
        counts: { perfect: 0, good: 0, miss: 0 },
        pending: [],          // chart notes not spawned yet
        active: []            // notes on screen
    };

    // Post-processing hooks, read by the scene each frame (0 -> 1, decaying)
    const fx = { glitch: 0, flash: 0, beat: 0 };

    const uTime = { value: 0 };
    const planeGeometry = new THREE.PlaneGeometry(1, 1);
    const sphereGeometry = new THREE.SphereGeometry(0.5, 32, 20);

    const makeUniforms = (color) => ({
        uColor: { value: new THREE.Color(color) },
        uColorTop: { value: new THREE.Color(colors.sunTop) },
        uOpacity: { value: 1 },
        uGlow: { value: 0 },
        uFlicker: { value: 0 },
        uTime,
        uFadeNear: fade.uFadeNear,
        uFadeFar: fade.uFadeFar
    });

    // Rings: additive, they glow on the grid
    const makeRingMaterial = (color) => new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: makeUniforms(color),
        vertexShader: ringVertexShader,
        fragmentShader: ringFragmentShader
    });

    // Spheres: solid, they hide what is behind them
    const makeSphereMaterial = (color) => new THREE.ShaderMaterial({
        transparent: true,
        uniforms: makeUniforms(color),
        vertexShader: sphereVertexShader,
        fragmentShader: sphereFragmentShader
    });

    const makeFlat = (material, size) => {
        const mesh = new THREE.Mesh(planeGeometry, material);
        mesh.rotation.x = -Math.PI / 2; // lies on the ground
        mesh.scale.setScalar(size);
        mesh.visible = false;
        scene.add(mesh);
        return { mesh, material };
    };

    const makeSphere = (material, size) => {
        const mesh = new THREE.Mesh(sphereGeometry, material);
        mesh.scale.setScalar(size);
        mesh.visible = false;
        scene.add(mesh);
        return { mesh, material };
    };

    /**
     * Targets: four rings on the hit line
     */
    const targets = lanesX.map((x) => {
        const target = makeFlat(makeRingMaterial(colors.grid), ringSize);
        target.material.uniforms.uOpacity.value = 0;
        target.mesh.position.set(x, groundY, hitZ);
        return {
            ...target,
            glow: 0,
            press: 0,
            color: new THREE.Color(colors.grid),
            baseColor: new THREE.Color(colors.grid)
        };
    });

    /**
     * Key hints: letters painted flat on the grid, just in front of each ring
     * (stretched in depth: seen at a grazing angle they look almost square)
     */
    const KEY_LABELS = ['A', 'Z', 'O', 'P'];
    const keyWidth = cell * 0.55;
    const keyDepth = cell * 0.8;

    const makeKeyTexture = (letter) => {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        // White drawing, tinted by the material color
        const draw = () => {
            context.clearRect(0, 0, size, size);
            context.strokeStyle = '#ffffff';
            context.lineWidth = 6;
            context.strokeRect(8, 8, size - 16, size - 16);
            context.fillStyle = '#ffffff';
            context.font = '900 76px Orbitron, sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(letter, size / 2, size / 2 + 4);
            texture.needsUpdate = true;
        };

        draw();
        document.fonts?.load('900 76px Orbitron').then(draw); // redraw once the font is there

        return texture;
    };

    const keys = lanesX.map((x, lane) => {
        const material = new THREE.MeshBasicMaterial({
            map: makeKeyTexture(KEY_LABELS[lane]),
            color: colors.grid,
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });

        const mesh = new THREE.Mesh(planeGeometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.scale.set(keyWidth, keyDepth, 1);
        mesh.position.set(x, groundY, hitZ + ringSize / 2 + 0.004 + keyDepth / 2);
        mesh.visible = false;
        scene.add(mesh);

        return { mesh, material, press: 0, baseColor: new THREE.Color(colors.grid) };
    });

    const white = new THREE.Color('#ffffff');

    /**
     * Pools: spheres and shockwaves are reused
     */
    const spherePool = [];
    const shockwavePool = [];

    const getSphere = () => spherePool.pop() ?? makeSphere(makeSphereMaterial(colors.spotlight), sphereSize);
    const getShockwave = () => shockwavePool.pop() ?? makeFlat(makeRingMaterial(colors.spotlight), ringSize);

    const release = (pool, item) => {
        item.mesh.visible = false;
        item.material.uniforms.uGlow.value = 0;
        item.material.uniforms.uFlicker.value = 0;
        item.material.uniforms.uOpacity.value = 1;
        pool.push(item);
    };

    const shockwaves = [];

    const spawnShockwave = (lane, color, duration, growth) => {
        const wave = getShockwave();
        wave.mesh.position.copy(targets[lane].mesh.position);
        wave.mesh.visible = true;
        wave.material.uniforms.uColor.value.set(color);
        shockwaves.push({ ...wave, life: 0, duration, growth });
    };

    /**
     * Particles for perfect hits
     */
    const PARTICLES = 96;
    const particlePositions = new Float32Array(PARTICLES * 3).fill(-10);
    const particles = Array.from({ length: PARTICLES }, () => ({ life: 0, velocity: new THREE.Vector3() }));

    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

    const particlePoints = new THREE.Points(
        particleGeometry,
        new THREE.PointsMaterial({
            color: colors.sunTop,
            size: 0.008,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        })
    );
    particlePoints.frustumCulled = false;
    scene.add(particlePoints);

    const burst = (position, count) => {
        let spawned = 0;
        for (let i = 0; i < PARTICLES && spawned < count; i++) {
            const particle = particles[i];
            if (particle.life > 0) continue;

            particle.life = 1;
            particle.velocity.set(
                (Math.random() - 0.5) * 0.25,
                0.08 + Math.random() * 0.2,
                (Math.random() - 0.5) * 0.1
            );
            particlePositions.set([position.x, position.y, position.z], i * 3);
            spawned++;
        }
    };

    const updateParticles = (delta) => {
        particles.forEach((particle, i) => {
            if (particle.life <= 0) return;

            particle.life -= delta / 0.6;
            particle.velocity.y -= 0.3 * delta;

            const offset = i * 3;
            particlePositions[offset] += particle.velocity.x * delta;
            particlePositions[offset + 1] += particle.velocity.y * delta;
            particlePositions[offset + 2] += particle.velocity.z * delta;

            if (particle.life <= 0) particlePositions[offset + 1] = -10;
        });

        particleGeometry.attributes.position.needsUpdate = true;
    };

    /**
     * HUD (index.html)
     */
    const hud = {
        start: document.querySelector('.start'),
        startPress: document.querySelector('.start-press'),
        startTrack: document.querySelector('.start-track'),
        songPicks: document.querySelectorAll('.song-pick'),
        songFile: document.querySelector('.song-file'),
        results: document.querySelector('.results'),
        resultsValues: document.querySelector('.results-values'),
        combo: document.querySelector('.combo'),
        comboValue: document.querySelector('.combo-value'),
        comboMax: document.querySelector('.combo-max'),
        judgements: document.querySelector('.judgements')
    };

    const projected = new THREE.Vector3();

    const toScreen = (x, y, z) => {
        projected.set(x, y, z).project(camera);
        return {
            x: ((projected.x + 1) / 2) * window.innerWidth,
            y: ((1 - projected.y) / 2) * window.innerHeight
        };
    };

    const restartAnimation = (element, className) => {
        element.classList.remove('punch', 'milestone', 'shatter');
        void element.offsetWidth; // forces a reflow so the same animation can replay
        element.classList.add(className);
    };

    hud.combo.addEventListener('animationend', () => {
        if (state.combo === 0) hud.combo.hidden = true;
    });

    const setCombo = (value) => {
        if (value > 0) {
            state.combo = value;
            state.maxCombo = Math.max(state.maxCombo, value);
            hud.combo.hidden = false;
            hud.comboValue.textContent = value;
            hud.comboMax.textContent = `MAX ${state.maxCombo}`;
            restartAnimation(hud.combo, value % 10 === 0 ? 'milestone' : 'punch');
        } else if (state.combo > 0) {
            state.combo = 0;
            restartAnimation(hud.combo, 'shatter');
        }
    };

    const showJudgement = (lane, key) => {
        const { text, jp } = JUDGEMENTS[key];
        const element = document.createElement('div');
        element.className = `judge ${key}`;
        element.textContent = text;
        element.dataset.jp = jp;

        // Above the ring (in pixels, so it stays aligned with the ring whatever the perspective)
        const { x, y } = toScreen(lanesX[lane], 0, hitZ);
        element.style.left = `${x}px`;
        element.style.top = `${y - 0.06 * window.innerHeight}px`;

        element.addEventListener('animationend', () => element.remove());
        hud.judgements.appendChild(element);
    };

    /**
     * Song timing: the beats found by the analysis define the 16th grid
     */
    const stepAt = (time) => {
        const { beats } = state.song.chart;
        const last = beats.length - 1;

        if (time <= beats[0]) return ((time - beats[0]) / (beats[1] - beats[0])) * 4;
        if (time >= beats[last]) return (last + (time - beats[last]) / (beats[last] - beats[last - 1])) * 4;

        let low = 0;
        let high = last;
        while (high - low > 1) {
            const middle = (low + high) >> 1;
            if (beats[middle] <= time) low = middle;
            else high = middle;
        }
        return (low + (time - beats[low]) / (beats[low + 1] - beats[low])) * 4;
    };

    // Song time as heard by the player (the audio output has a small delay)
    const songTime = () => getAudio().context.currentTime - state.playback.startTime - outputLatency();

    const spawnNotes = () => {
        while (state.pending.length && state.pending[0].step - state.stepPosition <= spawnSteps) {
            const { time, step, lane } = state.pending.shift();
            const note = getSphere();

            // Resting on the grid: the contact point is the intersection
            note.mesh.position.set(lanesX[lane], sphereSize / 2 + groundY, hitZ - (step - state.stepPosition) * rowLength);
            note.mesh.scale.setScalar(sphereSize);
            note.mesh.visible = true;
            note.material.uniforms.uColor.value.set(colors.spotlight);

            state.active.push({ ...note, time, step, lane, state: 'active', t: 0 });
        }
    };

    /**
     * Judgement
     */
    const hit = (note, judgement) => {
        const target = targets[note.lane];
        const now = getAudio().context.currentTime;

        note.state = judgement;
        note.t = 0;

        target.color.set(JUDGEMENTS[judgement].color);
        state.counts[judgement]++;
        sounds.hit(now);

        if (judgement === 'perfect') {
            target.glow = 1.2;
            spawnShockwave(note.lane, colors.sunTop, 0.5, 3.5);
            spawnShockwave(note.lane, '#ffffff', 0.3, 2);
            burst(target.mesh.position, 14);
            fx.flash = 1;
            sounds.shimmer(now);
        } else {
            target.glow = 0.7;
            spawnShockwave(note.lane, colors.spotlight, 0.45, 2.5);
        }

        showJudgement(note.lane, judgement);
        setCombo(state.combo + 1);
    };

    const miss = (note) => {
        const target = targets[note.lane];

        note.state = 'miss';
        note.t = 0;
        note.material.uniforms.uColor.value.set(JUDGEMENTS.miss.color);
        note.material.uniforms.uFlicker.value = 1;

        target.glow = 0.5;
        target.color.set(JUDGEMENTS.miss.color);
        fx.glitch = 1;
        state.counts.miss++;
        sounds.static(getAudio().context.currentTime);
        musicFx.muffle();

        showJudgement(note.lane, 'miss');
        setCombo(0);
    };

    const press = (lane) => {
        const time = songTime();
        const target = targets[lane];

        target.press = 1;
        keys[lane].press = 1;

        let best = null;
        let bestDelta = Infinity;

        for (const note of state.active) {
            if (note.lane !== lane || note.state !== 'active') continue;
            const delta = Math.abs(note.time - time);
            if (delta <= windows.good && delta < bestDelta) {
                best = note;
                bestDelta = delta;
            }
        }

        if (!best) {
            // Pressed on nothing: a dim pulse, no text
            target.glow = 0.25;
            target.color.set('#4d7a55');
            sounds.click(getAudio().context.currentTime);
            return;
        }

        hit(best, bestDelta <= windows.perfect ? 'perfect' : 'good');
    };

    /**
     * Loading: decode the song and build its chart (takes a moment, done once per song)
     * The default track is optional: without it, the start screen waits for a file.
     */
    let loading = 0;

    const setSong = async (load, title, failure) => {
        const current = ++loading; // a newer choice cancels the one still loading

        state.song = null;
        hud.start.classList.remove('ready', 'needs-song');
        hud.results.classList.add('hidden');
        hud.start.classList.remove('hidden');
        hud.startTrack.textContent = '';
        hud.startPress.textContent = 'Chargement du morceau…';

        try {
            const buffer = await load();
            if (current !== loading) return;

            hud.startPress.textContent = 'Analyse du morceau…';
            // Lets the text render before the analysis blocks the page for a moment
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (current !== loading) return;

            state.song = { buffer, chart: analyzeSong(buffer) };
            hud.startTrack.textContent = `♪ ${title}`;
            hud.startPress.textContent = 'Espace pour démarrer';
            hud.start.classList.add('ready');
        } catch {
            if (current !== loading) return;
            hud.startPress.textContent = failure;
            hud.start.classList.add('needs-song');
        }
    };

    if (song) setSong(() => loadSong(song.url), song.title, 'Choisissez un morceau pour jouer');
    else {
        hud.startPress.textContent = 'Choisissez un morceau pour jouer';
        hud.start.classList.add('needs-song');
    }

    for (const button of hud.songPicks) {
        button.addEventListener('click', (event) => {
            event.stopPropagation(); // the screens themselves start the game on click
            hud.songFile.click();
        });
    }

    hud.songFile.addEventListener('change', () => {
        const [file] = hud.songFile.files;
        hud.songFile.value = ''; // picking the same file again must fire a change
        if (!file || state.running) return;

        const title = file.name.replace(/\.[^.]+$/, '');
        setSong(() => loadSongFile(file), title, 'Fichier audio illisible');
    });

    /**
     * Start / end
     */
    const start = () => {
        if (state.running || !state.song) return;

        resumeAudio();
        musicFx.reset();

        state.playback = playSong(state.song.buffer);
        state.running = true;
        state.combo = 0;
        state.counts = { perfect: 0, good: 0, miss: 0 };

        // Notes that would already be on screen at the start are skipped (they would pop in)
        const firstStep = spawnSteps + stepAt(0);
        state.pending = state.song.chart.notes.filter((note) => note.step >= firstStep);

        hud.start.classList.add('hidden');
        hud.results.classList.add('hidden');
    };

    const finish = () => {
        state.running = false;
        state.playback.stop();

        for (const note of state.active) release(spherePool, note);
        state.active = [];
        state.pending = [];

        const { perfect, good, miss } = state.counts;
        const total = perfect + good + miss;
        const accuracy = total ? ((perfect + good * 0.5) / total) * 100 : 0;

        hud.resultsValues.innerHTML = `
            <dt>Perfect</dt><dd>${perfect}</dd>
            <dt>Good</dt><dd>${good}</dd>
            <dt>Miss</dt><dd>${miss}</dd>
            <dt>Combo max</dt><dd>${state.maxCombo}</dd>
            <dt>Précision</dt><dd>${accuracy.toFixed(1)} %</dd>
        `;
        hud.results.classList.remove('hidden');
        setCombo(0);
    };

    window.addEventListener('keydown', (event) => {
        if (event.repeat) return;

        if (event.key === ' ') {
            if (event.target.closest?.('.song-pick')) return; // Space activates the focused button
            event.preventDefault();
            start();
            return;
        }

        const lane = KEYS.indexOf(event.key.toLowerCase());
        if (lane !== -1 && state.running) press(lane);
    });

    hud.start.addEventListener('click', start);
    hud.results.addEventListener('click', start);

    /**
     * Frame update
     */
    const update = (delta) => {
        uTime.value += delta;

        fx.glitch *= Math.exp(-delta * 9);
        fx.flash *= Math.exp(-delta * 6);

        // Rings and key hints fade in with the game and out on the title / results screens
        state.presence += ((state.running ? 1 : 0) - state.presence) * (1 - Math.exp(-delta * 4));
        const visible = state.presence > 0.01;

        for (const target of targets) {
            target.mesh.visible = visible;
            target.material.uniforms.uOpacity.value = 0.55 * state.presence;

            target.glow *= Math.exp(-delta * 8);
            target.press *= Math.exp(-delta * 14);
            target.color.lerp(target.baseColor, 1 - Math.exp(-delta * 5));

            target.material.uniforms.uGlow.value = target.glow;
            target.material.uniforms.uColor.value.copy(target.color);
            target.mesh.scale.setScalar(ringSize * (1 - 0.18 * target.press));
        }

        for (let i = shockwaves.length - 1; i >= 0; i--) {
            const wave = shockwaves[i];
            wave.life += delta / wave.duration;

            if (wave.life >= 1) {
                shockwaves.splice(i, 1);
                release(shockwavePool, wave);
                continue;
            }

            wave.mesh.scale.setScalar(ringSize * (1 + wave.growth * wave.life));
            wave.material.uniforms.uOpacity.value = 1 - wave.life;
        }

        for (const key of keys) {
            key.mesh.visible = visible;
            key.material.opacity = 0.8 * state.presence;
            key.press *= Math.exp(-delta * 12);
            key.material.color.copy(key.baseColor).lerp(white, key.press);
            key.mesh.scale.set(keyWidth * (1 - 0.15 * key.press), keyDepth * (1 - 0.15 * key.press), 1);
        }

        updateParticles(delta);

        if (!state.running) return;

        const time = songTime();
        state.songTime = time;
        state.stepPosition = stepAt(time);

        // Kick pulse: decays over each beat
        const beatPhase = ((state.stepPosition / 4) % 1 + 1) % 1;
        fx.beat = Math.exp(-beatPhase * 6);

        spawnNotes();

        for (let i = state.active.length - 1; i >= 0; i--) {
            const note = state.active[i];
            const z = hitZ - (note.step - state.stepPosition) * rowLength;

            if (note.state === 'active') {
                note.mesh.position.z = z;
                if (time - note.time > windows.good) miss(note);
                continue;
            }

            note.t += delta;

            if (note.state === 'miss') {
                // Keeps sliding while it sinks through the grid and dissolves
                const k = note.t / 0.3;
                note.mesh.position.z = z;
                note.mesh.position.y = sphereSize / 2 + groundY - k * sphereSize * 1.3;
                note.material.uniforms.uOpacity.value = 1 - k;
                if (k >= 1) {
                    state.active.splice(i, 1);
                    release(spherePool, note);
                }
            } else {
                // Hit: bursts in place
                const k = note.t / 0.25;
                note.mesh.scale.setScalar(sphereSize * (1 + 0.8 * k));
                note.material.uniforms.uOpacity.value = 1 - k;
                note.material.uniforms.uGlow.value = (1 - k) * 0.6;
                if (k >= 1) {
                    state.active.splice(i, 1);
                    release(spherePool, note);
                }
            }
        }

        if (time > state.song.chart.duration + 0.5) finish();
    };

    return {
        start,
        update,
        press,
        fx,
        rowLength,
        get running() { return state.running; },
        get songTime() { return state.songTime; },
        get stepPosition() { return state.stepPosition; }
    };
};
