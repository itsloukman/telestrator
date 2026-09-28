// One review per video, stored next to it: <video dir>/.video-launcher/<video file name>.json
// The browser UI writes notes through the local server; the MCP server reads and updates the same file,
// so an agent can pick feedback up (and resolve it) without the UI running.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { dirname, basename, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DIR = '.video-launcher';

export function reviewPath(video) {
	return join(dirname(video), DIR, basename(video) + '.json');
}

export function readReview(file) {
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

// write to a temp file and rename, so a reader never sees half a file
export function writeReview(file, review) {
	mkdirSync(dirname(file), { recursive: true });
	review.updated = new Date().toISOString();
	const tmp = file + '.' + process.pid + '.tmp';
	writeFileSync(tmp, JSON.stringify(review, null, '\t'));
	renameSync(tmp, file);
	return review;
}

// read-modify-write in one step; fn gets the review and may mutate it or return a new one
export function updateReview(file, fn) {
	const r = readReview(file);
	if (!r) throw new Error('No review at ' + file);
	const out = fn(r) || r;
	return writeReview(file, out);
}

export function ensureReview(file, init) {
	const r = readReview(file);
	if (r) return r;
	return writeReview(file, { version: 1, notes: [], ...init });
}

// every review under a folder (the MCP server's project root); skips dependency and VCS folders
export function findReviews(root, depth = 6) {
	const out = [];
	const walk = (dir, d) => {
		if (d > depth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name === 'node_modules' || e.name === '.git') continue;
			const p = join(dir, e.name);
			if (e.isDirectory() && e.name === DIR) {
				for (const f of readdirSync(p)) if (f.endsWith('.json')) out.push(join(p, f));
			} else if (e.isDirectory() && !e.name.startsWith('.')) walk(p, d + 1);
		}
	};
	walk(resolve(root), 0);
	return out
		.map((file) => ({ file, review: readReview(file), mtime: statSync(file).mtimeMs }))
		.filter((x) => x.review)
		.sort((a, b) => b.mtime - a.mtime);
}

// reviews opened lately, across projects (~/.video-launcher/recent.json): lets an agent that wasn't started in the
// project folder (IDEs, desktop apps, a global MCP config) still find them
const recentFile = () => join(homedir(), DIR, 'recent.json');
const readRecent = () => {
	try {
		return JSON.parse(readFileSync(recentFile(), 'utf8'));
	} catch {
		return [];
	}
};

export function rememberReview(file) {
	try {
		mkdirSync(dirname(recentFile()), { recursive: true });
		writeFileSync(recentFile(), JSON.stringify([file, ...readRecent().filter((f) => f !== file)].slice(0, 20), null, '\t'));
	} catch {}
}

export function recentReviews() {
	return readRecent()
		.map((file) => ({ file, review: readReview(file) }))
		.filter((x) => x.review)
		.map((x) => ({ ...x, mtime: statSync(x.file).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
}

export const rel = (root, p) => relative(root, p) || '.';
// for people: relative when it's under the cwd, else ~/… or absolute
export function pretty(p) {
	const r = relative(process.cwd(), p);
	if (r && !r.startsWith('..')) return r;
	const home = process.env.HOME || process.env.USERPROFILE;
	return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
