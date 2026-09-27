import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProject, parseCaptions } from '../src/project.js';

test('a HyperFrames project folder resolves to its newest render, composition and captions', () => {
	const root = mkdtempSync(join(tmpdir(), 'vl-'));
	mkdirSync(join(root, 'renders'));
	writeFileSync(join(root, 'index.html'), '<div id="root" data-composition-id="main" data-width="1920" data-height="1080"></div>');
	writeFileSync(join(root, 'renders', 'film.mp4'), '');
	writeFileSync(join(root, 'renders', 'film.srt'), '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond <i>line</i>\n');
	const p = loadProject(root);
	assert.equal(p.video, join(root, 'renders', 'film.mp4'));
	assert.equal(p.composition, join(root, 'index.html'));
	assert.deepEqual(p.lines, [{ start: 1, end: 2.5, text: 'Hello there' }, { start: 3, end: 4, text: 'Second line' }]);
	assert.equal(loadProject(join(root, 'renders', 'film.mp4'), { composition: false }).composition, null);
});

test('WebVTT with hours', () => {
	assert.deepEqual(parseCaptions('WEBVTT\n\n01:00:01.500 --> 01:00:02.000 align:start\nHi\n'), [{ start: 3601.5, end: 3602, text: 'Hi' }]);
});
