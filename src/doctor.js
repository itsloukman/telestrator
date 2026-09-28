// `npx video-launcher doctor [video | folder]`: checks what the tool needs, which agents can read the notes, and what a
// video resolves to. It only reads; nothing is changed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { findReviews, recentReviews, pretty } from './store.js';
import { loadProject } from './project.js';

const home = homedir();
const on = (cmd) => { try { execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const vscodeUser = platform() === 'darwin' ? join(home, 'Library/Application Support/Code/User') : platform() === 'win32' ? join(process.env.APPDATA || '', 'Code/User') : join(home, '.config/Code/User');

// where each agent keeps MCP servers: user-wide and in the project; `bin` or `dir` tells us it's installed
export const AGENTS = [
	{ name: 'Claude Code', bin: 'claude', files: [join(home, '.claude.json'), '.mcp.json'] },
	{ name: 'Codex', bin: 'codex', files: [join(home, '.codex/config.toml'), '.codex/config.toml'] },
	{ name: 'Cursor', dir: join(home, '.cursor'), files: [join(home, '.cursor/mcp.json'), '.cursor/mcp.json'] },
	{ name: 'VS Code', bin: 'code', dir: vscodeUser, files: [join(vscodeUser, 'mcp.json'), '.vscode/mcp.json'] },
	{ name: 'Gemini CLI', bin: 'gemini', files: [join(home, '.gemini/settings.json'), '.gemini/settings.json'] },
	{ name: 'Windsurf', dir: join(home, '.codeium/windsurf'), files: [join(home, '.codeium/windsurf/mcp_config.json')] },
	{ name: 'OpenCode', bin: 'opencode', files: [join(home, '.config/opencode/opencode.json'), join(home, '.config/opencode/opencode.jsonc'), 'opencode.json', 'opencode.jsonc'] }
];

// the config file that has a video-launcher server in it, if any (~/.claude.json is read properly: it also lists projects)
export function connectedIn(agent, cwd = process.cwd()) {
	return agent.files.map((f) => (isAbsolute(f) ? f : join(cwd, f))).find((f) => {
		try {
			if (!existsSync(f)) return false;
			const src = readFileSync(f, 'utf8');
			if (f === join(home, '.claude.json')) { const j = JSON.parse(src); return !!((j.mcpServers || {})['video-launcher'] || ((j.projects || {})[cwd]?.mcpServers || {})['video-launcher']); }
			return /["'[.]video-launcher["'\]]/.test(src);
		} catch { return false; }
	});
}

export function doctor(target, { cwd = process.cwd(), log = console.log } = {}) {
	const ok = (m) => log('  ✓ ' + m), bad = (m) => log('  ✗ ' + m), meh = (m) => log('  – ' + m);
	let problems = 0;
	log('\n  video-launcher doctor\n');

	const major = +process.versions.node.split('.')[0];
	if (major >= 18) ok(`Node ${process.versions.node}`); else { bad(`Node ${process.versions.node}: needs 18 or newer`); problems++; }
	if (on('ffmpeg')) ok('ffmpeg found (agents can grab frames: get_frame, add_note)'); else meh('ffmpeg not found: get_frame and frames on agent notes need it (brew install ffmpeg)');

	log('\n  Agents');
	let connected = 0;
	for (const a of AGENTS) {
		const file = connectedIn(a, cwd);
		const installed = (a.bin && on(a.bin)) || (a.dir && existsSync(a.dir));
		if (file) { ok(`${a.name}: connected (${pretty(file)})`); connected++; }
		else if (installed) meh(`${a.name}: installed, not connected`);
	}
	if (!connected) { bad('No agent is connected. Run: npx video-launcher init'); problems++; }
	const skill = join(home, '.claude/skills/video-launcher/SKILL.md');
	if (existsSync(skill)) ok('Claude Code skill installed (/video-launcher)'); else meh('Claude Code skill not installed (npx video-launcher init adds it)');

	log('\n  Reviews');
	const here = findReviews(cwd), recent = recentReviews();
	if (here.length) ok(`${here.length} under ${pretty(cwd)}: ${here.slice(0, 3).map((x) => x.review.title).join(', ')}${here.length > 3 ? '…' : ''}`);
	else meh(`none under ${pretty(cwd)}`);
	if (recent.length) ok(`${recent.length} opened lately (agents started elsewhere find these)`);

	if (target) {
		log('\n  Video');
		try {
			const p = loadProject(target);
			ok(`video: ${pretty(p.video)}`);
			if (p.composition) ok(`composition: ${pretty(p.composition)} (pointing names elements)`); else meh('no composition found: pointing gives frame coordinates (pass --composition <html>)');
			if (p.captions) ok(`captions: ${pretty(p.captions)}`); else if (p.lines.length) ok(`narration: ${p.lines.length} lines from the sidecar`); else meh('no captions or transcript: notes won\'t say what is being said');
			if (p.metaFile) ok(`sidecar: ${pretty(p.metaFile)}`);
		} catch (e) { bad(e.message); problems++; }
	}
	log('');
	return problems;
}
