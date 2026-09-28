// `telestrator init` with a stand-in npx: it says what it runs before running it, and runs the pinned add-mcp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

test('init runs the pinned add-mcp, says so first, and --yes also adds the skill', { skip: process.platform === 'win32' }, () => {
	const home = mkdtempSync(join(tmpdir(), 'vl-home-')), bin = join(home, 'bin'), args = join(home, 'npx-args');
	mkdirSync(bin);
	mkdirSync(join(home, '.claude'));
	// records what it was asked to run, one argument per line
	writeFileSync(join(bin, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\n`);
	chmodSync(join(bin, 'npx'), 0o755);
	const r = spawnSync(process.execPath, [cli, 'init', '--yes'], { env: { ...process.env, HOME: home, PATH: bin + delimiter + process.env.PATH }, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(readFileSync(args, 'utf8').trim().split('\n'), ['-y', 'add-mcp@2.4.0', 'npx -y telestrator mcp', '--name', 'telestrator', '-g', '-y']);
	assert.match(r.stdout, /with add-mcp@2\.4\.0/);
	assert.match(r.stdout, /every one it finds, without asking \(--yes\)/);
	assert.ok(existsSync(join(home, '.claude', 'skills', 'telestrator', 'SKILL.md')));
});
