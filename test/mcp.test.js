// End to end over stdio: a real MCP client talks to `video-launcher mcp` about a review file on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

test('agents read, reply to and resolve feedback', async () => {
	const root = mkdtempSync(join(tmpdir(), 'vl-'));
	mkdirSync(join(root, 'renders', '.video-launcher'), { recursive: true });
	const file = join(root, 'renders', '.video-launcher', 'film.mp4.json');
	writeFileSync(file, JSON.stringify({
		version: 1, title: 'film.mp4', video: join(root, 'renders', 'film.mp4'), width: 1920, height: 1080, fps: 30, duration: 12,
		scenes: [{ id: 'intro', name: 'Intro', start: 0, file: 'scenes/intro.html' }, { id: 'demo', name: 'Demo', start: 5 }],
		notes: [
			{ id: 'a1', kind: 'point', t: 2.5, fx: 0.5, fy: 0.4, el: { path: '#intro > h1.title', text: 'Hello', box: { x: 700, y: 380, w: 520, h: 120 } }, text: 'Title is too small', status: 'open', thread: [], thumb: PIXEL },
			{ id: 'b2', kind: 'range', t: 6, t2: 8, text: 'Dead air here', status: 'open', thread: [] },
			{ id: 'c3', kind: 'time', t: 9, text: 'Already fine', status: 'resolved', thread: [] }
		]
	}));
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', root] }));
	try {
		const tools = (await client.listTools()).tools.map((t) => t.name).sort();
		assert.deepEqual(tools, ['acknowledge', 'add_note', 'dismiss', 'get_feedback', 'get_frame', 'list_reviews', 'reply', 'resolve', 'watch_feedback']);

		const list = await client.callTool({ name: 'list_reviews', arguments: {} });
		assert.match(list.content[0].text, /film\.mp4 — 2 open \/ 3 total/);

		const fb = await client.callTool({ name: 'get_feedback', arguments: {} });
		const md = fb.content[0].text;
		assert.match(md, /2\.50s \(frame 75\) · Intro/);
		assert.match(md, /Pointing at:\*\* `#intro > h1\.title` — “Hello”/);
		assert.match(md, /6\.00s → 8\.00s \(frames 180–240\) · Demo/);
		assert.doesNotMatch(md, /Already fine/);
		assert.equal(fb.content.filter((c) => c.type === 'image').length, 1);

		await client.callTool({ name: 'reply', arguments: { id: 'b2', message: 'Cut it or add a beat?' } });
		await client.callTool({ name: 'resolve', arguments: { id: 'a1', summary: 'Bumped the title to 96px' } });
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		assert.equal(saved.notes.find((n) => n.id === 'a1').status, 'resolved');
		assert.equal(saved.notes.find((n) => n.id === 'a1').thread[0].text, 'Bumped the title to 96px');
		assert.equal(saved.notes.find((n) => n.id === 'b2').thread[0].from, 'agent');

		const bad = await client.callTool({ name: 'resolve', arguments: { id: 'nope' } });
		assert.equal(bad.isError, true);
	} finally {
		await client.close();
	}
});

test('an agent started outside the project finds the reviews opened lately', async () => {
	const home = mkdtempSync(join(tmpdir(), 'vl-home-'));
	const project = mkdtempSync(join(tmpdir(), 'vl-proj-'));
	const elsewhere = mkdtempSync(join(tmpdir(), 'vl-else-'));
	mkdirSync(join(project, '.video-launcher'), { recursive: true });
	const file = join(project, '.video-launcher', 'promo.mp4.json');
	writeFileSync(file, JSON.stringify({ version: 1, title: 'promo.mp4', video: join(project, 'promo.mp4'), notes: [{ id: 'n1', kind: 'time', t: 1, text: 'Louder', status: 'open', thread: [] }] }));
	mkdirSync(join(home, '.video-launcher'), { recursive: true });
	writeFileSync(join(home, '.video-launcher', 'recent.json'), JSON.stringify([file, join(home, 'gone.json')]));
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--root', elsewhere], env: { ...process.env, HOME: home } }));
	try {
		const list = await client.callTool({ name: 'list_reviews', arguments: {} });
		assert.match(list.content[0].text, /promo\.mp4 — 1 open \/ 1 total/);
		const fb = await client.callTool({ name: 'get_feedback', arguments: {} });
		assert.match(fb.content[0].text, /Louder/);
	} finally {
		await client.close();
	}
});
