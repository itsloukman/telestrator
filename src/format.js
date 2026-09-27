// The one place feedback is turned into text for an agent: used by "Copy for agent" in the UI and by the MCP tools.
// Every note carries its time (seconds and frame), the scene, what is being said there, and whatever you attached:
// the element you pointed at, or a description of what you drew.

const tc = (t) => `${t.toFixed(2)}s`;
const frame = (t, fps) => Math.round(t * fps);

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

export function noteMarkdown(review, n, i, { withId = false } = {}) {
	const out = [];
	const s = sceneAt(review, n.t);
	out.push(`## ${noteHeading(review, n, i)}${n.status && n.status !== 'open' ? ` — ${n.status}` : ''}`);
	if (withId) out.push(`- **Id:** \`${n.id}\``);
	out.push(`- **Feedback:** ${String(n.text).replace(/\n/g, '\n  ')}`);
	if (n.said) out.push(`- **Narration there:** “${n.said}”`);
	if (s && s.file) out.push(`- **Scene:** ${s.id || s.name} (${s.file})`);
	if (n.el) {
		out.push(`- **Pointing at:** \`${n.el.path}\`` + (n.el.text ? ` — “${n.el.text}”` : n.el.near ? ` — near “${n.el.near}”` : ''));
		if (n.el.box) out.push(`- **Element box:** ${n.el.box.x},${n.el.box.y} ${n.el.box.w}×${n.el.box.h} (in ${review.width}×${review.height})`);
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
	const notes = status === 'all' ? all : all.filter((n) => (n.status || 'open') === status);
	const head = [
		`# Video feedback — ${review.title || review.video}`,
		`${review.duration ? review.duration.toFixed(1) + ' s · ' : ''}${review.width}×${review.height} · ${review.fps || 30} fps · ${notes.length} note${notes.length === 1 ? '' : 's'}${status === 'all' ? '' : ` (${status})`}`,
		review.composition ? `Composition: ${review.composition}` : null,
		''
	].filter((x) => x !== null);
	if (!notes.length) return head.join('\n') + (status === 'open' ? 'No open notes.' : 'No notes.');
	return head.join('\n') + notes.map((n) => noteMarkdown(review, n, all.indexOf(n), { withId: withIds })).join('\n\n') + '\n';
}
