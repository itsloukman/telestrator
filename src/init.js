// `npx video-launcher init`: connect your agents (add-mcp finds the ones you have and asks which), then add the
// Claude Code skill. `--yes` does both without asking.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'video-launcher');

export async function init({ yes = false } = {}) {
	console.log('\n  Connecting video-launcher to your agents. add-mcp finds the ones you have and asks which to add it to.\n');
	const r = spawnSync('npx', ['-y', 'add-mcp', 'npx -y video-launcher mcp', '--name', 'video-launcher', '-g', ...(yes ? ['-y'] : [])], { stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.status !== 0) console.log('\n  add-mcp didn\'t finish. Add it by hand instead: "Connect agent" in the review, or the README.');

	const claude = join(homedir(), '.claude');
	if (existsSync(claude)) {
		let go = yes;
		if (!yes && process.stdin.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			go = !/^n/i.test(await rl.question('\n  Add the Claude Code skill (/video-launcher) too? [Y/n] '));
			rl.close();
		}
		if (go) {
			const dest = join(claude, 'skills', 'video-launcher');
			cpSync(SKILL, dest, { recursive: true });
			console.log(`  ✓ Skill added: ${dest}`);
		}
	}
	console.log('\n  Start a new agent session, then ask it to "check the video feedback".\n  Check your setup any time: npx video-launcher doctor\n');
}
