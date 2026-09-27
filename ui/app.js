// video-launcher review UI. Plain script, no build step.
(async () => {
	const $ = (s) => document.querySelector(s);
	const v = $('#v'), stage = $('#stage'), comp = $('#comp'), overlay = $('#overlay');
	const scroll = $('#scroll'), inner = $('#inner');
	const P = await fetch('/api/project').then((r) => r.json());

	// W x H: the video's own frame; every coordinate we store (points, drawings) is in these pixels
	let W = 1920, H = 1080, DUR = 1, FPS = P.fps || 30;
	let SCENES = P.scenes && P.scenes.length ? P.scenes : null;
	const LINES = P.lines || [], WORDS = P.words || null;
	let notes = [], updated = null;
	// draft: the note being written. { t, t2 } a range · { t, fx, fy, el } pointed · { t, ink } drawn · {} = at the playhead
	let draft = {}, mode = null, editing = null, activeId = null, vl = null, compW = 0, compH = 0;

	v.src = P.video;
	v.muted = localStorage.getItem('vl:muted') === '1';
	// Chrome defers media in a page opened in the background; kick the load if nothing has arrived yet
	const wake = () => { if (v.readyState === 0) v.load(); };
	document.addEventListener('visibilitychange', wake);
	window.addEventListener('pointerdown', wake, true);
	setTimeout(wake, 1500);
	await new Promise((ok) => (v.readyState >= 1 ? ok() : v.addEventListener('loadedmetadata', ok, { once: true })));
	W = v.videoWidth || W; H = v.videoHeight || H; DUR = v.duration || DUR;

	// ---- helpers ----------------------------------------------------------------------------------------------
	const tcode = (t) => { const f = Math.round(t * FPS), ff = f % FPS, s = Math.floor(f / FPS); const p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`; };
	const WHOLE = [{ id: null, name: P.title, start: 0 }];
	const scenes = () => SCENES || WHOLE;
	const sceneEnd = (s) => { const a = scenes(), i = a.indexOf(s); return i + 1 < a.length ? a[i + 1].start : DUR; };
	const sceneAt = (t) => [...scenes()].reverse().find((s) => t >= s.start - 1e-3) || scenes()[0];
	const sceneLabel = (s) => (s.id && s.id !== s.name ? `${s.id} · ${s.name}` : s.name);
	const said = (a, b) => (WORDS ? WORDS.filter((w) => w[2] >= a - 0.05 && w[1] <= b + 0.05).map((w) => w[0]) : LINES.filter((l) => l.end >= a && l.start <= b).map((l) => l.text)).join(' ');
	const saidAround = (t) => (WORDS ? said(t - 1.2, t + 1.2) : said(t - 0.3, t + 0.3));
	const toast = (m) => { const e = $('#toast'); e.textContent = m; e.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => (e.style.display = 'none'), 1800); };
	const scale = () => stage.clientWidth / W;
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	const api = (path, method = 'GET', body) => fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));

	// ---- chrome ------------------------------------------------------------------------------------------------------
	document.title = P.title + ' · video-launcher';
	$('#title').textContent = P.title;
	const stat = () => ($('#stat').textContent = `${P.videoFile} · ${DUR.toFixed(1)} s · ${W}×${H} · ${FPS} fps${SCENES ? ` · ${SCENES.length} scene${SCENES.length > 1 ? 's' : ''}` : ''}`);
	stat();
	$('#compState').textContent = P.composition ? 'loading composition…' : 'video only · points give frame coordinates';
	function counts() { const open = notes.filter((n) => (n.status || 'open') === 'open').length; $('#nNotes3').textContent = notes.length ? `${open} open` + (open < notes.length ? ` · ${notes.length - open} closed` : '') : ''; }
	function audioUi() { $('#audioTxt').textContent = v.muted ? 'Sound off' : 'Sound on'; $('#waves').style.display = v.muted ? 'none' : ''; $('#audioBtn').classList.toggle('on', !v.muted); }
	$('#audioBtn').onclick = () => { v.muted = !v.muted; localStorage.setItem('vl:muted', v.muted ? '1' : '0'); audioUi(); };
	audioUi();
	$('#mcpBtn').onclick = (e) => { e.stopPropagation(); $('#mcpPop').classList.toggle('on'); };
	document.addEventListener('click', (e) => { if (!e.target.closest('#mcpPop')) $('#mcpPop').classList.remove('on'); });
	$('#mcpCopy').onclick = async () => { await copyText($('#mcpCmd').textContent); toast('Command copied — run it in your terminal'); };
	$('#showResolved').checked = localStorage.getItem('vl:showResolved') === '1';
	$('#showResolved').onchange = () => { localStorage.setItem('vl:showResolved', $('#showResolved').checked ? '1' : '0'); renderList(); renderMarks(); };
	const visible = () => notes.filter((n) => $('#showResolved').checked || (n.status || 'open') === 'open');

	// ---- viewer: fit the stage (the video's aspect) inside the viewer body ------------------------------------------------
	function fitStage() {
		const b = $('#vbody'), w = b.clientWidth - 28, h = b.clientHeight - 28;
		const sw = Math.max(120, Math.min(w, (h * W) / H));
		stage.style.width = sw + 'px'; stage.style.height = (sw * H) / W + 'px';
		if (compW) comp.style.transform = `scale(${sw / compW})`;
		if (tIn.style.display === 'block') closeText(true);
		renderPins();
	}
	new ResizeObserver(fitStage).observe($('#vbody'));
	const ink = $('#ink'), tIn = $('#inkText');
	ink.setAttribute('viewBox', `0 0 ${W} ${H}`);
	const SW = Math.max(3, (W / 1920) * 7), FS = Math.max(18, (Math.min(W, H * 16 / 9) / 1920) * 44);
	ink.style.setProperty('--sw', SW);
	ink.style.setProperty('--fs', FS + 'px');

	// ---- the composition, for pointing: same-origin, seeked to the frame on screen, then hit-tested ---------------------------
	let compT = -1;
	if (P.composition) {
		comp.src = P.composition;
		comp.addEventListener('load', () => {
			vl = comp.contentWindow && comp.contentWindow.__videoLauncher;
			if (!vl) { $('#compState').textContent = 'composition loaded, but no adapter — video only'; return; }
			let info = {};
			try { info = vl.info() || {}; } catch {}
			compW = info.width || W; compH = info.height || H;
			Object.assign(comp.style, { width: compW + 'px', height: compH + 'px' });
			if (!P.fps && info.fps) FPS = info.fps;
			if (!SCENES && info.scenes && info.scenes.length > 1) SCENES = info.scenes;
			$('#compState').textContent = 'pointing names elements';
			api('/api/review/meta', 'POST', { duration: DUR, width: W, height: H, fps: FPS, scenes: SCENES });
			stat(); fitStage(); buildTimeline(); seekComp(v.currentTime);
		});
	}
	api('/api/review/meta', 'POST', { duration: DUR, width: W, height: H, fps: P.fps || null });
	function seekComp(t) {
		if (!vl) return;
		compT = t;
		try { vl.seek(Math.min(t, DUR - 0.001)); } catch (e) { console.warn('[video-launcher] seek failed', e); }
	}
	const compRoot = () => { try { return vl.root(); } catch { return null; } };
	// A readable path: ids, classes and meaningful data attributes; anonymous wrappers collapse into "…".
	function cssPath(el) {
		const parts = [], root = compRoot();
		let skipped = false;
		for (let e = el; e && e !== root && e.tagName !== 'BODY'; e = e.parentElement) {
			if (e.id) { parts.unshift('#' + e.id); break; }
			const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
			let attr = '';
			for (const a of ['data-name', 'data-testid', 'data-state', 'data-k', 'data-label', 'aria-label']) {
				const val = e.getAttribute && e.getAttribute(a);
				if (val !== null && val !== undefined) { attr = `[${a}${val && val !== '1' ? `="${val.slice(0, 30)}"` : ''}]`; break; }
			}
			if (!cls.length && !attr && e !== el) { skipped = true; continue; }
			if (skipped) { parts.unshift('…'); skipped = false; }
			parts.unshift((cls.length || attr ? '' : e.tagName.toLowerCase()) + (cls.length ? '.' + cls.join('.') : '') + attr);
		}
		return parts.join(' > ').replace(/(… > )+/g, '… > ');
	}
	function describe(el) {
		if (!el) return null;
		let e = el;
		while (e && e.parentElement && !e.className && !(e.childNodes[0] && e.childNodes[0].nodeType === 3 && e.textContent.trim()) && e.getBoundingClientRect().width < 6) e = e.parentElement;
		const text = (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
		const r = e.getBoundingClientRect();
		// no text of its own (a photo, a scrim): name it by the nearest text around it
		let near = '';
		for (let a = e.parentElement, k = 0; !text && a && k < 4 && !near; a = a.parentElement, k++) near = (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
		// report the box in video pixels
		const kx = W / compW, ky = H / compH;
		return { path: cssPath(e), text, near, tag: e.tagName.toLowerCase(), box: { x: Math.round(r.left * kx), y: Math.round(r.top * ky), w: Math.round(r.width * kx), h: Math.round(r.height * ky) } };
	}
	// hit-test at video pixel (x, y) against the frame on screen
	function hitAt(x, y) {
		if (!vl) return null;
		if (Math.abs(compT - v.currentTime) > 1e-3) seekComp(v.currentTime);
		const d = describe(comp.contentDocument.elementFromPoint((x * compW) / W, (y * compH) / H));
		return d && d.tag !== 'html' && d.tag !== 'body' ? d : null;
	}
	const evPt = (ev) => { const b = stage.getBoundingClientRect(); return [Math.round(((ev.clientX - b.left) / b.width) * W), Math.round(((ev.clientY - b.top) / b.height) * H)]; };

	// ---- overlay: click plays/pauses; when Point is armed, it highlights and attaches ---------------------------------------------
	const hideHl = () => { $('#hl').style.display = $('#hlTag').style.display = 'none'; };
	overlay.addEventListener('mousemove', (ev) => {
		if (mode !== 'point') return;
		const d = hitAt(...evPt(ev));
		const hl = $('#hl'), tag = $('#hlTag');
		if (!d) { hideHl(); return; }
		const s = scale();
		Object.assign(hl.style, { display: 'block', left: d.box.x * s + 'px', top: d.box.y * s + 'px', width: d.box.w * s + 'px', height: d.box.h * s + 'px' });
		tag.textContent = d.text ? `“${d.text.slice(0, 40)}”` : d.near ? `near “${d.near.slice(0, 36)}”` : d.path.split(' > ').pop();
		Object.assign(tag.style, { display: 'block', left: d.box.x * s + 'px', top: Math.max(22, d.box.y * s) + 'px' });
	});
	overlay.addEventListener('mouseleave', hideHl);
	overlay.addEventListener('click', (ev) => {
		if (ev.target.classList.contains('pin')) return;
		if (mode !== 'point') { togglePlay(); return; }
		v.pause();
		const [x, y] = evPt(ev);
		const d = hitAt(x, y);
		draft = { ink: draft.ink, t: +v.currentTime.toFixed(3), fx: x / W, fy: y / H, el: d ? { path: d.path, text: d.text, near: d.near, box: d.box } : null };
		hideSel();
		setMode(null);
		$('#cmText').focus();
	});
	// the composer's two tools: 'point' (click something) and 'draw' (on the frame); null = the frame plays/pauses
	function setMode(m) {
		if (m !== 'draw') closeText(true);
		mode = m;
		if (m) v.pause();
		if (m === 'draw') { if (draft.t2 != null) { draft = {}; hideSel(); } if (draft.t == null) draft.t = +v.currentTime.toFixed(3); }
		document.body.classList.toggle('pointing', m === 'point');
		document.body.classList.toggle('drawing', m === 'draw');
		$('#pointBtn').classList.toggle('on', m === 'point');
		$('#drawBtn').classList.toggle('on', m === 'draw');
		if (m !== 'point') hideHl();
		renderComposer();
	}
	$('#pointBtn').onclick = () => setMode(mode === 'point' ? null : 'point');
	$('#drawBtn').onclick = () => setMode(mode === 'draw' ? null : 'draw');

	// ---- drawing: shapes in video pixels, so they sit on the same spot at any window size -----------------------------------------
	// { k: 'pen', c, pts } · { k: 'arrow' | 'box', c, a, b } · { k: 'text', c, at, s }
	let cur = null, inkKey = '', inkTool = 'pen', inkColor = '#ff4f8b';
	const COLOR = { '#ff4f8b': 'pink', '#ff453a': 'red', '#ffd60a': 'yellow', '#32d74b': 'green', '#0a84ff': 'blue', '#ffffff': 'white' };
	document.querySelectorAll('#drawbar .tool[data-tool]').forEach((b) => (b.onclick = () => {
		closeText(true);
		inkTool = b.dataset.tool;
		document.querySelectorAll('#drawbar .tool[data-tool]').forEach((x) => x.classList.toggle('on', x === b));
		document.body.classList.toggle('tool-text', inkTool === 'text');
	}));
	document.querySelectorAll('#drawbar .sw').forEach((b) => (b.onclick = () => {
		inkColor = b.dataset.c;
		document.querySelectorAll('#drawbar .sw').forEach((x) => x.classList.toggle('on', x === b));
		if (tIn.style.display === 'block') { tIn.style.color = tIn.style.borderColor = inkColor; tIn.focus(); }
	}));
	function undoInk() { if (!draft.ink || !draft.ink.length) return; draft.ink.pop(); if (!draft.ink.length) delete draft.ink; renderInk(true); renderComposer(); }
	$('#undoInk').onclick = undoInk;
	ink.addEventListener('pointerdown', (ev) => {
		if (mode !== 'draw') return;
		ev.preventDefault();
		const p = evPt(ev);
		if (inkTool === 'text') { if (tIn.style.display === 'block') closeText(true); else openText(p); return; }
		ink.setPointerCapture(ev.pointerId);
		cur = inkTool === 'pen' ? { k: 'pen', c: inkColor, pts: [p] } : { k: inkTool, c: inkColor, a: p, b: p };
		draft.ink = [...(draft.ink || []), cur];
		renderInk();
	});
	ink.addEventListener('pointermove', (ev) => {
		if (!cur) return;
		const p = evPt(ev);
		if (cur.k === 'pen') { const q = cur.pts[cur.pts.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) < SW * 0.6) return; cur.pts.push(p); }
		else cur.b = p;
		renderInk();
	});
	const endShape = () => {
		if (!cur) return;
		if (cur.k === 'pen' && cur.pts.length < 2) cur.pts.push([cur.pts[0][0] + 1, cur.pts[0][1] + 1]);
		if (cur.k !== 'pen' && Math.hypot(cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]) < SW * 1.5) { draft.ink.pop(); if (!draft.ink.length) delete draft.ink; }
		cur = null;
		renderInk(true); renderComposer();
	};
	ink.addEventListener('pointerup', endShape);
	ink.addEventListener('pointercancel', endShape);
	// text: a field on the frame where you clicked, in the colour you picked; Enter or clicking away places it
	function openText(p) {
		const k = scale();
		Object.assign(tIn.style, { display: 'block', left: p[0] * k + 'px', top: p[1] * k - 2 + 'px', fontSize: FS * k + 'px', color: inkColor, borderColor: inkColor });
		tIn.value = ''; tIn.size = 4; tIn.dataset.at = p.join(','); tIn.dataset.c = inkColor;
		setTimeout(() => tIn.focus(), 0);
	}
	function closeText(keep) {
		if (tIn.style.display !== 'block') return;
		const txt = tIn.value.trim();
		tIn.style.display = 'none';
		if (keep && txt) { draft.ink = [...(draft.ink || []), { k: 'text', c: inkColor, at: tIn.dataset.at.split(',').map(Number), s: txt }]; renderInk(true); renderComposer(); }
	}
	tIn.addEventListener('input', () => (tIn.size = Math.max(4, tIn.value.length + 1)));
	tIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') closeText(true); else if (e.key === 'Escape') closeText(false); e.stopPropagation(); });
	tIn.addEventListener('blur', () => closeText(true));
	function shapeSvg(sh) {
		const st = `style="stroke:${sh.c}"`;
		if (sh.k === 'pen') return `<path ${st} d="M${sh.pts.map((q) => q.join(' ')).join('L')}"/>`;
		if (sh.k === 'box') return `<rect ${st} rx="${SW * 1.4}" x="${Math.min(sh.a[0], sh.b[0])}" y="${Math.min(sh.a[1], sh.b[1])}" width="${Math.abs(sh.b[0] - sh.a[0])}" height="${Math.abs(sh.b[1] - sh.a[1])}"/>`;
		if (sh.k === 'arrow') {
			const [x1, y1] = sh.a, [x2, y2] = sh.b, an = Math.atan2(y2 - y1, x2 - x1), L = SW * 4.3;
			const h1 = [x2 - L * Math.cos(an - 0.5), y2 - L * Math.sin(an - 0.5)], h2 = [x2 - L * Math.cos(an + 0.5), y2 - L * Math.sin(an + 0.5)];
			return `<path ${st} d="M${x1} ${y1}L${x2} ${y2}M${h1.join(' ')}L${x2} ${y2}L${h2.join(' ')}"/>`;
		}
		if (sh.k === 'text') return `<text x="${sh.at[0]}" y="${sh.at[1]}" style="fill:${sh.c}">${esc(sh.s)}</text>`;
		return '';
	}
	// the draft's shapes, plus the saved drawings of any note sitting on this frame
	function renderInk(force) {
		const t = v.currentTime;
		const vis = visible().filter((n) => n.ink && Math.abs(n.t - t) < 0.25 && (!editing || n.id !== editing.id));
		const k = vis.map((n) => n.id).join() + '|' + JSON.stringify(draft.ink || []);
		if (k === inkKey && !force) return;
		inkKey = k;
		ink.innerHTML = [...vis.flatMap((n) => n.ink), ...(draft.ink || [])].map(shapeSvg).join('');
	}
	// what a drawing says in words: its shape, colour, where it is, and what it covers (hit-tested on this frame)
	function describeInk(list) {
		const shapes = [], over = [];
		const under = (x, y) => { const d = hitAt(x, y); if (!d) return ''; const l = elLabel(d); if (!over.includes(l)) over.push(l); return l; };
		list.forEach((sh) => {
			const col = COLOR[sh.c] ? ` (${COLOR[sh.c]})` : '';
			if (sh.k === 'text') { const l = under(sh.at[0] + FS / 4, sh.at[1] + FS / 2); shapes.push(`wrote “${sh.s}” at ${sh.at.join(',')}${col}` + (l ? ` on ${l}` : '')); return; }
			if (sh.k === 'arrow') { const l = under(sh.b[0], sh.b[1]); shapes.push(`arrow from ${sh.a.join(',')} to ${sh.b.join(',')}${col}` + (l ? ` pointing at ${l}` : '')); return; }
			if (sh.k === 'box') {
				const x0 = Math.min(sh.a[0], sh.b[0]), y0 = Math.min(sh.a[1], sh.b[1]), w = Math.abs(sh.b[0] - sh.a[0]), h = Math.abs(sh.b[1] - sh.a[1]);
				under(x0 + w / 2, y0 + h / 2); shapes.push(`box around ${x0},${y0} ${w}×${h}${col}`); return;
			}
			const st = sh.pts, xs = st.map((q) => q[0]), ys = st.map((q) => q[1]);
			const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
			const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
			let len = 0; for (let i = 1; i < st.length; i++) len += Math.hypot(st[i][0] - st[i - 1][0], st[i][1] - st[i - 1][1]);
			const a = st[0], b = st[st.length - 1], chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
			const box = `${x0},${y0} ${x1 - x0}×${y1 - y0}`;
			if (chord < 0.3 * diag && len > 1.5 * diag) shapes.push(`circled ${box}${col}`);
			else if (len < 1.25 * chord) shapes.push(`line from ${a[0]},${a[1]} to ${b[0]},${b[1]}${col}`);
			else shapes.push(`scribble over ${box}${col}`);
			under((x0 + x1) / 2, (y0 + y1) / 2);
		});
		return { shapes, over: over.slice(0, 4) };
	}

	// ---- the composer: where the note is anchored, what's attached, the text ------------------------------------------------------
	const elLabel = (el) => (el.text ? '“' + el.text.slice(0, 60) + '”' : el.near ? 'near “' + el.near + '”' : el.path.split(' > ').slice(-2).join(' > '));
	function renderComposer() {
		const t = draft.t != null ? draft.t : v.currentTime;
		$('#cmTc').textContent = draft.t2 != null ? `${tcode(draft.t)} → ${tcode(draft.t2)}` : tcode(t);
		$('#cmScene').textContent = sceneLabel(sceneAt(t)) + (draft.t == null ? ' · at the playhead' : '');
		const chips = [];
		if (mode === 'point') chips.push(`<span class="chip arm"><span>${vl ? 'Click anything in the frame…' : 'Click a spot in the frame…'}</span></span>`);
		else if (draft.fx != null) chips.push(`<span class="chip pt"><span>◎ ${esc(draft.el ? elLabel(draft.el) : `spot ${Math.round(draft.fx * W)},${Math.round(draft.fy * H)}`)}</span><button data-x="pt" title="Detach">×</button></span>`);
		if (draft.ink && draft.ink.length) chips.push(`<span class="chip dw"><span>✎ Drawing · ${draft.ink.length} mark${draft.ink.length > 1 ? 's' : ''}</span><button data-x="dw" title="Erase">×</button></span>`);
		if (draft.t2 != null) chips.push(`<span class="chip rg"><span>↔ ${(draft.t2 - draft.t).toFixed(1)} s range</span><button data-x="rg" title="Detach">×</button></span>`);
		$('#cmChips').innerHTML = chips.join('');
		$('#cmChips').querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => {
			const k = b.dataset.x;
			if (k === 'pt') { delete draft.fx; delete draft.fy; delete draft.el; }
			if (k === 'dw') delete draft.ink;
			if (k === 'rg') { draft = {}; hideSel(); }
			if (draft.fx == null && !draft.ink && draft.t2 == null && mode !== 'draw') draft = {};
			renderComposer(); renderInk(true);
		}));
		$('#cmAdd').textContent = editing ? 'Save note' : 'Add note';
		$('#cmCancel').style.display = editing || draft.t != null || $('#cmText').value ? '' : 'none';
		$('#cmText').placeholder = draft.fx != null || draft.ink ? 'What should change about this?' : draft.t2 != null ? 'What should change in this stretch?' : 'What should change here?';
		renderPins();
	}
	function resetComposer() { draft = {}; editing = null; $('#cmText').value = ''; hideSel(); setMode(null); renderInk(true); }
	async function commit() {
		const text = $('#cmText').value.trim();
		if (!text) { $('#cmText').focus(); return; }
		closeText(true);
		const n = { id: editing ? editing.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 5) };
		n.t = draft.t != null ? draft.t : +v.currentTime.toFixed(3);
		n.kind = draft.t2 != null ? 'range' : draft.fx != null ? 'point' : draft.ink && draft.ink.length ? 'draw' : 'time';
		if (n.kind === 'range') n.t2 = draft.t2;
		if (draft.fx != null) Object.assign(n, { fx: draft.fx, fy: draft.fy, el: draft.el || null });
		if (draft.ink && draft.ink.length && n.kind !== 'range') { n.ink = draft.ink; n.inkInfo = describeInk(draft.ink); }
		n.text = text;
		const s = sceneAt(n.t);
		n.scene = s.id || s.name;
		n.said = n.kind === 'range' ? said(n.t, n.t2) : saidAround(n.t);
		n.thumb = !editing || n.ink || n.fx != null ? await grab(n) : editing.thumb;
		const wasEdit = !!editing;
		try {
			const saved = await api('/api/notes', 'POST', n);
			const i = notes.findIndex((x) => x.id === saved.id);
			if (i >= 0) notes[i] = saved; else notes.push(saved);
			notes.sort((a, b) => a.t - b.t);
			activeId = saved.id;
		} catch (e) { toast('Could not save: ' + e.message); return; }
		resetComposer();
		counts(); renderList(); renderMarks();
		toast(wasEdit ? 'Note saved' : 'Note added');
	}
	$('#cmAdd').onclick = commit;
	$('#cmCancel').onclick = () => { resetComposer(); $('#cmText').blur(); };
	$('#cmText').addEventListener('input', renderComposer);
	$('#cmText').addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
		else if (e.key === 'Escape') { $('#cmText').blur(); if (mode) setMode(null); }
		e.stopPropagation();
	});

	// the note's frame as the agent will see it: the video frame, the pin, and the drawing baked in
	async function grab(n) {
		try {
			if (v.seeking) await new Promise((ok) => v.addEventListener('seeked', ok, { once: true }));
			const cw = 640, ch = Math.round((640 * H) / W), k = cw / W;
			const c = document.createElement('canvas'); c.width = cw; c.height = ch;
			const g = c.getContext('2d');
			g.drawImage(v, 0, 0, cw, ch);
			g.lineCap = g.lineJoin = 'round';
			for (const sh of n.ink || []) {
				g.strokeStyle = g.fillStyle = sh.c; g.lineWidth = Math.max(2, SW * k);
				g.beginPath();
				if (sh.k === 'pen') sh.pts.forEach((q, i) => g[i ? 'lineTo' : 'moveTo'](q[0] * k, q[1] * k));
				else if (sh.k === 'box') g.rect(Math.min(sh.a[0], sh.b[0]) * k, Math.min(sh.a[1], sh.b[1]) * k, Math.abs(sh.b[0] - sh.a[0]) * k, Math.abs(sh.b[1] - sh.a[1]) * k);
				else if (sh.k === 'arrow') {
					const an = Math.atan2(sh.b[1] - sh.a[1], sh.b[0] - sh.a[0]), L = SW * 4.3 * k;
					g.moveTo(sh.a[0] * k, sh.a[1] * k); g.lineTo(sh.b[0] * k, sh.b[1] * k);
					g.moveTo(sh.b[0] * k - L * Math.cos(an - 0.5), sh.b[1] * k - L * Math.sin(an - 0.5)); g.lineTo(sh.b[0] * k, sh.b[1] * k); g.lineTo(sh.b[0] * k - L * Math.cos(an + 0.5), sh.b[1] * k - L * Math.sin(an + 0.5));
				} else if (sh.k === 'text') { g.font = `700 ${FS * k}px -apple-system, sans-serif`; g.textBaseline = 'top'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(sh.s, sh.at[0] * k, sh.at[1] * k); g.fillText(sh.s, sh.at[0] * k, sh.at[1] * k); continue; }
				g.stroke();
			}
			if (n.fx != null) {
				const x = n.fx * cw, y = n.fy * ch;
				if (n.el && n.el.box) { g.strokeStyle = '#ef6a4c'; g.lineWidth = 2; g.strokeRect(n.el.box.x * k, n.el.box.y * k, n.el.box.w * k, n.el.box.h * k); }
				g.fillStyle = '#ef6a4c'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
				g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
			}
			return c.toDataURL('image/jpeg', 0.78);
		} catch { return null; }
	}
	function renderPins() {
		renderInk();
		overlay.querySelectorAll('.pin').forEach((p) => p.remove());
		const t = v.currentTime;
		const d = draft.fx != null ? draft : null;
		const show = [...visible().filter((n) => n.fx != null && (!editing || n.id !== editing.id)), ...(d ? [d] : [])];
		show.forEach((n) => {
			if (Math.abs(n.t - t) >= 0.25 && n !== d) return;
			const p = document.createElement('div');
			p.className = 'pin';
			p.textContent = n === d ? '+' : notes.indexOf(n) + 1;
			p.style.left = n.fx * 100 + '%'; p.style.top = n.fy * 100 + '%';
			p.onclick = (e) => { e.stopPropagation(); if (n !== d) select(n.id); };
			overlay.appendChild(p);
		});
	}

	// ---- filmstrip: frames sampled in the browser from a second, silent copy of the video ------------------------------------------
	const STRIP = { n: Math.max(2, Math.min(240, Math.ceil(DUR))), h: 90, url: null };
	STRIP.w = Math.round((STRIP.h * W) / H);
	const frameBg = (t, w, h) => {
		if (!STRIP.url) return '#000';
		const i = Math.max(0, Math.min(STRIP.n - 1, Math.floor((t / DUR) * STRIP.n)));
		const k = h / STRIP.h;
		return `url(${STRIP.url}) ${-i * STRIP.w * k}px 0 / ${STRIP.n * STRIP.w * k}px ${h}px no-repeat`;
	};
	(async () => {
		const vs = document.createElement('video');
		vs.muted = true; vs.preload = 'auto'; vs.src = P.video;
		const kick = setInterval(() => { if (vs.readyState === 0) vs.load(); }, 1500);
		await new Promise((ok) => vs.addEventListener('loadeddata', ok, { once: true }));
		clearInterval(kick);
		const c = document.createElement('canvas');
		c.width = STRIP.n * STRIP.w; c.height = STRIP.h;
		const g = c.getContext('2d');
		for (let i = 0; i < STRIP.n; i++) {
			vs.currentTime = Math.min(DUR - 0.05, ((i + 0.5) / STRIP.n) * DUR);
			await new Promise((ok) => vs.addEventListener('seeked', ok, { once: true }));
			g.drawImage(vs, i * STRIP.w, 0, STRIP.w, STRIP.h);
			if (i === STRIP.n - 1 || (i + 1) % 20 === 0) {
				const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.7));
				if (STRIP.url) URL.revokeObjectURL(STRIP.url);
				STRIP.url = URL.createObjectURL(blob);
				paintStrip();
			}
		}
		vs.removeAttribute('src'); vs.load();
	})();

	// ---- timeline: the whole video always fits --------------------------------------------------------------------------------------
	let pps = 20;
	const t2px = (t) => t * pps;
	const px2t = (x) => Math.max(0, Math.min(DUR, x / pps));
	function buildTimeline() {
		pps = (scroll.clientWidth - 2) / DUR;
		inner.style.width = DUR * pps + 'px';
		const ruler = $('#ruler');
		ruler.innerHTML = '';
		const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
		const step = steps.find((s) => s * pps >= 90) || 600;
		const minor = step / 5;
		for (let t = 0; t <= DUR + 1e-6; t += minor) {
			const big = Math.abs(t / step - Math.round(t / step)) < 1e-6;
			const k = document.createElement('div');
			k.className = 'tick' + (big ? ' big' : '');
			k.style.left = t2px(t) + 'px';
			ruler.appendChild(k);
			if (big) { const l = document.createElement('div'); l.className = 'lab'; l.style.left = t2px(t) + 'px'; l.textContent = tcode(t); ruler.appendChild(l); }
		}
		const pic = $('#rowPic'); pic.innerHTML = '';
		scenes().forEach((s, i) => {
			const a = s.start, b = sceneEnd(s), w = t2px(b - a);
			const e = document.createElement('div');
			e.className = 'clip pic'; e.dataset.i = i; e.style.left = t2px(a) + 'px'; e.style.width = Math.max(2, w - 2) + 'px';
			e.title = sceneLabel(s) + (s.file ? ' — ' + s.file : '');
			e.innerHTML = `<span class="cap"><svg class="ic" viewBox="0 0 24 24" style="width:12px;height:12px"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14"/></svg>${esc(sceneLabel(s))}</span><div class="strip"></div><span class="dur">${tcode(b - a)}</span>`;
			pic.appendChild(e);
		});
		paintStrip();
		renderMarks();
		lastScene = null;
		tick(true);
	}
	function paintStrip() {
		const TH = 84 - 6 - 2 - 19 - 15, TW = (TH * W) / H;
		document.querySelectorAll('.clip.pic').forEach((e) => {
			const s = scenes()[+e.dataset.i], a = s.start, w = t2px(sceneEnd(s) - a);
			let html = '';
			for (let x = 0; x < w; x += TW) html += `<span style="width:${TW}px;background:${frameBg(a + (x + TW / 2) / pps, TW, TH)}"></span>`;
			e.querySelector('.strip').innerHTML = html;
		});
	}
	// the comments track: every note is the same tag. A moment is just its number, on its frame; a range is that tag stretched
	// over its stretch, with the text if it fits. The width only ever means duration.
	function renderMarks() {
		const row = $('#rowNotes');
		row.innerHTML = '';
		visible().forEach((n) => {
			const i = notes.indexOf(n);
			const e = document.createElement('div');
			const k = n.kind === 'range' ? 'rg' : n.kind === 'time' ? 'tm' : n.kind === 'draw' ? 'dw' : 'pt';
			e.className = 'mk ' + k + (n.id === activeId ? ' on' : '');
			e.style.left = t2px(n.t) + 'px';
			if ((n.status || 'open') !== 'open') e.style.opacity = '0.45';
			if (k === 'rg') { e.style.width = Math.max(22, t2px(n.t2 - n.t)) + 'px'; e.innerHTML = `<b>${i + 1}</b><span>${esc(n.text)}</span>`; }
			else e.innerHTML = `<b>${n.ink ? '✎ ' : ''}${i + 1}</b>`;
			e.title = `${i + 1}. ${n.text}`;
			e.onmousedown = (ev) => { ev.stopPropagation(); select(n.id); };
			row.appendChild(e);
		});
	}
	new ResizeObserver(() => buildTimeline()).observe(scroll);

	// scrub, or drag across the filmstrip for a range; the ruler always scrubs
	let drag = null;
	const sel = $('#sel');
	function hideSel() { sel.style.display = 'none'; }
	const xIn = (ev) => Math.max(0, Math.min(inner.clientWidth, ev.clientX - inner.getBoundingClientRect().left));
	inner.addEventListener('mousedown', (ev) => {
		if (ev.button !== 0) return;
		ev.preventDefault();
		drag = { x0: xIn(ev), moved: false, scrubOnly: !!ev.target.closest('#ruler') };
		if (draft.t2 != null) { draft = {}; hideSel(); }
		v.pause();
		seek(px2t(drag.x0));
	});
	window.addEventListener('mousemove', (ev) => {
		const b = scroll.getBoundingClientRect(), hov = $('#hover');
		if (ev.clientY >= b.top && ev.clientY <= b.bottom && ev.clientX >= b.left && ev.clientX <= b.right) { hov.style.display = 'block'; hov.style.left = xIn(ev) + 'px'; } else hov.style.display = 'none';
		if (!drag) return;
		const x = xIn(ev);
		if (Math.abs(x - drag.x0) > 4) drag.moved = true;
		if (drag.moved && !drag.scrubOnly) {
			const a = Math.min(x, drag.x0), c = Math.max(x, drag.x0);
			Object.assign(sel.style, { display: 'block', left: a + 'px', width: c - a + 'px' });
		}
		seek(px2t(x));
	});
	window.addEventListener('mouseup', (ev) => {
		if (!drag) return;
		const x = xIn(ev);
		if (drag.moved && !drag.scrubOnly) {
			const t = px2t(Math.min(x, drag.x0)), t2 = px2t(Math.max(x, drag.x0));
			seek(t);
			draft = { t: +t.toFixed(3), t2: +t2.toFixed(3) };
			renderComposer();
			$('#cmText').focus();
		}
		drag = null;
	});

	// ---- transport ------------------------------------------------------------------------------------------------------------------
	function seek(t) { v.currentTime = Math.max(0, Math.min(DUR - 0.001, t)); }
	function togglePlay() { if (mode) setMode(null); v.paused ? v.play() : v.pause(); }
	const PLAY = '<path d="M7 5l12 7-12 7z" fill="currentColor"/>', PAUSE = '<path d="M8 5v14M16 5v14" stroke-width="3"/>';
	$('#play').onclick = togglePlay;
	v.addEventListener('play', () => { $('#playIc').innerHTML = PAUSE; });
	v.addEventListener('pause', () => { $('#playIc').innerHTML = PLAY; seekComp(v.currentTime); });
	v.addEventListener('seeked', () => { if (v.paused) seekComp(v.currentTime); });
	const stepScene = (d) => { const a = scenes(), i = a.indexOf(sceneAt(v.currentTime)); const j = Math.max(0, Math.min(a.length - 1, i + d)); v.pause(); seek(d < 0 && v.currentTime - a[i].start > 0.5 ? a[i].start : a[j].start + 0.001); };
	$('#prevScene').onclick = () => stepScene(-1);
	$('#nextScene').onclick = () => stepScene(1);
	$('#back').onclick = () => { v.pause(); seek(v.currentTime - 1 / FPS); };
	$('#fwd').onclick = () => { v.pause(); seek(v.currentTime + 1 / FPS); };
	$('#fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());
	let lastScene = null;
	function tick(once) {
		const t = v.currentTime;
		const hx = t2px(t);
		$('#head').style.left = hx + 'px';
		const code = tcode(t);
		$('#tc').innerHTML = `${code} <span class="of">/ ${tcode(DUR)}</span>`;
		const s = sceneAt(t);
		if (s !== lastScene) {
			lastScene = s;
			if (draft.t == null) renderComposer();
			const i = scenes().indexOf(s);
			document.querySelectorAll('.clip.pic').forEach((e) => e.classList.toggle('on', +e.dataset.i === i && scenes().length > 1));
			$('#vName').textContent = sceneLabel(s);
		}
		if (draft.t == null) $('#cmTc').textContent = code;
		renderPins();
		if (once !== true) requestAnimationFrame(tick);
	}
	requestAnimationFrame(tick);
	window.addEventListener('keydown', (e) => {
		if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
		if (mode === 'draw' && (e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoInk(); return; }
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const step = e.shiftKey ? 1 : 1 / FPS;
		if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); v.pause(); seek(v.currentTime + step); }
		else if (e.key === 'ArrowLeft') { e.preventDefault(); v.pause(); seek(v.currentTime - step); }
		else if (e.key === 'ArrowDown') { e.preventDefault(); stepScene(1); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); stepScene(-1); }
		else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); v.pause(); $('#cmText').focus(); }
		else if (e.key === 'p' || e.key === 'P') setMode(mode === 'point' ? null : 'point');
		else if (e.key === 'd' || e.key === 'D') setMode(mode === 'draw' ? null : 'draw');
		else if (e.key === 'm' || e.key === 'M') $('#audioBtn').click();
		else if (e.key === 'f' || e.key === 'F') $('#fs').click();
		else if (e.key === 'Escape') { if (mode) setMode(null); else { draft = {}; hideSel(); renderComposer(); renderInk(true); } }
	});

	// ---- notes list: statuses and the thread with your agent -----------------------------------------------------------------------
	function select(id) {
		activeId = id;
		const n = notes.find((x) => x.id === id);
		if (n) { v.pause(); seek(n.t); }
		renderList(); renderMarks();
	}
	function renderList() {
		const list = $('#list');
		const shown = visible();
		if (!shown.length) {
			list.innerHTML = notes.length
				? '<div class="empty">Every note is closed. Tick <b>Show resolved</b> to see them.</div>'
				: `<div class="empty">Write above: a note lands at the playhead. <b>Point</b> (P) attaches ${vl ? 'the element you click' : 'a spot'} in the frame, <b>Draw</b> (D) marks it up, and <b>dragging the filmstrip</b> makes a range.<br><br>Your agent reads these over MCP (<b>Connect agent</b>), or <b>Copy for agent</b> and paste.</div>`;
			return;
		}
		const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.reply');
		if (focused) return; // don't yank the reply box while it's being typed in
		list.innerHTML = '';
		shown.forEach((n) => {
			const i = notes.indexOf(n);
			const st = n.status || 'open';
			const e = document.createElement('div');
			e.className = 'note ' + st + (n.id === activeId ? ' active' : '');
			const when = n.kind === 'range' ? `${tcode(n.t).slice(3)}–${tcode(n.t2).slice(3)}` : tcode(n.t).slice(3);
			const cls = n.kind === 'range' ? 'r' : n.kind === 'time' ? 't' : '';
			const s = sceneAt(n.t);
			e.innerHTML = `${n.thumb ? `<img src="${n.thumb}">` : '<div class="noimg"></div>'}<div style="min-width:0"><div class="hd"><span class="n ${cls}">${i + 1}</span><span class="tcs">${when}</span>${st !== 'open' ? `<span class="st ${st}">${st}</span>` : `<span class="scn">${esc(scenes().length > 1 ? s.name : '')}</span>`}<button class="x" title="Delete">×</button></div><div class="txt"></div>${n.fx != null || n.ink ? `<div class="el"></div>` : ''}</div>`;
			e.querySelector('.txt').textContent = n.text;
			if (n.fx != null || n.ink) e.querySelector('.el').textContent = [n.fx != null && '◎ ' + (n.el ? elLabel(n.el) : `spot ${Math.round(n.fx * W)},${Math.round(n.fy * H)}`), n.ink && '✎ ' + ((n.inkInfo && n.inkInfo.shapes[0]) || 'drawing')].filter(Boolean).join(' · ');
			if ((n.thread || []).length) {
				const th = document.createElement('div');
				th.className = 'thread';
				th.innerHTML = n.thread.map((m) => `<div class="msg ${m.from === 'agent' ? 'agent' : ''}"><i>${m.from === 'agent' ? 'Agent' : 'You'}</i>${esc(m.text)}</div>`).join('');
				e.appendChild(th);
			}
			if (n.id === activeId) {
				const r = document.createElement('div');
				r.className = 'reply';
				r.innerHTML = `<input placeholder="${n.thread && n.thread.length ? 'Reply…' : 'Add to this note…'}" /><button class="btn" data-a="reply">Send</button><button class="btn ghost" data-a="status">${st === 'open' ? 'Resolve' : 'Reopen'}</button>`;
				const input = r.querySelector('input');
				const send = async () => { const t = input.value.trim(); if (!t) return; input.value = ''; await api(`/api/notes/${n.id}/reply`, 'POST', { text: t }); await refresh(true); };
				input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); ev.stopPropagation(); });
				r.querySelector('[data-a=reply]').onclick = (ev) => { ev.stopPropagation(); send(); };
				r.querySelector('[data-a=status]').onclick = async (ev) => { ev.stopPropagation(); await api(`/api/notes/${n.id}/status`, 'POST', { status: st === 'open' ? 'resolved' : 'open' }); await refresh(true); };
				r.onclick = (ev) => ev.stopPropagation();
				e.appendChild(r);
			}
			e.onclick = () => select(n.id);
			e.ondblclick = (ev) => {
				if (ev.target.closest('.reply')) return;
				v.pause(); seek(n.t);
				editing = n;
				draft = { t: n.t, t2: n.t2, fx: n.fx, fy: n.fy, el: n.el, ink: n.ink ? JSON.parse(JSON.stringify(n.ink)) : undefined };
				$('#cmText').value = n.text; renderComposer(); $('#cmText').focus();
			};
			e.title = 'Double-click to edit';
			e.querySelector('.x').onclick = async (ev) => { ev.stopPropagation(); await api(`/api/notes/${n.id}`, 'DELETE'); notes = notes.filter((x) => x.id !== n.id); counts(); renderList(); renderMarks(); };
			list.appendChild(e);
		});
		const a = list.querySelector('.note.active'); if (a) a.scrollIntoView({ block: 'nearest' });
	}
	$('#clear').onclick = async () => { if (notes.length && confirm('Delete all notes on this video?')) { await api('/api/notes', 'DELETE'); notes = []; counts(); renderList(); renderMarks(); } };

	// ---- sync with the file: your agent may reply or resolve while this is open ---------------------------------------------------
	async function refresh(force) {
		const r = await fetch('/api/review').then((x) => x.json()).catch(() => null);
		if (!r || (!force && r.updated === updated)) return;
		const agentMoved = updated && (r.notes || []).some((n) => { const o = notes.find((x) => x.id === n.id); return o && ((o.thread || []).length !== (n.thread || []).length || o.status !== n.status); });
		updated = r.updated;
		notes = r.notes || [];
		counts(); renderList(); renderMarks();
		if (agentMoved && !force) toast('Your agent updated the notes');
	}
	await refresh(true);
	setInterval(refresh, 2000);

	// ---- copy for an agent (the same markdown the MCP server returns) ---------------------------------------------------------------
	async function copyText(s) {
		try { await navigator.clipboard.writeText(s); } catch { const ta = document.createElement('textarea'); ta.value = s; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
	}
	$('#copy').onclick = async () => {
		const open = notes.filter((n) => (n.status || 'open') === 'open').length;
		if (!open) { toast('No open notes'); return; }
		await copyText(await fetch('/api/markdown?status=open').then((r) => r.text()));
		toast(`Copied ${open} note${open > 1 ? 's' : ''} — paste it to your agent`);
	};

	renderList(); buildTimeline(); fitStage(); renderComposer();
})();
