// MCP server (stdio). An agent reads the feedback left in the review UI, looks at the annotated frames, and closes the
// loop: it can ask a question on a note, or resolve / dismiss it with a line on what it did. It works on the review
// files directly, so the UI does not need to be running. watch_feedback blocks until the reviewer adds notes (a hands-free
// loop), and add_note lets the agent critique the video itself.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { resolve, basename, dirname, parse } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { findReviews, recentReviews, readReview, reviewPath, updateReview, rel } from './store.js';
import { reviewMarkdown, noteMarkdown, isOpen, matches, statusOf } from './format.js';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
// one frame as JPEG (needs ffmpeg); with at = [x, y] (0–1), a pin is drawn where the note points
function grabFrame(video, t, width = 960, at = null) {
	const pin = at ? `,drawbox=x=iw*${at[0]}-8:y=ih*${at[1]}-8:w=16:h=16:color=0xef6a4c@1:t=fill` : '';
	return execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-vf', `scale=${Math.round(width)}:-2${pin}`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', '-'], { maxBuffer: 1 << 26 });
}

export async function startMcp({ root = process.cwd() } = {}) {
	root = resolve(root);
	const server = new McpServer({ name: 'telestrator', version: '0.1.0' }); // x-release-please-version

	// the reviews under the project; when the agent started us elsewhere (an IDE, a desktop app: often the home folder
	// or /, which we don't crawl), the ones opened lately with `npx telestrator`
	const wide = root === resolve(homedir()) || root === parse(root).root;
	const reviews = () => {
		const found = wide ? [] : findReviews(root);
		// none here: the ones opened lately in other folders, marked so every answer says where they are
		return found.length ? found : recentReviews().map((x) => ({ ...x, elsewhere: true }));
	};
	// said first in any answer about a review from another folder, so the agent doesn't go and change the wrong project
	const away = (x) => (x.elsewhere ? [text(`⚠ This review is from another folder: ${dirname(x.review.video)}. There are no reviews in ${root}, where you were started. Make sure that's the project the user means before changing any files; if it isn't, ask them to open their video with \`npx telestrator <video>\`.`)] : []);

	// which review: a video path, a review file, part of a title/file name; default = the most recently touched one
	function pick(ref) {
		if (ref) {
			const p = resolve(root, ref);
			if (existsSync(p) && p.endsWith('.json') && readReview(p)) return { file: p, review: readReview(p) };
			if (existsSync(p) && readReview(reviewPath(p))) return { file: reviewPath(p), review: readReview(reviewPath(p)) };
		}
		const all = reviews();
		if (!all.length) throw new Error(`No reviews under ${root}, and none opened lately. Start one with: npx telestrator <video>`);
		if (!ref) return all[0];
		const q = ref.toLowerCase();
		const hit = all.find((x) => (x.review.title || '').toLowerCase().includes(q) || x.file.toLowerCase().includes(q));
		if (!hit) throw new Error(`No review matches "${ref}". Known: ${all.map((x) => x.review.title).join(', ')}`);
		return hit;
	}
	const image = (dataUrl) => {
		const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(dataUrl || '');
		return m ? { type: 'image', mimeType: m[1], data: m[2] } : null;
	};
	const text = (t) => ({ type: 'text', text: t });
	const reviewArg = z.string().optional().describe('Which review: a video path, a review file, or part of its title. Defaults to the most recently updated review.');

	server.registerTool('list_reviews', {
		title: 'List video reviews',
		description: 'List the video reviews under the project, with how many notes are open in each.',
		inputSchema: {}
	}, async () => {
		const all = reviews();
		if (!all.length) return { content: [text(`No reviews under ${root}, and none opened lately. The user starts one with: npx telestrator <video>`)] };
		const head = all[0].elsewhere ? `No reviews in ${root}. These were opened lately in other folders; make sure one is the project the user means before changing any files:\n` : '';
		return { content: [text(head + all.map(({ file, review: r, elsewhere }) => {
			const open = (r.notes || []).filter(isOpen).length;
			const at = (f) => (elsewhere ? f : rel(root, f));
			return `- ${r.title} — ${open} open / ${(r.notes || []).length} total · video: ${at(r.video)} · review: ${at(file)}`;
		}).join('\n'))] };
	});

	// the notes as the agent reads them: markdown, then each annotated note's frame (drawing included)
	function feedback(r, notes, { images = true, status = 'open' } = {}) {
		const content = [text(reviewMarkdown(r, { status, withIds: true }))];
		const all = r.notes || [];
		if (images) for (const n of notes) {
			const img = image(n.thumb);
			if (!img) continue;
			content.push(text(`Frame for note ${all.indexOf(n) + 1} (id ${n.id}) at ${n.t.toFixed(2)}s${n.ink ? ', with the reviewer\'s drawing' : ''}:`), img);
		}
		return content;
	}

	server.registerTool('get_feedback', {
		title: 'Get video feedback',
		description: 'Read the feedback on a rendered video: each note with its time and frame, scene, narration, the element the reviewer pointed at (with its source line and current styles), and what they drew. With images on, each annotated note also comes with its frame (drawing included) so you can see it.',
		inputSchema: {
			review: reviewArg,
			status: z.enum(['open', 'pending', 'resolved', 'dismissed', 'all']).optional().describe('Default: open (not yet resolved or dismissed, including acknowledged). pending = not picked up yet'),
			images: z.boolean().optional().describe('Attach each note\'s frame. Default: true')
		}
	}, async ({ review, status = 'open', images = true }) => {
		const x = pick(review), r = x.review;
		return { content: [...away(x), ...feedback(r, (r.notes || []).filter((n) => matches(n, status)), { images, status })] };
	});

	// Hands-free: block until the reviewer leaves notes nobody has picked up, wait a moment for more, return the batch.
	// Loop it: acknowledge each note, fix it, resolve it, call watch_feedback again.
	server.registerTool('watch_feedback', {
		title: 'Watch for video feedback',
		description: 'Wait until the reviewer adds notes that nobody has picked up yet (pending), then return them as a batch, like get_feedback. Returns at once if some are already waiting. For a hands-free loop: acknowledge each note, make the fix, resolve it, then call watch_feedback again. Notes you left yourself with add_note are not returned.',
		inputSchema: {
			review: reviewArg,
			batchWindowSeconds: z.number().min(0).max(60).optional().describe('After the first new note, wait this long for more. Default 10'),
			timeoutSeconds: z.number().min(1).max(300).optional().describe('Give up after this long with no notes. Default 120')
		}
	}, async ({ review, batchWindowSeconds = 10, timeoutSeconds = 120 }, extra) => {
		const waiting = () => (review ? [pick(review)] : reviews()).map((x) => ({ ...x, pending: (x.review.notes || []).filter((n) => statusOf(n) === 'open' && n.by !== 'agent') })).filter((x) => x.pending.length);
		const until = Date.now() + timeoutSeconds * 1000;
		let found = waiting();
		const already = found.length > 0;
		while (!found.length && Date.now() < until && !extra?.signal?.aborted) {
			await sleep(1000);
			found = waiting();
		}
		if (!found.length) return { content: [text(`No new notes in ${timeoutSeconds}s. Call watch_feedback again to keep watching.`)] };
		// the reviewer just started writing: give them a moment to add the rest of the batch
		if (!already && batchWindowSeconds) { await sleep(batchWindowSeconds * 1000); found = waiting(); }
		const content = [];
		for (const x of found) {
			const { review: r, pending } = x, all = r.notes || [];
			content.push(...away(x));
			const md = [`# New video feedback — ${r.title || r.video}`, `${pending.length} pending note${pending.length === 1 ? '' : 's'}. Acknowledge each one as you pick it up, then resolve it.`, r.composition ? `Composition: ${r.composition}` : null, ''].filter((x) => x !== null).join('\n');
			content.push(text(md + pending.map((n) => noteMarkdown(r, n, all.indexOf(n), { withId: true })).join('\n\n')));
			for (const n of pending) { const img = image(n.thumb); if (img) content.push(text(`Frame for note ${all.indexOf(n) + 1} (id ${n.id}) at ${n.t.toFixed(2)}s:`), img); }
		}
		return { content };
	});

	// Critique mode: the agent watches the render (get_frame) and leaves its own notes for the reviewer to accept or dismiss.
	server.registerTool('add_note', {
		title: 'Add a note',
		description: 'Leave your own note on the video, for the reviewer to see in their review UI (marked as from the agent). Use it to critique a render: grab frames with get_frame, and note what looks wrong (timing, legibility, framing, contrast, typos) with its time and, if you can, where in the frame.',
		inputSchema: {
			review: reviewArg,
			t: z.number().describe('Time in seconds'),
			t2: z.number().optional().describe('End time, for a note about a stretch'),
			text: z.string().describe('What should change, and why'),
			x: z.number().min(0).max(1).optional().describe('Where in the frame, 0–1 from the left'),
			y: z.number().min(0).max(1).optional().describe('Where in the frame, 0–1 from the top')
		}
	}, async (a) => {
		const x = pick(a.review), { file, review: r } = x;
		const n = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), by: 'agent', status: 'open', thread: [], created: new Date().toISOString(), t: a.t, text: a.text };
		n.kind = a.t2 != null ? 'range' : a.x != null && a.y != null ? 'point' : 'time';
		if (a.t2 != null) n.t2 = a.t2;
		if (n.kind === 'point') Object.assign(n, { fx: a.x, fy: a.y });
		try { n.thumb = 'data:image/jpeg;base64,' + grabFrame(r.video, a.t, 640, n.kind === 'point' ? [a.x, a.y] : null).toString('base64'); } catch {}
		let out;
		updateReview(file, (rv) => {
			(rv.notes ||= []).push(n);
			rv.notes.sort((p, q) => p.t - q.t);
			out = noteMarkdown(rv, n, rv.notes.indexOf(n), { withId: true });
		});
		return { content: [...away(x), text('Added. The reviewer sees it in their review UI:\n\n' + out)] };
	});

	server.registerTool('get_frame', {
		title: 'Get a frame',
		description: 'Grab one frame of the video at a time in seconds, as an image (needs ffmpeg on PATH). Use it to check a spot the feedback talks about, or to verify a re-render.',
		inputSchema: { review: reviewArg, t: z.number().describe('Time in seconds'), width: z.number().optional().describe('Output width in px, default 960') }
	}, async ({ review, t, width = 960 }) => {
		const x = pick(review), r = x.review;
		let buf;
		try {
			buf = grabFrame(r.video, t, width);
		} catch (e) {
			return { isError: true, content: [text('Could not grab a frame (is ffmpeg installed and on PATH?): ' + String(e.message || e).split('\n')[0])] };
		}
		return { content: [...away(x), text(`${basename(r.video)} at ${t.toFixed(2)}s`), { type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') }] };
	});

	const act = (name, title, description, extra, fn) =>
		server.registerTool(name, { title, description, inputSchema: { review: reviewArg, id: z.string().describe('The note id (from get_feedback)'), ...extra } }, async (args) => {
			const x = pick(args.review), { file } = x;
			let out;
			updateReview(file, (r) => {
				const n = (r.notes || []).find((x) => x.id === args.id);
				if (!n) throw new Error(`No note ${args.id}`);
				fn(n, args);
				out = noteMarkdown(r, n, r.notes.indexOf(n), { withId: true });
			});
			return { content: [...away(x), text(out)] };
		});
	const say = (n, t) => t && (n.thread ||= []).push({ from: 'agent', text: t, at: new Date().toISOString() });
	act('acknowledge', 'Acknowledge a note', 'Tell the reviewer you have seen a note and are working on it. It shows as acknowledged in their review UI; resolve it when done.', {}, (n) => { n.status = 'acknowledged'; });
	act('reply', 'Reply to a note', 'Ask the reviewer a question or leave a comment on a note. It shows under the note in their review UI; it stays open.', { message: z.string() }, (n, a) => say(n, a.message));
	act('resolve', 'Resolve a note', 'Mark a note resolved once you have made the change. Say briefly what you changed; it shows under the note.', { summary: z.string().optional() }, (n, a) => { n.status = 'resolved'; say(n, a.summary); });
	act('dismiss', 'Dismiss a note', 'Close a note without changing anything, with the reason.', { reason: z.string().optional() }, (n, a) => { n.status = 'dismissed'; say(n, a.reason); });

	await server.connect(new StdioServerTransport());
}
