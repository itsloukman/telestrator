// MCP server (stdio). An agent reads the feedback left in the review UI, looks at the annotated frames, and closes the
// loop: it can ask a question on a note, or resolve / dismiss it with a line on what it did. It works on the review
// files directly, so the UI does not need to be running.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { findReviews, readReview, reviewPath, updateReview, rel } from './store.js';
import { reviewMarkdown, noteMarkdown } from './format.js';

export async function startMcp({ root = process.cwd() } = {}) {
	root = resolve(root);
	const server = new McpServer({ name: 'video-launcher', version: '0.1.0' });

	// which review: a video path, a review file, part of a title/file name; default = the most recently touched one
	function pick(ref) {
		if (ref) {
			const p = resolve(root, ref);
			if (existsSync(p) && p.endsWith('.json') && readReview(p)) return { file: p, review: readReview(p) };
			if (existsSync(p) && readReview(reviewPath(p))) return { file: reviewPath(p), review: readReview(reviewPath(p)) };
		}
		const all = findReviews(root);
		if (!all.length) throw new Error(`No reviews under ${root}. Start one with: npx video-launcher <video>`);
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
		const all = findReviews(root);
		if (!all.length) return { content: [text(`No reviews under ${root}. The user starts one with: npx video-launcher <video>`)] };
		return { content: [text(all.map(({ file, review: r }) => {
			const open = (r.notes || []).filter((n) => (n.status || 'open') === 'open').length;
			return `- ${r.title} — ${open} open / ${(r.notes || []).length} total · video: ${rel(root, r.video)} · review: ${rel(root, file)}`;
		}).join('\n'))] };
	});

	server.registerTool('get_feedback', {
		title: 'Get video feedback',
		description: 'Read the feedback on a rendered video: each note with its time and frame, scene, narration, the element the reviewer pointed at, and what they drew. With images on, each annotated note also comes with its frame (drawing included) so you can see it.',
		inputSchema: {
			review: reviewArg,
			status: z.enum(['open', 'resolved', 'dismissed', 'all']).optional().describe('Default: open'),
			images: z.boolean().optional().describe('Attach each note\'s frame. Default: true')
		}
	}, async ({ review, status = 'open', images = true }) => {
		const { review: r } = pick(review);
		const content = [text(reviewMarkdown(r, { status, withIds: true }))];
		if (images) {
			const all = r.notes || [];
			for (const n of all.filter((x) => status === 'all' || (x.status || 'open') === status)) {
				const img = image(n.thumb);
				if (!img) continue;
				content.push(text(`Frame for note ${all.indexOf(n) + 1} (id ${n.id}) at ${n.t.toFixed(2)}s${n.ink ? ', with the reviewer\'s drawing' : ''}:`), img);
			}
		}
		return { content };
	});

	server.registerTool('get_frame', {
		title: 'Get a frame',
		description: 'Grab one frame of the video at a time in seconds, as an image (needs ffmpeg on PATH). Use it to check a spot the feedback talks about, or to verify a re-render.',
		inputSchema: { review: reviewArg, t: z.number().describe('Time in seconds'), width: z.number().optional().describe('Output width in px, default 960') }
	}, async ({ review, t, width = 960 }) => {
		const { review: r } = pick(review);
		let buf;
		try {
			buf = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(Math.max(0, t)), '-i', r.video, '-frames:v', '1', '-vf', `scale=${Math.round(width)}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4', '-'], { maxBuffer: 1 << 26 });
		} catch (e) {
			return { isError: true, content: [text('Could not grab a frame (is ffmpeg installed and on PATH?): ' + String(e.message || e).split('\n')[0])] };
		}
		return { content: [text(`${basename(r.video)} at ${t.toFixed(2)}s`), { type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') }] };
	});

	const act = (name, title, description, extra, fn) =>
		server.registerTool(name, { title, description, inputSchema: { review: reviewArg, id: z.string().describe('The note id (from get_feedback)'), ...extra } }, async (args) => {
			const { file } = pick(args.review);
			let out;
			updateReview(file, (r) => {
				const n = (r.notes || []).find((x) => x.id === args.id);
				if (!n) throw new Error(`No note ${args.id}`);
				fn(n, args);
				out = noteMarkdown(r, n, r.notes.indexOf(n), { withId: true });
			});
			return { content: [text(out)] };
		});
	const say = (n, t) => t && (n.thread ||= []).push({ from: 'agent', text: t, at: new Date().toISOString() });
	act('reply', 'Reply to a note', 'Ask the reviewer a question or leave a comment on a note. It shows under the note in their review UI; it stays open.', { message: z.string() }, (n, a) => say(n, a.message));
	act('resolve', 'Resolve a note', 'Mark a note resolved once you have made the change. Say briefly what you changed; it shows under the note.', { summary: z.string().optional() }, (n, a) => { n.status = 'resolved'; say(n, a.summary); });
	act('dismiss', 'Dismiss a note', 'Close a note without changing anything, with the reason.', { reason: z.string().optional() }, (n, a) => { n.status = 'dismissed'; say(n, a.reason); });

	await server.connect(new StdioServerTransport());
}
