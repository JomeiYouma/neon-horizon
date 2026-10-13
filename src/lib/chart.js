/**
 * Chart generator: turns a song into rhythm game notes.
 *
 * 1. Spectral flux (where new sound energy appears) on short frames
 * 2. Beat tracking (follows tempo changes), subdivided into a 16th note grid
 * 3. Notes on the strongest onsets of each 2 bar window; how many depends on the
 *    intensity of the passage (quiet parts get few notes, drops get many)
 * 4. Lane from the "height" of the onset: low sounds (kick, bass) on the left,
 *    high sounds (vocals, hats, riffs) on the right. Melodic runs become lane runs.
 *
 * Runs in the browser (AudioBuffer) and in Node (any object with the same shape).
 */

const TARGET_RATE = 24000; // analysis sample rate (enough up to 12 kHz)
const FFT_SIZE = 512;      // ~21 ms window
const HOP = 256;           // ~10.7 ms between frames

/**
 * Tunable options
 * minGap: minimum distance between two notes, in 16th steps (2 = 8th notes max)
 * minNotes / maxNotes: notes per 2 bars in the quietest / most intense passages
 */
const DEFAULTS = {
    minGap: 2,
    minNotes: 2,
    maxNotes: 9,
    minBpm: 80,
    maxBpm: 170,
    lanes: 4
};

/**
 * Downmix to mono and decimate to ~24 kHz (simple averaging, a lowpass is not needed for onsets)
 */
const toMono = (buffer) => {
    const factor = Math.max(1, Math.floor(buffer.sampleRate / TARGET_RATE));
    const length = Math.floor(buffer.length / factor);
    const mono = new Float32Array(length);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const scale = 1 / (factor * channels.length);

    for (const data of channels) {
        for (let i = 0; i < length; i++) {
            let sum = 0;
            const start = i * factor;
            for (let j = 0; j < factor; j++) sum += data[start + j];
            mono[i] += sum * scale;
        }
    }

    return { samples: mono, sampleRate: buffer.sampleRate / factor };
};

/**
 * In-place radix-2 FFT (real input in re, zeros in im)
 */
const createFFT = (size) => {
    const levels = Math.log2(size);
    const reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
        let r = 0;
        for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
        reverse[i] = r;
    }

    const cos = new Float64Array(size / 2);
    const sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / size);
        sin[i] = Math.sin((2 * Math.PI * i) / size);
    }

    return (re, im) => {
        for (let i = 0; i < size; i++) {
            const j = reverse[i];
            if (j > i) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }

        for (let half = 1; half < size; half *= 2) {
            const tableStep = size / (half * 2);
            for (let start = 0; start < size; start += half * 2) {
                for (let k = 0; k < half; k++) {
                    const c = cos[k * tableStep];
                    const s = sin[k * tableStep];
                    const a = start + k;
                    const b = a + half;
                    const tRe = re[b] * c + im[b] * s;
                    const tIm = im[b] * c - re[b] * s;
                    re[b] = re[a] - tRe;
                    im[b] = im[a] - tIm;
                    re[a] += tRe;
                    im[a] += tIm;
                }
            }
        }
    };
};

/**
 * Per frame: total spectral flux + centroid of the flux (in log frequency)
 */
const analyzeFrames = ({ samples, sampleRate }) => {
    const frames = Math.floor((samples.length - FFT_SIZE) / HOP);
    const bins = FFT_SIZE / 2;
    const fft = createFFT(FFT_SIZE);
    const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));

    const binHz = sampleRate / FFT_SIZE;
    const minBin = Math.ceil(30 / binHz);
    const maxBin = Math.min(bins - 1, Math.floor(11000 / binHz));
    const logFrequency = Float64Array.from({ length: bins }, (_, i) => Math.log2(Math.max(i, 1) * binHz));

    const flux = new Float32Array(frames);
    const centroid = new Float32Array(frames);
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    let previous = new Float64Array(bins);
    let current = new Float64Array(bins);

    for (let f = 0; f < frames; f++) {
        const offset = f * HOP;
        for (let i = 0; i < FFT_SIZE; i++) {
            re[i] = samples[offset + i] * window[i];
            im[i] = 0;
        }
        fft(re, im);

        let total = 0;
        let weighted = 0;
        for (let b = minBin; b <= maxBin; b++) {
            current[b] = Math.log1p(1000 * Math.hypot(re[b], im[b]));
            const rise = current[b] - previous[b];
            if (rise > 0) {
                total += rise;
                weighted += rise * logFrequency[b];
            }
        }

        flux[f] = total;
        centroid[f] = total > 0 ? weighted / total : 0;
        [previous, current] = [current, previous];
    }

    return { flux, centroid, frameRate: sampleRate / HOP };
};

/**
 * Moving average over +-radius frames (prefix sums)
 */
