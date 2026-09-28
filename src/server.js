// The local review server: the UI, the video (with Range, so it seeks), the composition (same origin, so the UI can
// hit-test the exact frame on screen) with a small adapter injected, and a JSON API over the review file.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureReview, pretty, readReview, rememberReview, reviewPath, updateReview } from './store.js';
import { reviewMarkdown } from './format.js';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
	'.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
	'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
	'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac'
};
// fields the UI may write; status and the thread are changed through their own routes, so a stale tab can't undo an agent
const EDITABLE = ['kind', 't', 't2', 'fx', 'fy', 'el', 'ink', 'inkInfo', 'text', 'said', 'scene', 'thumb'];
// optional attachments: dropped when an edit leaves them out
const OPTIONAL = ['t2', 'fx', 'fy', 'el', 'ink', 'inkInfo'];

function send(res, code, body, type = 'application/json') {
	res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
	res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req) {
	return new Promise((ok, fail) => {
		let s = '';
		req.on('data', (c) => (s += c));
		req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
		req.on('error', fail);
	});
}
function stream(req, res, file) {
	const size = statSync(file).size;
	const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
	const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
	if (m) {
		const start = m[1] ? +m[1] : size - +m[2];
		const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
		if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
		res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'cache-control': 'no-store' });
		createReadStream(file, { start, end }).pipe(res);
	} else {
		res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'no-store' });
		createReadStream(file).pipe(res);
	}
}
// a path inside root, or null (no ../ escapes)
function inside(root, p) {
	const f = normalize(join(root, decodeURIComponent(p)));
	return f === root || f.startsWith(root + sep) ? f : null;
}

export function startServer(project, { port = 4180, host = '127.0.0.1' } = {}) {
	const file = reviewPath(project.video);
	const compDir = project.composition ? dirname(project.composition) : null;
	const compName = project.composition ? relative(compDir, project.composition) : null;
	ensureReview(file, { video: project.video, title: project.title, composition: project.composition, fps: project.fps || null, width: null, height: null });
	rememberReview(file);
	updateReview(file, (r) => {
		r.video = project.video;
		r.title = project.title;
		r.composition = project.composition;
		if (project.fps) r.fps = project.fps;
		if (project.scenes) r.scenes = project.scenes;
		r.lines = project.lines;
	});
	const vstamp = () => Math.round(statSync(project.video).mtimeMs);

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://x');
		const p = url.pathname;
		try {
			if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, readFileSync(join(UI, 'index.html')), MIME['.html']);
			if (req.method === 'GET' && p.startsWith('/ui/')) {
				const f = inside(UI, p.slice(4));
				return f && existsSync(f) ? send(res, 200, readFileSync(f), MIME[extname(f)] || 'text/plain') : send(res, 404, 'not found', 'text/plain');
			}
			if (req.method === 'GET' && p === '/video') return stream(req, res, project.video);
			if (req.method === 'GET' && p.startsWith('/comp/') && compDir) {
				const f = inside(compDir, p.slice(6));
				if (!f || !existsSync(f) || statSync(f).isDirectory()) return send(res, 404, 'not found', 'text/plain');
				if (f === project.composition) {
					// the adapter runs after the composition's own scripts: it seeks the timelines and drives clip visibility
					const html = readFileSync(f, 'utf8');
					const tag = '<script src="/ui/adapter.js"></script>';
					return send(res, 200, /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag, MIME['.html']);
				}
				return MIME[extname(f).toLowerCase()]?.startsWith('video/') || MIME[extname(f).toLowerCase()]?.startsWith('audio/') ? stream(req, res, f) : send(res, 200, readFileSync(f), MIME[extname(f).toLowerCase()] || 'application/octet-stream');
			}

			if (p === '/api/project' && req.method === 'GET') {
				const r = readReview(file);
				return send(res, 200, {
					title: project.title,
					video: '/video?v=' + vstamp(),
					composition: compName ? '/comp/' + compName.split(sep).map(encodeURIComponent).join('/') : null,
					fps: r.fps || null, scenes: r.scenes || null, lines: project.lines, words: project.words,
					reviewFile: pretty(file),
					videoFile: pretty(project.video),
					videoPath: project.video
				});
			}
			if (p === '/api/review' && req.method === 'GET') return send(res, 200, readReview(file));
			// what only the browser can measure: duration, frame size, and the scenes the composition declares
			if (p === '/api/review/meta' && req.method === 'POST') {
				const b = await body(req);
				updateReview(file, (r) => {
					for (const k of ['duration', 'width', 'height']) if (b[k]) r[k] = b[k];
					if (b.fps && !r.fps) r.fps = b.fps;
					if (b.scenes && b.scenes.length && !project.scenes) r.scenes = b.scenes;
				});
				return send(res, 200, { ok: true });
			}
			if (p === '/api/notes' && req.method === 'POST') {
				const b = await body(req);
				let saved;
				updateReview(file, (r) => {
					let n = r.notes.find((x) => x.id === b.id);
					if (!n) { n = { id: b.id || Date.now().toString(36), status: 'open', thread: [], created: new Date().toISOString() }; r.notes.push(n); }
					for (const k of EDITABLE) if (k in b) n[k] = b[k]; else if (OPTIONAL.includes(k)) delete n[k];
					r.notes.sort((a, c) => a.t - c.t);
					saved = n;
				});
				return send(res, 200, saved);
			}
			let m;
			if ((m = p.match(/^\/api\/notes\/([^/]+)$/)) && req.method === 'DELETE') {
				updateReview(file, (r) => { r.notes = r.notes.filter((n) => n.id !== m[1]); });
				return send(res, 200, { ok: true });
			}
			if ((m = p.match(/^\/api\/notes\/([^/]+)\/(reply|status)$/)) && req.method === 'POST') {
				const b = await body(req);
				updateReview(file, (r) => {
					const n = r.notes.find((x) => x.id === m[1]);
					if (!n) throw new Error('no such note');
					if (m[2] === 'reply') (n.thread ||= []).push({ from: 'reviewer', text: String(b.text || ''), at: new Date().toISOString() });
					else n.status = ['open', 'acknowledged', 'resolved', 'dismissed'].includes(b.status) ? b.status : 'open';
				});
				return send(res, 200, { ok: true });
			}
			if (p === '/api/notes' && req.method === 'DELETE') {
				updateReview(file, (r) => { r.notes = []; });
				return send(res, 200, { ok: true });
			}
			if (p === '/api/markdown' && req.method === 'GET') return send(res, 200, reviewMarkdown(readReview(file), { status: url.searchParams.get('status') || 'open' }), 'text/markdown; charset=utf-8');
			send(res, 404, { error: 'not found' });
		} catch (e) {
			send(res, 500, { error: String(e.message || e) });
		}
	});
	return new Promise((ok, fail) => {
		server.once('error', fail);
		server.listen(port, host, () => ok({ server, url: `http://${host}:${server.address().port}/`, file }));
	});
}
