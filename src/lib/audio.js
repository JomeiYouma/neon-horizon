/**
 * Shared Web Audio graph.
 *
 *   song -> lowpass (miss effect) -> music gain -> master -> speakers
 *                                        \
 *                                         -> analyser input (music mode)
 *   microphone ---------------------------> analyser input (mic mode, never played back)
 *   game feedback sounds ----------------> master
 *
 * The context is created at load (suspended: browsers block audio until an
 * interaction) so the song can be decoded early, then resumed on the first key press.
 */
let context, master, musicFilter, musicGain, analyser, analyserInput, noise;
let microphone = null;
let source = 'music';

const MUSIC_VOLUME = 0.8;
const ANALYSER_MUSIC_GAIN = 0.35; // the song is mastered loud, the terrain would saturate

const setup = () => {
    if (context) return;

    context = new AudioContext();

    master = context.createGain();
    master.gain.value = 0.9;
    master.connect(context.destination);

    musicFilter = context.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = 20000;
    musicFilter.Q.value = 0.8;

    musicGain = context.createGain();
    musicGain.gain.value = MUSIC_VOLUME;
    musicFilter.connect(musicGain).connect(master);

    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    analyserInput = context.createGain();
    analyserInput.gain.value = ANALYSER_MUSIC_GAIN;
    analyserInput.connect(analyser);
    musicGain.connect(analyserInput);

    // One second of white noise, reused by the feedback sounds
    noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
};

export const getAudio = () => {
    setup();
    return { context, analyser, master };
};

/** To call from a user interaction (key press, click) */
export const resumeAudio = () => {
    setup();
    if (context.state === 'suspended') context.resume();
};

/** Delay between scheduling a sound and hearing it */
export const outputLatency = () => context.outputLatency || context.baseLatency || 0;

/**
 * Song
 */
export const loadSong = async (url) => {
    setup();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Song not found: ${url}`);
    return context.decodeAudioData(await response.arrayBuffer());
};

/** Song picked by the player (File from an <input type="file">) */
export const loadSongFile = async (file) => {
    setup();
    return context.decodeAudioData(await file.arrayBuffer());
};

/** @returns {{ startTime: number, stop: function }} startTime on the audio clock */
export const playSong = (buffer, delay = 0.15) => {
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(musicFilter);

    const startTime = context.currentTime + delay;
    node.start(startTime);

    return {
        startTime,
        stop: () => {
            try { node.stop(); } catch { /* already stopped */ }
        }
    };
};

/**
 * What the terrain and the wave react to: 'music' or 'mic'
 * Throws if the microphone is refused
 */
export const setAnalyserSource = async (next) => {
    setup();

    if (next === 'mic' && !microphone) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        microphone = context.createMediaStreamSource(stream);
    }

    if (next === source) return;

    if (next === 'mic') {
        musicGain.disconnect(analyserInput);
        microphone.connect(analyserInput);
        analyserInput.gain.value = 1;
    } else {
        microphone?.disconnect(analyserInput);
        musicGain.connect(analyserInput);
        analyserInput.gain.value = ANALYSER_MUSIC_GAIN;
    }

    source = next;
};

/**
 * Effects on the song
 */
export const musicFx = {
    // Miss: the song goes muffled, like underwater, then comes back
    muffle() {
        const now = context.currentTime;
        const cutoff = musicFilter.frequency;
        cutoff.cancelScheduledValues(now);
        cutoff.setValueAtTime(cutoff.value, now);
        cutoff.exponentialRampToValueAtTime(450, now + 0.04);
        cutoff.exponentialRampToValueAtTime(20000, now + 0.7);
    },

    reset() {
        const now = context.currentTime;
        musicGain.gain.cancelScheduledValues(now);
        musicGain.gain.setValueAtTime(MUSIC_VOLUME, now);
        musicFilter.frequency.cancelScheduledValues(now);
        musicFilter.frequency.setValueAtTime(20000, now);
    }
};

/**
 * Building blocks
 */
const envelope = (time, peak, decay, attack = 0.002) => {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(peak, time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    gain.connect(master);
    return gain;
};

const oscillator = (type, frequency, time, duration) => {
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, time);
    osc.start(time);
    osc.stop(time + duration);
    return osc;
};

const noiseSource = (time, duration) => {
    const node = context.createBufferSource();
    node.buffer = noise;
    node.start(time);
    node.stop(time + duration);
    return node;
};

const filter = (type, frequency, q = 1) => {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
};

/**
 * Feedback sounds: short and unpitched, so they never clash with the song's key
 */
export const sounds = {
    // Hit: a short snap
    hit(time) {
        noiseSource(time, 0.08)
            .connect(filter('bandpass', 3200, 1.2))
            .connect(envelope(time, 0.3, 0.05));

        const tick = oscillator('sine', 1800, time, 0.05);
        tick.frequency.exponentialRampToValueAtTime(900, time + 0.03);
        tick.connect(envelope(time, 0.1, 0.03));
    },

    // Perfect: an airy shimmer on top of the snap
    shimmer(time) {
        noiseSource(time, 0.4)
            .connect(filter('highpass', 8000))
            .connect(envelope(time, 0.1, 0.3, 0.01));
    },

    // Miss: a burst of static
    static(time) {
        noiseSource(time, 0.15)
            .connect(filter('bandpass', 2500, 0.5))
            .connect(envelope(time, 0.18, 0.12));
    },

    // Key pressed on nothing: a tiny click
    click(time) {
        noiseSource(time, 0.03)
            .connect(filter('highpass', 9000))
            .connect(envelope(time, 0.05, 0.015));
    }
};