const movingAverage = (values, radius) => {
    const prefix = new Float64Array(values.length + 1);
    for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];

    return Float32Array.from(values, (_, i) => {
        const start = Math.max(0, i - radius);
        const end = Math.min(values.length, i + radius + 1);
        return (prefix[end] - prefix[start]) / (end - start);
    });
};

/** Linear interpolation of a frame curve at a time in seconds */
const sampleAt = (values, frameRate, time) => {
    const position = time * frameRate;
    const i = Math.floor(position);
    if (i < 0 || i >= values.length - 1) return 0;
    const t = position - i;
    return values[i] * (1 - t) + values[i + 1] * t;
};

/**
 * Tempo guess: autocorrelation of the onset curve, weighted towards ~120 BPM
 * (avoids picking half or double tempo)
 */
const estimateTempo = (onset, frameRate, { minBpm, maxBpm }) => {
    const mean = onset.reduce((a, b) => a + b, 0) / onset.length;
    const centered = Float32Array.from(onset, (v) => v - mean);

    let bestLag = 0;
    let bestScore = -Infinity;
    const minLag = Math.floor((60 / maxBpm) * frameRate);
    const maxLag = Math.ceil((60 / minBpm) * frameRate);

    for (let lag = minLag; lag <= maxLag; lag++) {
        let sum = 0;
        for (let i = 0; i + lag < centered.length; i++) sum += centered[i] * centered[i + lag];
        const bpm = (60 * frameRate) / lag;
        const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.5) ** 2);
        const score = (sum / (centered.length - lag)) * prior;
        if (score > bestScore) {
            bestScore = score;
            bestLag = lag;
        }
    }

    return (60 * frameRate) / bestLag;
};

/**
 * Beat tracking by dynamic programming (Ellis, 2007): the best chain of beats that sits
 * on strong onsets while keeping intervals close to the tempo guess.
 * Follows tempo changes, and keeps a steady pulse through quiet parts.
 * @returns {Float64Array} beat times in seconds, smoothed
 */
const trackBeats = (onset, frameRate, bpm) => {
    const period = (60 / bpm) * frameRate; // in frames
    const tightness = 400;
    const frames = onset.length;

    // Normalized onset (so the tightness does not depend on the song's level)
    let deviation = 0;
    for (const v of onset) deviation += v * v;
    deviation = Math.sqrt(deviation / frames) || 1;

    const score = new Float64Array(frames);
    const previous = new Int32Array(frames).fill(-1);
    const minBack = Math.round(period * 0.8);
    const maxBack = Math.round(period * 1.25);

    for (let t = 0; t < frames; t++) {
        let best = 0;
        let bestFrom = -1;
        for (let back = minBack; back <= maxBack && t - back >= 0; back++) {
            const penalty = -tightness * Math.log(back / period) ** 2;
            const candidate = score[t - back] + penalty;
            if (bestFrom === -1 || candidate > best) {
                best = candidate;
                bestFrom = t - back;
            }
        }
        score[t] = onset[t] / deviation + (bestFrom === -1 ? 0 : best);
        previous[t] = bestFrom;
    }

    // Backtrack from the best score in the last beat period
    let end = frames - 1;
    for (let t = frames - Math.round(period); t < frames; t++) if (score[t] > score[end]) end = t;

    const beats = [];
    for (let t = end; t !== -1; t = previous[t]) beats.push(t / frameRate);
    beats.reverse();

    // Smoothing: each beat on a line fitted through its neighbours (removes the frame jitter)
    const radius = 6;
    return Float64Array.from(beats, (_, i) => {
        const from = Math.max(0, i - radius);
        const to = Math.min(beats.length - 1, i + radius);
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        const n = to - from + 1;
        for (let j = from; j <= to; j++) {
            sumX += j;
            sumY += beats[j];
            sumXY += j * beats[j];
            sumXX += j * j;
        }
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        return (sumY - slope * sumX) / n + slope * i;
    });
};

/**
 * @param {AudioBuffer} buffer - decoded song
 * @param {object} [options] - see DEFAULTS
 * @returns {{ bpm: number, beats: Float64Array, duration: number, notes: { time: number, step: number, lane: number }[] }}
 *   beats: beat times (a 16th step is a quarter of a beat), notes on 16th steps
 */
