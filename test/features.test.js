// What a pointed element tells the agent (source line, current styles); the agent loop over MCP: acknowledge, watch,
// and critique with add_note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { noteMarkdown, reviewMarkdown } from '../src/format.js';

process.env.HOME = mkdtempSync(join(tmpdir(), 'vl-home-')); // keep ~/.telestrator out of the real home
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const pointed = {
	id: 'p1', kind: 'point', t: 2, fx: 0.5, fy: 0.25, text: 'Title too small', status: 'acknowledged',
	el: { path: '#intro > h1.title', text: 'Hello', tag: 'h1', classes: 'title big', box: { x: 700, y: 200, w: 520, h: 120 }, source: { file: 'index.html', line: 42 }, styles: { 'font-family': 'Inter', 'font-size': '48px', 'font-weight': '700', color: '#ffffff', 'letter-spacing': '-0.02em' } }
};
const review = (notes) => ({ title: 'film.mp4', video: '/p/renders/film.mp4', composition: '/p/index.html', width: 1920, height: 1080, fps: 30, notes });

test('a pointed element comes with its source line and current styles', () => {
	const r = review([pointed]);
	const md = noteMarkdown(r, pointed, 0);
	assert.match(md, /\*\*Source:\*\* \/p\/index\.html:42/);
	assert.match(md, /\*\*Styles now:\*\* font-size 48px; font-weight 700; color #ffffff$/m);
	assert.doesNotMatch(md, /letter-spacing/);
	assert.match(md, /— acknowledged/);
	// open includes acknowledged; pending doesn't
	assert.match(reviewMarkdown(r, { status: 'open' }), /Title too small/);
	assert.match(reviewMarkdown(r, { status: 'pending' }), /No notes/);
});

async function mcp(root) {
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', root], env: { ...process.env } }));
	return client;
}
function project(notes) {
	const root = mkdtempSync(join(tmpdir(), 'vl-'));
	mkdirSync(join(root, '.telestrator'));
	const video = join(root, 'film.mp4');
	if (hasFfmpeg) execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-pix_fmt', 'yuv420p', video]);
	else writeFileSync(video, '');
	const file = join(root, '.telestrator', 'film.mp4.json');
	writeFileSync(file, JSON.stringify({ version: 1, title: 'film.mp4', video, width: 320, height: 180, fps: 30, notes }));
	return { root, file, video };
}
const addNote = (file, n) => { const r = JSON.parse(readFileSync(file, 'utf8')); r.notes.push(n); writeFileSync(file, JSON.stringify(r)); };

test('the agent acknowledges a note: still open, no longer pending', async () => {
	const { root, file } = project([{ id: 'a', kind: 'time', t: 1, text: 'Cut this', status: 'open' }]);
	const c = await mcp(root);
	try {
		await c.callTool({ name: 'acknowledge', arguments: { id: 'a' } });
		assert.equal(JSON.parse(readFileSync(file, 'utf8')).notes[0].status, 'acknowledged');
		assert.match((await c.callTool({ name: 'get_feedback', arguments: {} })).content[0].text, /Cut this/);
		assert.doesNotMatch((await c.callTool({ name: 'get_feedback', arguments: { status: 'pending' } })).content[0].text, /Cut this/);
	} finally { await c.close(); }
});

test('watch_feedback waits for the reviewer, skips the agent\'s own notes, and times out', async () => {
	const { root, file } = project([{ id: 'mine', kind: 'time', t: 1, text: 'From the agent', status: 'open', by: 'agent' }]);
	const c = await mcp(root);
	try {
		const quiet = await c.callTool({ name: 'watch_feedback', arguments: { timeoutSeconds: 1 } });
		assert.match(quiet.content[0].text, /No new notes in 1s/);
		setTimeout(() => addNote(file, { id: 'new', kind: 'time', t: 2, text: 'Louder music', status: 'open' }), 600);
		const t0 = Date.now();
		const got = await c.callTool({ name: 'watch_feedback', arguments: { timeoutSeconds: 10, batchWindowSeconds: 0 } });
		assert.ok(Date.now() - t0 >= 500, 'it waited');
		assert.match(got.content[0].text, /Louder music/);
		assert.doesNotMatch(got.content[0].text, /From the agent/);
		// already waiting: returns at once
		const t1 = Date.now();
		await c.callTool({ name: 'watch_feedback', arguments: { timeoutSeconds: 10, batchWindowSeconds: 5 } });
		assert.ok(Date.now() - t1 < 2000, 'no batch wait when notes were already there');
	} finally { await c.close(); }
});

test('add_note leaves the agent\'s own note, with its frame', async () => {
	const { root, file } = project([]);
	const c = await mcp(root);
	try {
		const r = await c.callTool({ name: 'add_note', arguments: { t: 1.5, text: 'Subtitle overlaps the logo', x: 0.8, y: 0.9 } });
		assert.match(r.content[0].text, /left by the agent/);
		const n = JSON.parse(readFileSync(file, 'utf8')).notes[0];
		assert.equal(n.by, 'agent');
		assert.equal(n.kind, 'point');
		if (hasFfmpeg) assert.match(n.thumb, /^data:image\/jpeg;base64,/);
	} finally { await c.close(); }
});
