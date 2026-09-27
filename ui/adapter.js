// Injected into the composition page (served same-origin by video-launcher). The review UI calls
// window.__videoLauncher.seek(t) and then hit-tests the DOM, so pointing names the element that is on screen at t.
//
// A composition can bring its own adapter by defining, before this script runs:
//   window.__videoLauncher = { seek(t) {...}, info() { return { width, height, fps, duration, scenes } } }
// Otherwise this one follows the HyperFrames contract: paused GSAP timelines in window.__timelines, and clips marked
// with data-start / data-duration whose visibility is [start, start + duration).
(() => {
	const own = window.__videoLauncher || {};
	const num = (v) => (v == null || v === '' || !isFinite(+v) ? null : +v);
	const root = () => document.querySelector('[data-root="true"]') || document.querySelector('[data-composition-id]') || document.body;

	// data-start is seconds, or a reference to another clip: "intro", "intro + 1", "intro - 0.5" (starts when it ends, +/-)
	const cache = new Map();
	function startOf(el, seen = new Set()) {
		if (cache.has(el)) return cache.get(el);
		const raw = (el.getAttribute('data-start') || '').trim();
		let s = num(raw);
		if (s == null) {
			const m = raw.match(/^([\w-]+)\s*(?:([+-])\s*([\d.]+))?$/);
			const ref = m && document.getElementById(m[1]);
			if (ref && !seen.has(ref)) {
				seen.add(ref);
				const rs = startOf(ref, seen), rd = num(ref.getAttribute('data-duration'));
				s = rs == null || rd == null ? null : rs + rd + (m[2] ? (m[2] === '-' ? -1 : 1) * +m[3] : 0);
			}
		}
		cache.set(el, s);
		return s;
	}
	function clips() {
		return [...document.querySelectorAll('[data-start]')].map((el) => {
			const start = startOf(el);
			const dur = num(el.getAttribute('data-duration')) ?? (el.tagName === 'IMG' ? 3 : null);
			return { el, start, end: start == null ? null : dur == null ? Infinity : start + dur };
		});
	}

	let sized = false;
	function size() {
		if (sized) return;
		sized = true;
		const r = root(), w = num(r.getAttribute('data-width')), h = num(r.getAttribute('data-height'));
		if (w && h) Object.assign(r.style, { width: w + 'px', height: h + 'px', position: r.style.position || 'relative', overflow: 'hidden' });
		for (const el of r.children) if (el.hasAttribute('data-start') && getComputedStyle(el).position === 'static') Object.assign(el.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%' });
		document.documentElement.style.margin = document.body.style.margin = '0';
	}

	function seek(t) {
		size();
		const r = root();
		for (const c of clips()) {
			if (c.start == null) continue;
			c.el.style.visibility = t >= c.start && t < c.end ? '' : 'hidden';
		}
		const tls = window.__timelines || {};
		for (const [id, tl] of Object.entries(tls)) {
			if (!tl) continue;
			// a sub-composition's timeline runs on its host's clock
			const host = document.querySelector(`[data-composition-id="${CSS.escape(id)}"]`);
			const offset = host && host !== r ? startOf(host) || 0 : 0;
			const lt = Math.max(0, t - offset);
			if (typeof tl.totalTime === 'function') tl.totalTime(lt, true);
			else if (typeof tl.seek === 'function') tl.seek(lt, true);
		}
		for (const m of document.querySelectorAll('video, audio')) try { m.pause(); } catch {}
	}

	function info() {
		const r = root();
		const scenes = [...r.children]
			.filter((el) => el.hasAttribute('data-start'))
			.map((el, i) => ({ id: el.id || null, name: el.getAttribute('data-name') || el.getAttribute('aria-label') || el.id || `Clip ${i + 1}`, start: startOf(el) }))
			.filter((s) => s.start != null)
			.sort((a, b) => a.start - b.start);
		return { width: num(r.getAttribute('data-width')), height: num(r.getAttribute('data-height')), fps: num(r.getAttribute('data-fps')), duration: num(r.getAttribute('data-duration')), scenes };
	}

	window.__videoLauncher = {
		seek: own.seek ? (t) => { size(); own.seek(t); } : seek,
		info: () => ({ ...info(), ...(own.info ? own.info() : {}) }),
		root
	};
})();