export const analyzeSong = (buffer, options = {}) => {
    const settings = { ...DEFAULTS, ...options };
    const mono = toMono(buffer);
    const { flux, centroid, frameRate } = analyzeFrames(mono);
    const duration = buffer.length / buffer.sampleRate;

    // Onset curve: flux above its short-term average (removes sustained noise)
    const shortAverage = movingAverage(flux, Math.round(0.1 * frameRate));
    const onset = Float32Array.from(flux, (v, i) => Math.max(0, v - shortAverage[i]));

    const bpm = estimateTempo(onset, frameRate, settings);
    const beats = trackBeats(onset, frameRate, bpm);

    // Local reference: average onset over ~4 s, and the song's overall level
    const localAverage = movingAverage(onset, Math.round(4 * frameRate));
    const sorted = Float32Array.from(onset).sort();
    const floor = sorted[Math.floor(sorted.length * 0.6)];

    /**
     * Grid candidates: onset strength around each 16th (+-30 ms), with its centroid
     */
    const search = Math.round(0.03 * frameRate);
    const candidates = [];

    for (let k = 0; k < (beats.length - 1) * 4; k++) {
        const beat = Math.floor(k / 4);
        const time = beats[beat] + ((beats[beat + 1] - beats[beat]) * (k % 4)) / 4;
        const center = Math.round(time * frameRate);
        let peak = 0;
        let peakFrame = center;
        for (let f = center - search; f <= center + search; f++) {
            if (f >= 0 && f < onset.length && onset[f] > peak) {
                peak = onset[f];
                peakFrame = f;
            }
        }

        if (peak <= floor) continue;

        // Strong beats matter more than 16ths
        const metric = k % 4 === 0 ? 1 : k % 2 === 0 ? 0.85 : 0.6;
        const strength = (peak / (localAverage[peakFrame] + 1e-6)) * metric;

        // Below the local average: not an event
        if (strength < 1) continue;

        candidates.push({ k, time, strength, level: localAverage[peakFrame], pitch: centroid[peakFrame] });
    }

    /**
     * Per 2 bar window: the strongest candidates, at least minGap steps apart.
     * The number of notes follows the intensity of the passage.
     */
    const levels = Float32Array.from(localAverage).sort();
    const loud = levels[Math.floor(levels.length * 0.9)] || 1;

    const taken = new Set();
    const kept = [];
    const windowSteps = 32;

    for (let from = 0; from < (beats.length - 1) * 4; from += windowSteps) {
        const inWindow = candidates.filter((c) => c.k >= from && c.k < from + windowSteps);
        if (!inWindow.length) continue;

        const level = inWindow.reduce((sum, c) => sum + c.level, 0) / inWindow.length;
        const intensity = Math.min(1, level / loud);
        const budget = Math.round(settings.minNotes + (settings.maxNotes - settings.minNotes) * intensity ** 1.5);

        let count = 0;
        for (const candidate of inWindow.sort((a, b) => b.strength - a.strength)) {
            if (count >= budget) break;

            let free = true;
            for (let d = -settings.minGap + 1; d < settings.minGap && free; d++) {
                if (taken.has(candidate.k + d)) free = false;
            }
            if (!free) continue;

            taken.add(candidate.k);
            kept.push(candidate);
            count++;
        }
    }

    kept.sort((a, b) => a.k - b.k);

    /**
     * Lanes: onset "height" compared to the notes around it (+-8 bars),
     * so every section uses the four lanes and melodic contours are preserved
     */
    const window = 8 * 16;
    const notes = [];
    let previousLane = -1;
    let repeats = 0;

    kept.forEach((note, index) => {
        const neighbours = [];
        for (let j = index - 1; j >= 0 && note.k - kept[j].k <= window; j--) neighbours.push(kept[j].pitch);
        for (let j = index + 1; j < kept.length && kept[j].k - note.k <= window; j++) neighbours.push(kept[j].pitch);

        const below = neighbours.filter((p) => p < note.pitch).length;
        const rank = neighbours.length ? below / neighbours.length : 0.5;
        let lane = Math.min(settings.lanes - 1, Math.floor(rank * settings.lanes));

        // No more than 3 times the same lane in a row: move to the closest one
        repeats = lane === previousLane ? repeats + 1 : 0;
        if (repeats >= 3) {
            lane = lane === 0 ? 1 : lane === settings.lanes - 1 ? lane - 1 : lane + (rank > 0.5 ? -1 : 1);
            repeats = 0;
        }
        previousLane = lane;

        notes.push({ time: note.time, step: note.k, lane, strength: note.strength });
    });

    /**
     * Chords: the strongest beats (top 4 %) get a second note on the other hand
     */
    const chordLimit = [...kept].sort((a, b) => b.strength - a.strength)[Math.floor(kept.length * 0.04)]?.strength ?? Infinity;

    for (let i = notes.length - 1; i >= 0; i--) {
        const note = notes[i];
        if (note.strength < chordLimit || kept[i].k % 4 !== 0) continue;
        const otherHand = note.lane < 2 ? 3 - note.lane : 3 - note.lane;
        notes.splice(i + 1, 0, { ...note, lane: otherHand });
    }

    return {
        bpm: 60 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)),
        beats,
        duration,
        notes: notes.map(({ time, step, lane }) => ({ time, step, lane }))
    };
};
