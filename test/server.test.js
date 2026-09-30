// The review server's API as the UI uses it: the video's version for noticing a re-render, and note edits that keep
// the thread safe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'vl-home-')); // keep ~/.telestrator out of the real home
const { loadProject } = await import('../src/project.js');
const { startServer } = await import('../src/server.js');

async function serve() {
	const root = mkdtempSync(join(tmpdir(), 'vl-srv-'));
	mkdirSync(join(root, 'renders'));
	const video = join(root, 'renders', 'film.mp4');
	writeFileSync(video, 'not really a video');
	const { server, url } = await startServer(loadProject(video), { port: 0 });
	const get = (p) => fetch(url + p.slice(1)).then((r) => r.json());
	const post = (p, b) => fetch(url + p.slice(1), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
	return { root, video, server, get, post };
}

test('the review carries the video version, which changes on a re-render and is empty while the file is missing', async () => {
	const s = await serve();
	try {
		const a = await s.get('/api/review');
		assert.ok(Array.isArray(a.notes));
		assert.equal(typeof a.videoStamp, 'number');
		const later = new Date(Date.now() + 60_000);
		utimesSync(s.video, later, later);
		assert.notEqual((await s.get('/api/review')).videoStamp, a.videoStamp);
		renameSync(s.video, s.video + '.tmp');
		const mid = await s.get('/api/review');
		assert.equal(mid.videoStamp, null);
		assert.ok(Array.isArray(mid.notes));
		renameSync(s.video + '.tmp', s.video);
	} finally {
		s.server.close();
	}
});

test('editing a note keeps its thread and status, and saves when its frame was taken', async () => {
	const s = await serve();
	try {
		const n = await s.post('/api/notes', { id: 'n1', kind: 'range', t: 1, t2: 3, text: 'Too long', thumbAt: '2026-01-01T00:00:00.000Z' });
		await s.post('/api/notes/n1/reply', { text: 'Which part?' });
		await s.post('/api/notes/n1/status', { status: 'acknowledged' });
		const edited = await s.post('/api/notes', { ...n, t: 1.5, t2: 2.5, thumbAt: '2026-02-01T00:00:00.000Z', status: 'open', thread: [] });
		assert.equal(edited.t, 1.5);
		assert.equal(edited.t2, 2.5);
		assert.equal(edited.thumbAt, '2026-02-01T00:00:00.000Z');
		assert.equal(edited.status, 'acknowledged');
		assert.equal(edited.thread.length, 1);
	} finally {
		s.server.close();
	}
});
