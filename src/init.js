// `npx telestrator init`: connect your agents (add-mcp finds the ones you have and asks which), then add the
// Claude Code skill. `--yes` does both without asking.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'telestrator');
// Neon's MCP installer, which knows where each agent keeps its MCP settings. Pinned, so a new release of it can't
// change what runs on your machine
const ADD_MCP = 'add-mcp@2.4.0';

export async function init({ yes = false } = {}) {
	// what runs, and what it writes, said before it runs
	console.log(`\n  Connecting telestrator to your agents with ${ADD_MCP} (Neon's MCP installer, run with npx).`);
	console.log('  It finds the agents you have and adds a "telestrator" server (npx -y telestrator mcp) to the MCP settings of');
	console.log(yes ? '  every one it finds, without asking (--yes). If it finds none, to every agent it supports.\n' : '  each one you pick.\n');
	const r = spawnSync('npx', ['-y', ADD_MCP, 'npx -y telestrator mcp', '--name', 'telestrator', '-g', ...(yes ? ['-y'] : [])], { stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.status !== 0) console.log('\n  add-mcp didn\'t finish. Add it by hand instead: "Connect agent" in the review, or the README.');

	const claude = join(homedir(), '.claude');
	if (existsSync(claude)) {
		let go = yes;
		if (!yes && process.stdin.isTTY) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			go = !/^n/i.test(await rl.question('\n  Add the Claude Code skill (/telestrator) too? [Y/n] '));
			rl.close();
		}
		if (go) {
			const dest = join(claude, 'skills', 'telestrator');
			cpSync(SKILL, dest, { recursive: true });
			console.log(`  ✓ Skill added: ${dest}`);
		}
	}
	console.log('\n  Start a new agent session, then ask it to "check the video feedback".\n  Check your setup any time: npx telestrator doctor\n');
}
