// Works out what we are reviewing from one argument: a video file, or a project folder.
//   video    the file to play (a folder resolves to its newest render: ./renders, ./out, or the folder itself)
//   composition  a HyperFrames-style HTML file whose DOM can be seeked, for pointing at elements (auto-detected:
//                the nearest index.html with a data-composition-id, walking up from the video)
//   meta     optional sidecar JSON: <video>.review.json or video-launcher.json — { title, fps, scenes, transcript }
//   captions optional .srt/.vtt next to the video (same name), for "what is being said here"
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

const VIDEO = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv']);

function newestVideo(dir) {
	const found = [];
	for (const d of [join(dir, 'renders'), join(dir, 'out'), join(dir, 'output'), dir]) {
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d)) if (VIDEO.has(extname(f).toLowerCase())) found.push(join(d, f));
		if (found.length) break;
	}
	return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
}

function findComposition(from, levels = 3) {
	let d = from;
	for (let i = 0; i <= levels; i++) {
		const f = join(d, 'index.html');
		if (existsSync(f) && /data-composition-id/.test(readFileSync(f, 'utf8'))) return f;
		const up = dirname(d);
		if (up === d) break;
		d = up;
	}
	return null;
}

// SRT or WebVTT -> [{ start, end, text }]
export function parseCaptions(src) {
	const toS = (x) => {
		const m = x.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
		return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null;
	};
	const out = [];
	for (const block of src.replace(/\r/g, '').split(/\n\n+/)) {
		const lines = block.split('\n').filter(Boolean);
		const i = lines.findIndex((l) => l.includes('-->'));
		if (i < 0) continue;
		const [a, b] = lines[i].split('-->');
		const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
		const start = toS(a), end = toS(b.split(/\s/).filter(Boolean)[0]);
		if (start != null && end != null && text) out.push({ start, end, text });
	}
	return out;
}

export function loadProject(input, opts = {}) {
	let video = resolve(input || '.');
	if (!existsSync(video)) throw new Error(`Not found: ${video}`);
	if (statSync(video).isDirectory()) {
		const v = newestVideo(video);
		if (!v) throw new Error(`No video (${[...VIDEO].join(', ')}) in ${video}, ./renders or ./out`);
		video = v;
	}
	const dir = dirname(video);
	let composition = opts.composition === false ? null : opts.composition ? resolve(opts.composition) : findComposition(dir);
	if (composition && statSync(composition).isDirectory()) composition = join(composition, 'index.html');
	if (composition && !existsSync(composition)) throw new Error(`Composition not found: ${composition}`);

	const metaFile = [opts.meta && resolve(opts.meta), video + '.review.json', join(dir, 'video-launcher.json')].find((f) => f && existsSync(f));
	const meta = metaFile ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};

	const stem = video.slice(0, -extname(video).length);
	const capFile = [opts.captions && resolve(opts.captions), stem + '.vtt', stem + '.srt'].find((f) => f && existsSync(f));
	const lines = meta.transcript || (capFile ? parseCaptions(readFileSync(capFile, 'utf8')) : []);

	return {
		video,
		composition,
		metaFile: metaFile || null,
		captions: capFile || null,
		title: meta.title || basename(video),
		fps: opts.fps || meta.fps || null,
		scenes: meta.scenes || null,
		lines,
		words: meta.words || null
	};
}
