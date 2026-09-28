#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pretty } from '../src/store.js';
import { loadProject } from '../src/project.js';

const HELP = `telestrator — point, draw and comment on any frame of a rendered video; your agent reads it over MCP.

  npx telestrator <video | project folder> [options]
      Opens the review UI for a video. A folder resolves to its newest render (./renders, ./out, or the folder).
      --composition <file>   HyperFrames-style HTML to point at elements in (default: auto-detected index.html)
      --no-composition       Review the video only
      --captions <file>      .srt / .vtt for what's being said (default: <video>.srt|.vtt if present)
      --meta <file>          Sidecar JSON { title, fps, scenes, transcript } (default: <video>.review.json)
      --fps <n>              Frame rate for frame numbers (default: from the composition, else 30)
      --port <n>             Default 4180 (the next free port is used if taken)
      --no-open              Don't open the browser

  npx telestrator init [--yes]
      Connect your agents (Claude Code, Codex, Cursor, VS Code, Gemini…) and add the Claude Code skill.

  npx telestrator doctor [video | folder]
      Check the setup: Node, ffmpeg, which agents are connected, and what a video resolves to.

  npx telestrator mcp [--root <dir>]
      MCP server over stdio for agents: list_reviews, get_feedback, watch_feedback, get_frame, acknowledge, reply,
      resolve, dismiss, add_note.
      Any agent:    npx add-mcp "npx -y telestrator mcp" --name telestrator -g
      Claude Code:  claude mcp add --scope user telestrator -- npx -y telestrator mcp
      Codex:        codex mcp add telestrator -- npx -y telestrator mcp
`;

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '-h' || a === '--help') flags.help = true;
	else if (a === '-y' || a === '--yes') flags.yes = true;
	else if (a.startsWith('--no-')) flags[a.slice(5)] = false;
	else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
	else pos.push(a);
}
if (flags.help) { process.stdout.write(HELP); process.exit(0); }

if (pos[0] === 'mcp') {
	const { startMcp } = await import('../src/mcp.js');
	await startMcp({ root: flags.root || process.cwd() });
} else if (pos[0] === 'init') {
	const { init } = await import('../src/init.js');
	await init({ yes: !!flags.yes });
} else if (pos[0] === 'doctor') {
	const { doctor } = await import('../src/doctor.js');
	process.exit(doctor(pos[1]) ? 1 : 0);
} else {
	let project;
	try {
		project = loadProject(pos[0] || '.', { composition: flags.composition, captions: flags.captions, meta: flags.meta, fps: flags.fps ? +flags.fps : null });
	} catch (e) {
		console.error('telestrator: ' + e.message + '\n\n' + HELP);
		process.exit(1);
	}
	const { startServer } = await import('../src/server.js');
	let port = flags.port ? +flags.port : 4180, started;
	for (let k = 0; k < 20 && !started; k++) {
		try { started = await startServer(project, { port: port + k }); } catch (e) { if (e.code !== 'EADDRINUSE' || flags.port) throw e; }
	}
	const r = pretty;
	console.log(`\n  telestrator  ${started.url}\n`);
	console.log(`  video        ${r(project.video)}`);
	console.log(`  composition  ${project.composition ? r(project.composition) + '  (pointing at elements: on)' : 'none  (pointing gives frame coordinates)'}`);
	if (project.captions) console.log(`  captions     ${r(project.captions)}`);
	console.log(`  notes        ${r(started.file)}`);
	console.log(`\n  Agents: npx telestrator init   (or "Connect agent" in the review)\n`);
	if (flags.open !== false) {
		const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
		const args = process.platform === 'win32' ? ['/c', 'start', '', started.url] : [started.url];
		try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch {}
	}
}
