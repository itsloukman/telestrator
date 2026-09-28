// The one place feedback is turned into text for an agent: used by "Copy for agent" in the UI and by the MCP tools.
// Every note carries its time (seconds and frame), the scene, what is being said there, and whatever you attached:
// the element you pointed at, or a description of what you drew.
import { dirname, join } from 'node:path';

const tc = (t) => `${t.toFixed(2)}s`;
const frame = (t, fps) => Math.round(t * fps);

// the pointed element's styles worth a line: enough to know where "too small" or "too dark" starts from
const KEY_STYLES = ['font-size', 'font-weight', 'color', 'background-color'];

// open = still to do (acknowledged means the agent has picked it up); resolved and dismissed are closed
export const statusOf = (n) => n.status || 'open';
export const isOpen = (n) => statusOf(n) === 'open' || statusOf(n) === 'acknowledged';
// what a status filter keeps: open (incl. acknowledged) · pending (not picked up yet) · resolved · dismissed · all
export function matches(n, status) {
	if (status === 'all') return true;
	if (status === 'open') return isOpen(n);
	if (status === 'pending') return statusOf(n) === 'open';
	return statusOf(n) === status;
}

export function sceneAt(review, t) {
	const s = [...(review.scenes || [])].reverse().find((x) => t >= x.start - 1e-3);
	return s || null;
}

export function noteHeading(review, n, i) {
	const fps = review.fps || 30;
	const when = n.kind === 'range' ? `${tc(n.t)} → ${tc(n.t2)} (frames ${frame(n.t, fps)}–${frame(n.t2, fps)})` : `${tc(n.t)} (frame ${frame(n.t, fps)})`;
	const s = sceneAt(review, n.t);
	return `${i + 1}. ${when}${s ? ' · ' + s.name : ''}`;
}

const sourcePath = (review, src) => (review.composition && !src.file.startsWith('/') ? join(dirname(review.composition), src.file) : src.file) + ':' + src.line;
const stylesText = (styles) => Object.entries(styles).filter(([k]) => KEY_STYLES.includes(k)).map(([k, v]) => `${k} ${v}`).join('; ');

export function noteMarkdown(review, n, i, { withId = false } = {}) {
	const out = [];
	const s = sceneAt(review, n.t);
	const st = statusOf(n);
	out.push(`## ${noteHeading(review, n, i)}${st !== 'open' ? ` — ${st}` : ''}${n.by === 'agent' ? ' (left by the agent)' : ''}`);
	if (withId) out.push(`- **Id:** \`${n.id}\``);
	out.push(`- **Feedback:** ${String(n.text).replace(/\n/g, '\n  ')}`);
	if (n.said) out.push(`- **Narration there:** “${n.said}”`);
	if (s && s.file) out.push(`- **Scene:** ${s.id || s.name} (${s.file})`);
	if (n.el) {
		out.push(`- **Pointing at:** \`${n.el.path}\`` + (n.el.text ? ` — “${n.el.text}”` : n.el.near ? ` — near “${n.el.near}”` : ''));
		if (n.el.source) out.push(`- **Source:** ${sourcePath(review, n.el.source)}${n.el.source.via ? ` (${n.el.source.via})` : ''}`);
		if (n.el.box) out.push(`- **Element box:** ${n.el.box.x},${n.el.box.y} ${n.el.box.w}×${n.el.box.h} (in ${review.width}×${review.height})`);
		const css = n.el.styles && stylesText(n.el.styles);
		if (css) out.push(`- **Styles now:** ${css}`);
	} else if (n.fx != null) out.push(`- **Where in frame:** ${Math.round(n.fx * review.width)},${Math.round(n.fy * review.height)} (in ${review.width}×${review.height})`);
	if (n.inkInfo) {
		const said = n.inkInfo.shapes.join('; ');
		const over = (n.inkInfo.over || []).filter((o) => !said.includes(o)); // don't repeat what an arrow already points at
		out.push(`- **Drawn on the frame** (${review.width}×${review.height}): ${said}` + (over.length ? ` — over ${over.join(', ')}` : ''));
	}
	for (const m of n.thread || []) out.push(`- **${m.from === 'agent' ? 'Agent' : 'Reviewer'}:** ${m.text}`);
	return out.join('\n');
}

export function reviewMarkdown(review, { status = 'open', withIds = false } = {}) {
	const all = review.notes || [];
	const notes = all.filter((n) => matches(n, status));
	const head = [
		`# Video feedback — ${review.title || review.video}`,
		`${review.duration ? review.duration.toFixed(1) + ' s · ' : ''}${review.width}×${review.height} · ${review.fps || 30} fps · ${notes.length} note${notes.length === 1 ? '' : 's'}${status === 'all' ? '' : ` (${status})`}`,
		review.composition ? `Composition: ${review.composition}` : null,
		''
	].filter((x) => x !== null);
	if (!notes.length) return head.join('\n') + (status === 'open' ? 'No open notes.' : 'No notes.');
	return head.join('\n') + notes.map((n) => noteMarkdown(review, n, all.indexOf(n), { withId: withIds })).join('\n\n') + '\n';
}
