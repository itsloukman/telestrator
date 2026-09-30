// telestrator review UI. Plain script, no build step.
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
	// a file the browser can't decode (ProRes, some HEVC or MKV) errors out, or loads with no picture: say so, and how to
	// convert it, instead of leaving a blank page
	const playable = await new Promise((ok) => {
		if (v.readyState >= 1) return ok(v.videoWidth > 0);
		v.addEventListener('loadedmetadata', () => ok(v.videoWidth > 0), { once: true });
		v.addEventListener('error', () => ok(false), { once: true });
	});
	if (!playable) {
		const box = document.createElement('div');
		box.className = 'unplayable';
		box.innerHTML = '<b>This video can’t play in your browser.</b><p>Browsers play MP4 (H.264) and WebM. ProRes, and some HEVC or MKV files, don’t. Render it as an H.264 MP4, or convert this file:</p><code></code><p class="dim">Then open the new file with telestrator.</p>';
		const out = P.videoPath.replace(/\.[^./\\]+$/, '') + '-h264.mp4';
		box.querySelector('code').textContent = `ffmpeg -i "${P.videoPath}" -c:v libx264 -pix_fmt yuv420p -c:a aac "${out}"`;
		$('#vbody').replaceChildren(box);
		$('#title').title = P.videoFile + ' · can’t play in this browser';
		return;
	}
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
	// a toast; with an action it gets a button (Undo, Reload) and stays a little longer
	const toast = (m, action) => {
		const e = $('#toast'), wait = (toast.busy || 0) - Date.now();
		if (!action && wait > 0 && e.classList.contains('show')) { setTimeout(() => toast(m), wait + 50); return; }
		toast.busy = action ? Date.now() + (action.ms || 5000) : 0;
		e.textContent = m;
		if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { clearTimeout(toast.t); toast.busy = 0; e.classList.remove('show'); action.run(); }; e.appendChild(b); }
		e.classList.toggle('act', !!action);
		e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), action ? action.ms || 5000 : 1800);
	};
	const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; if (!isFinite(s)) return ''; if (s < 45) return 'just now'; const m = Math.round(s / 60); if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago'; };
	const scale = () => stage.clientWidth / W;
	// open = still to do; acknowledged means the agent has picked it up
	const isOpenN = (n) => (n.status || 'open') === 'open' || n.status === 'acknowledged';
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	const api = (path, method = 'GET', body) => fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(new Error(e.error)))));

	// ---- chrome ------------------------------------------------------------------------------------------------------
	document.title = P.title + ' · telestrator';
	$('#title').textContent = P.title;
	const stat = () => ($('#title').title = `${P.videoFile} · ${DUR.toFixed(1)} s · ${W}×${H} · ${FPS} fps${SCENES ? ` · ${SCENES.length} scene${SCENES.length > 1 ? 's' : ''}` : ''}`);
	stat();
	$('#compState').textContent = P.composition ? 'loading composition…' : 'video only · points give frame coordinates';
	// a deleted note is hidden for 5 s, with Undo, before it is really deleted
	const gone = new Map();
	const alive = (n) => !gone.has(n.id);
	// what the agent has done on a note since you last looked at it: a reply, or a new status. Remembered per review
	const SEEN = 'vl:seen:' + P.reviewFile;
	let seen = JSON.parse(localStorage.getItem(SEEN) || 'null');
	const stamp = (n) => (n.thread || []).filter((m) => m.from === 'agent').length + '|' + (n.status || 'open');
	const unread = (n) => !!seen && (seen[n.id] === undefined ? n.by === 'agent' : seen[n.id] !== stamp(n));
	const markSeen = (n) => { if (!seen || seen[n.id] === stamp(n)) return; seen[n.id] = stamp(n); localStorage.setItem(SEEN, JSON.stringify(seen)); };
	function counts() { const live = notes.filter(alive), open = live.filter(isOpenN).length; $('#sideBtn').classList.toggle('new', live.some(unread)); $('#sideN').textContent = open || ''; $('#nNotes3').textContent = live.length ? `${open} open` + (open < live.length ? ` · ${live.length - open} closed` : '') : ''; }
	function audioUi() { $('#audioBtn').title = (v.muted ? 'Sound off' : 'Sound on') + ' (M)'; $('#waves').style.display = v.muted ? 'none' : ''; $('#mute').style.display = v.muted ? '' : 'none'; }
	$('#audioBtn').onclick = () => { v.muted = !v.muted; localStorage.setItem('vl:muted', v.muted ? '1' : '0'); audioUi(); };
	audioUi();
	// the notes panel opens and closes (S); it opens again whenever you start writing or pick a note
	function side(open) {
		document.documentElement.classList.toggle('side-off', !open);
		localStorage.setItem('vl:side', open ? '1' : '0');
		$('#sideBtn').title = (open ? 'Hide notes' : 'Show notes') + ' (S)';
	}
	side(!document.documentElement.classList.contains('side-off'));
	$('#sideBtn').onclick = () => side(document.documentElement.classList.contains('side-off'));
	$('.insp').addEventListener('focusin', () => side(true));
	$('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = t; localStorage.setItem('vl:theme', t); };
	$('#mcpBtn').onclick = (e) => { e.stopPropagation(); $('#mcpPop').classList.toggle('on'); };
	document.addEventListener('click', (e) => { if (!e.target.closest('#mcpPop')) $('#mcpPop').classList.remove('on'); });
	// how to add the MCP server, per agent; "Any agent" lets add-mcp find the installed ones and write each one's config
	const MCP_JSON = JSON.stringify({ mcpServers: { 'telestrator': { command: 'npx', args: ['-y', 'telestrator', 'mcp'] } } }, null, 2);
	const AGENTS = [
		{ id: 'any', name: 'Any agent', cmd: 'npx add-mcp@2.4.0 "npx -y telestrator mcp" --name telestrator -g', hint: 'Finds the agents you have (Claude Code, Codex, Cursor, VS Code, Gemini, Windsurf, OpenCode…) and adds it to each one you pick.' },
		{ id: 'claude', name: 'Claude Code', cmd: 'claude mcp add --scope user telestrator -- npx -y telestrator mcp', hint: 'Then start a new Claude Code session.' },
		{ id: 'codex', name: 'Codex', cmd: 'codex mcp add telestrator -- npx -y telestrator mcp', hint: 'Then start a new Codex session.' },
		{ id: 'cursor', name: 'Cursor', cmd: MCP_JSON, json: true, hint: 'Paste into ~/.cursor/mcp.json (merge with any servers already there).' },
		{ id: 'vscode', name: 'VS Code', cmd: `code --add-mcp '{"name":"telestrator","command":"npx","args":["-y","telestrator","mcp"]}'`, hint: 'Adds it to your VS Code profile, for Copilot agent mode.' },
		{ id: 'gemini', name: 'Gemini CLI', cmd: 'gemini mcp add -s user telestrator npx -- -y telestrator mcp', hint: 'Then start a new Gemini session.' },
		{ id: 'other', name: 'Other', cmd: MCP_JSON, json: true, hint: 'Any MCP client: a stdio server, command npx, args -y telestrator mcp.' }
	];
	let agent = AGENTS.find((a) => a.id === localStorage.getItem('vl:agent')) || AGENTS[0];
	const logo = (id) => {
		const l = window.VL_LOGOS[id];
		return `<svg class="lg" viewBox="0 0 24 24" ${l.stroke ? 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' : `fill="${l.fill}"`}><path d="${l.d}"/></svg>`;
	};
	$('#mcpMenu').innerHTML = AGENTS.map((a) => `<button data-a="${a.id}">${logo(a.id)}${a.name}</button>`).join('');
	function agentUi() {
		for (const b of $('#mcpMenu').children) b.classList.toggle('on', b.dataset.a === agent.id);
		$('#mcpCur').innerHTML = logo(agent.id) + agent.name;
		$('#mcpCmd').textContent = agent.cmd;
		$('#mcpHint').textContent = agent.hint;
		$('#mcpCopy').textContent = agent.json ? 'Copy config' : 'Copy command';
	}
	$('#mcpPick').onclick = () => $('#mcpDd').classList.toggle('open');
	$('#mcpMenu').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; agent = AGENTS.find((a) => a.id === b.dataset.a); localStorage.setItem('vl:agent', agent.id); $('#mcpDd').classList.remove('open'); agentUi(); };
	document.addEventListener('click', (e) => { if (!e.target.closest('#mcpDd')) $('#mcpDd').classList.remove('open'); });
	agentUi();
	$('#mcpCopy').onclick = async () => { await copyText(agent.cmd); toast(agent.json ? 'Config copied — paste it into the file' : 'Command copied — run it in your terminal'); };
	$('#showResolved').checked = localStorage.getItem('vl:showResolved') === '1';
	$('#showResolved').onchange = () => { localStorage.setItem('vl:showResolved', $('#showResolved').checked ? '1' : '0'); renderList(); renderMarks(); };
	const visible = () => notes.filter((n) => alive(n) && ($('#showResolved').checked || isOpenN(n)));

	// H hides the markers of saved notes on the frame (pins and drawings), to see the picture clean
	function toggleMarks() {
		document.body.classList.toggle('nomarks');
		renderInk(true);
	}

	// ---- viewer: fit the stage (the video's aspect) inside the viewer body ------------------------------------------------
	function fitStage() {
		const b = $('#vbody'), w = b.clientWidth - 30, h = b.clientHeight - 30;
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
			vl = comp.contentWindow && comp.contentWindow.__telestrator;
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
		try { vl.seek(Math.min(t, DUR - 0.001)); } catch (e) { console.warn('[telestrator] seek failed', e); }
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
		return { node: e, path: cssPath(e), text, near, tag: e.tagName.toLowerCase(), box: { x: Math.round(r.left * kx), y: Math.round(r.top * ky), w: Math.round(r.width * kx), h: Math.round(r.height * ky) } };
	}
	// the element's styles on this frame, so "too small" comes with how big it is now
	const hex = (c) => {
		const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c);
		if (!m) return c;
		const h = '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
		return m[4] != null && +m[4] < 1 ? `${h} @ ${Math.round(+m[4] * 100)}%` : h;
	};
	function stylesOf(e) {
		try {
			const cs = comp.contentWindow.getComputedStyle(e), out = {};
			const plain = { opacity: '1', transform: 'none', 'border-radius': '0px', 'letter-spacing': 'normal', 'background-color': 'rgba(0, 0, 0, 0)', 'text-shadow': 'none' };
			for (const k of ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'opacity', 'transform', 'border-radius', 'text-shadow']) {
				let val = cs.getPropertyValue(k);
				if (!val || plain[k] === val) continue;
				if (k === 'font-family') val = val.split(',')[0].replace(/["']/g, '').trim();
				if (k.endsWith('color')) val = hex(val);
				out[k] = val;
			}
			return out;
		} catch { return null; }
	}
	// where the element is written in the composition's HTML: its opening tag's line, or the nearest ancestor's that we can find
	let compSrc = null;
	if (P.composition) fetch(P.composition).then((r) => r.text()).then((t) => (compSrc = t)).catch(() => {});
	function findSource(el) {
		if (!compSrc) return null;
		const file = decodeURIComponent(P.composition.replace(/^\/comp\//, ''));
		const attr = (a, name) => (new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(a) || [])[1];
		for (let e = el, up = 0; e && up < 6 && e.tagName !== 'BODY' && e.tagName !== 'HTML'; e = e.parentElement, up++) {
			const tag = e.tagName.toLowerCase();
			const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean) : [];
			if (!e.id && !cls.length) continue;
			// the source tags that are this element: same id, or classes that are all on it (scripts may add more later)
			const hits = [];
			const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
			for (let m; (m = re.exec(compSrc)); ) {
				const id = attr(m[1], 'id'), sc = (attr(m[1], 'class') || '').split(/\s+/).filter(Boolean);
				if (e.id ? id === e.id : sc.length && sc.every((c) => cls.includes(c))) hits.push(m.index);
			}
			if (!hits.length) continue;
			// the n-th such tag in the source is the n-th such element on the page
			const same = e.id ? [e] : [...comp.contentDocument.querySelectorAll(tag + '.' + CSS.escape(cls[0]))];
			const at = hits[Math.min(Math.max(0, same.indexOf(e)), hits.length - 1)];
			return { file, line: compSrc.slice(0, at).split('\n').length, ...(e !== el ? { via: `inside ${e.id ? '#' + e.id : tag + '.' + cls.join('.')}` } : {}) };
		}
		return null;
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
		const el = d ? { path: d.path, text: d.text, near: d.near, box: d.box, tag: d.tag } : null;
		if (d) {
			const classes = typeof d.node.className === 'string' ? d.node.className.trim() : '';
			if (classes) el.classes = classes;
			const styles = stylesOf(d.node), source = findSource(d.node);
			if (styles && Object.keys(styles).length) el.styles = styles;
			if (source) el.source = source;
		}
		draft = { ink: draft.ink, t: +v.currentTime.toFixed(3), fx: x / W, fy: y / H, el };
		hideSel();
		setMode(null);
		$('#cmText').focus();
	});
	// the composer's two tools: 'point' (click something) and 'draw' (on the frame); null = the frame plays/pauses
	function setMode(m) {
		if (m !== 'draw') closeText(true);
		mode = m;
		if (m) side(true);
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
	// { k: 'pen', c, pts } · { k: 'arrow' | 'box', c, a, b } · { k: 'text', c, at, s }; w scales the stroke (or the text), 1 if absent
	let cur = null, inkKey = '', inkTool = 'pen', inkColor = '#ff4f8b', inkW = 1;
	const SIZES = [0.6, 1, 1.8];
	const COLOR = { '#ff4f8b': 'pink', '#ff453a': 'red', '#ffd60a': 'yellow', '#32d74b': 'green', '#0a84ff': 'blue', '#ffffff': 'white' };
	document.querySelectorAll('#drawbar .tool[data-tool]').forEach((b) => (b.onclick = () => {
		closeText(true);
		inkTool = b.dataset.tool;
		document.querySelectorAll('#drawbar .tool[data-tool]').forEach((x) => x.classList.toggle('on', x === b));
		document.body.classList.toggle('tool-text', inkTool === 'text');
		document.body.classList.toggle('tool-erase', inkTool === 'erase');
	}));
	// the size button cycles thin · regular · thick
	$('#inkSize').onclick = () => { inkW = SIZES[(SIZES.indexOf(inkW) + 1) % SIZES.length]; $('#inkSize').dataset.w = SIZES.indexOf(inkW); $('#inkSize').title = ['Thin', 'Regular', 'Thick'][SIZES.indexOf(inkW)] + ' stroke'; if (tIn.style.display === 'block') { tIn.style.fontSize = FS * inkW * scale() + 'px'; tIn.focus(); } };
	// the eraser removes the mark nearest where you click (in the note being written)
	function hitShape(p) {
		const tol = SW * 3, dSeg = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, u = l ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l)) : 0; return Math.hypot(q[0] - a[0] - u * dx, q[1] - a[1] - u * dy); };
		const list = draft.ink || [];
		for (let i = list.length - 1; i >= 0; i--) {
			const sh = list[i];
			let d = Infinity;
			if (sh.k === 'pen') for (let j = 1; j < sh.pts.length; j++) d = Math.min(d, dSeg(p, sh.pts[j - 1], sh.pts[j]));
			else if (sh.k === 'arrow') d = dSeg(p, sh.a, sh.b);
			else if (sh.k === 'box') { const [x0, y0, x1, y1] = [Math.min(sh.a[0], sh.b[0]), Math.min(sh.a[1], sh.b[1]), Math.max(sh.a[0], sh.b[0]), Math.max(sh.a[1], sh.b[1])]; d = Math.min(dSeg(p, [x0, y0], [x1, y0]), dSeg(p, [x1, y0], [x1, y1]), dSeg(p, [x1, y1], [x0, y1]), dSeg(p, [x0, y1], [x0, y0])); }
			else if (sh.k === 'text') { const f = FS * (sh.w || 1); d = p[0] >= sh.at[0] - tol && p[0] <= sh.at[0] + sh.s.length * f * 0.62 + tol && p[1] >= sh.at[1] - tol && p[1] <= sh.at[1] + f + tol ? 0 : Infinity; }
			if (d <= tol * (sh.w || 1)) return i;
		}
		return -1;
	}
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
		if (inkTool === 'erase') { const i = hitShape(p); if (i >= 0) { draft.ink.splice(i, 1); if (!draft.ink.length) delete draft.ink; renderInk(true); renderComposer(); } return; }
		ink.setPointerCapture(ev.pointerId);
		cur = inkTool === 'pen' ? { k: 'pen', c: inkColor, pts: [p] } : { k: inkTool, c: inkColor, a: p, b: p };
		if (inkW !== 1) cur.w = inkW;
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
		if (cur.k !== 'pen' && Math.hypot(cur.b[0] - cur.a[0], cur.b[1] - cur.a[1]) < SW * 1.5 * (cur.w || 1)) { draft.ink.pop(); if (!draft.ink.length) delete draft.ink; }
		cur = null;
		renderInk(true); renderComposer();
	};
	ink.addEventListener('pointerup', endShape);
	ink.addEventListener('pointercancel', endShape);
	// text: a field on the frame where you clicked, in the colour you picked; Enter or clicking away places it
	function openText(p) {
		const k = scale();
		Object.assign(tIn.style, { display: 'block', left: p[0] * k + 'px', top: p[1] * k - 2 + 'px', fontSize: FS * inkW * k + 'px', color: inkColor, borderColor: inkColor });
		tIn.value = ''; tIn.size = 4; tIn.dataset.at = p.join(','); tIn.dataset.c = inkColor;
		setTimeout(() => tIn.focus(), 0);
	}
	function closeText(keep) {
		if (tIn.style.display !== 'block') return;
		const txt = tIn.value.trim();
		tIn.style.display = 'none';
		if (keep && txt) { const sh = { k: 'text', c: inkColor, at: tIn.dataset.at.split(',').map(Number), s: txt }; if (inkW !== 1) sh.w = inkW; draft.ink = [...(draft.ink || []), sh]; renderInk(true); renderComposer(); }
	}
	tIn.addEventListener('input', () => (tIn.size = Math.max(4, tIn.value.length + 1)));
	tIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') closeText(true); else if (e.key === 'Escape') closeText(false); e.stopPropagation(); });
	tIn.addEventListener('blur', () => closeText(true));
	function shapeSvg(sh, attrs = '', hit = false) {
		const st = `${attrs} style="${hit ? `stroke:transparent;stroke-width:${SW * 4}` : `stroke:${sh.c};stroke-width:${SW * (sh.w || 1)}`}"`;
		if (sh.k === 'pen') return `<path ${st} d="M${sh.pts.map((q) => q.join(' ')).join('L')}"/>`;
		if (sh.k === 'box') return `<rect ${st} rx="${SW * 1.4}" x="${Math.min(sh.a[0], sh.b[0])}" y="${Math.min(sh.a[1], sh.b[1])}" width="${Math.abs(sh.b[0] - sh.a[0])}" height="${Math.abs(sh.b[1] - sh.a[1])}"/>`;
		if (sh.k === 'arrow') {
			const [x1, y1] = sh.a, [x2, y2] = sh.b, an = Math.atan2(y2 - y1, x2 - x1), L = SW * 4.3;
			const h1 = [x2 - L * Math.cos(an - 0.5), y2 - L * Math.sin(an - 0.5)], h2 = [x2 - L * Math.cos(an + 0.5), y2 - L * Math.sin(an + 0.5)];
			return `<path ${st} d="M${x1} ${y1}L${x2} ${y2}M${h1.join(' ')}L${x2} ${y2}L${h2.join(' ')}"/>`;
		}
		if (sh.k === 'text') return hit ? '' : `<text ${attrs} x="${sh.at[0]}" y="${sh.at[1]}" style="fill:${sh.c}${sh.w ? `;font-size:${FS * sh.w}px` : ''}">${esc(sh.s)}</text>`;
		return '';
	}
	// the draft's shapes, plus the saved drawings of any note sitting on this frame
	function renderInk(force) {
		const t = v.currentTime;
		const marks = !document.body.classList.contains('nomarks');
		const vis = marks ? visible().filter((n) => n.ink && Math.abs(n.t - t) < 0.25 && (!editing || n.id !== editing.id)) : [];
		const k = vis.map((n) => n.id).join() + '|' + JSON.stringify(draft.ink || []);
		if (k === inkKey && !force) return;
		inkKey = k;
		ink.innerHTML = vis.flatMap((n) => n.ink.map((sh) => shapeSvg(sh, `data-note="${n.id}"`) + shapeSvg(sh, `data-note="${n.id}" class="hit"`, true))).join('') + (draft.ink || []).map((sh, i) => shapeSvg(sh, `data-d="${i}"`)).join('');
	}
	// clicking a saved drawing on the frame picks its note, like clicking a pin
	ink.addEventListener('click', (ev) => {
		const s = ev.target.closest && ev.target.closest('[data-note]');
		if (!s || mode) return;
		ev.stopPropagation(); select(s.dataset.note);
	});
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
		$('#cmScene').textContent = sceneLabel(sceneAt(t));
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
		const fresh = !editing || n.ink || n.fx != null;
		n.thumb = fresh ? await grab(n) : editing.thumb;
		n.thumbAt = fresh ? new Date().toISOString() : editing.thumbAt || editing.created;
		const wasEdit = !!editing;
		try {
			const saved = await api('/api/notes', 'POST', n);
			markSeen(saved);
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
				g.strokeStyle = g.fillStyle = sh.c; g.lineWidth = Math.max(2, SW * (sh.w || 1) * k);
				g.beginPath();
				if (sh.k === 'pen') sh.pts.forEach((q, i) => g[i ? 'lineTo' : 'moveTo'](q[0] * k, q[1] * k));
				else if (sh.k === 'box') g.rect(Math.min(sh.a[0], sh.b[0]) * k, Math.min(sh.a[1], sh.b[1]) * k, Math.abs(sh.b[0] - sh.a[0]) * k, Math.abs(sh.b[1] - sh.a[1]) * k);
				else if (sh.k === 'arrow') {
					const an = Math.atan2(sh.b[1] - sh.a[1], sh.b[0] - sh.a[0]), L = SW * 4.3 * k;
					g.moveTo(sh.a[0] * k, sh.a[1] * k); g.lineTo(sh.b[0] * k, sh.b[1] * k);
					g.moveTo(sh.b[0] * k - L * Math.cos(an - 0.5), sh.b[1] * k - L * Math.sin(an - 0.5)); g.lineTo(sh.b[0] * k, sh.b[1] * k); g.lineTo(sh.b[0] * k - L * Math.cos(an + 0.5), sh.b[1] * k - L * Math.sin(an + 0.5));
				} else if (sh.k === 'text') { g.font = `700 ${FS * (sh.w || 1) * k}px -apple-system, sans-serif`; g.textBaseline = 'top'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(sh.s, sh.at[0] * k, sh.at[1] * k); g.fillText(sh.s, sh.at[0] * k, sh.at[1] * k); continue; }
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
		const a = activeId && notes.find((x) => x.id === activeId), box = $('#elBox');
		if (a && a.el && a.el.box && Math.abs(a.t - v.currentTime) < 0.25 && alive(a) && (!editing || editing.id !== a.id) && ($('#showResolved').checked || isOpenN(a))) {
			const k = scale();
			Object.assign(box.style, { display: 'block', left: a.el.box.x * k + 'px', top: a.el.box.y * k + 'px', width: a.el.box.w * k + 'px', height: a.el.box.h * k + 'px' });
		} else box.style.display = 'none';
		overlay.querySelectorAll('.pin').forEach((p) => p.remove());
		const t = v.currentTime;
		const d = draft.fx != null ? draft : null;
		const show = [...visible().filter((n) => n.fx != null && (!editing || n.id !== editing.id)), ...(d ? [d] : [])];
		show.forEach((n) => {
			if (Math.abs(n.t - t) >= 0.25 && n !== d) return;
			const p = document.createElement('div');
			p.className = n === d ? 'pin draft' : 'pin';
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
		pps = (scroll.clientWidth - 18) / DUR;
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
			if (big) { const l = document.createElement('div'); l.className = 'lab'; l.style.left = t2px(t) + 'px'; const r = Math.round(t * 10) / 10, sec = Math.round(r); l.textContent = r < 60 ? `${r}s` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; ruler.appendChild(l); }
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
		const TH = 60 - 8 - 2, TW = (TH * W) / H;
		document.querySelectorAll('.clip.pic').forEach((e) => {
			const s = scenes()[+e.dataset.i], a = s.start, w = t2px(sceneEnd(s) - a);
			let html = '';
			for (let x = 0; x < w; x += TW) html += `<span style="width:${TW}px;background:${frameBg(a + (x + TW / 2) / pps, TW, TH)}"></span>`;
			e.querySelector('.strip').innerHTML = html;
		});
	}
	// the comments track: every note is the same tag. A moment is a round marker on its frame; moments too close to tell apart
	// share one marker with a count. A range is the tag stretched over its stretch, with the text if it fits; the selected one
	// gets trim handles. Hovering any of them previews the note.
	function renderMarks() {
		const row = $('#rowNotes');
		row.innerHTML = '';
		const kindOf = (n) => (n.kind === 'range' ? 'rg' : n.kind === 'time' ? 'tm' : n.kind === 'draw' ? 'dw' : 'pt');
		const shown = visible(), groups = [];
		shown.filter((n) => n.kind !== 'range').sort((a, b) => a.t - b.t).forEach((n) => {
			const g = groups[groups.length - 1];
			if (g && t2px(n.t) - t2px(g[0].t) < 22) g.push(n); else groups.push([n]);
		});
		const mk = (list, k) => {
			const e = document.createElement('div'), n = list[0], i = notes.indexOf(n);
			e.className = 'mk ' + k + (list.some((x) => x.id === activeId) ? ' on' : '') + (list.some(unread) ? ' new' : '');
			e.style.left = t2px(n.t) + 'px';
			if (!list.some(isOpenN)) e.style.opacity = '0.45';
			e.onmouseenter = () => showTip(e, list);
			e.onmouseleave = hideTip;
			row.appendChild(e);
			return { e, n, i };
		};
		groups.forEach((list) => {
			const { e, n, i } = mk(list, kindOf(list[0]));
			e.innerHTML = `<b>${n.ink ? '✎ ' : ''}${i + 1}</b>${list.length > 1 ? `<em>+${list.length - 1}</em>` : ''}`;
			// a shared marker: each click picks the next note in it
			e.onmousedown = (ev) => { ev.stopPropagation(); hideTip(); const j = list.findIndex((x) => x.id === activeId); select(list[(j + 1) % list.length].id); };
		});
		shown.filter((n) => n.kind === 'range').forEach((n) => {
			const { e, i } = mk([n], 'rg');
			e.style.width = Math.max(22, t2px(n.t2 - n.t)) + 'px';
			e.innerHTML = `<b>${i + 1}</b><span>${esc(n.text)}</span>${n.id === activeId ? '<i class="trim l" title="Drag to move the start"></i><i class="trim r" title="Drag to move the end"></i>' : ''}`;
			e.onmousedown = (ev) => {
				ev.stopPropagation(); hideTip();
				const side = ev.target.classList.contains('trim') ? (ev.target.classList.contains('l') ? 't' : 't2') : null;
				if (side) { ev.preventDefault(); trim = { n, side, e, t: n.t, t2: n.t2 }; v.pause(); return; }
				select(n.id);
			};
		});
	}
	// the note preview over a marker: its frame, number, time, status and text
	const tip = $('#mkTip');
	function showTip(e, list) {
		if (drag || trim) return;
		tip.innerHTML = list.slice(0, 3).map((n) => {
			const i = notes.indexOf(n), st = n.status || 'open';
			const when = n.kind === 'range' ? `${tcode(n.t).slice(3)}–${tcode(n.t2).slice(3)}` : tcode(n.t).slice(3);
			return `<div class="tp">${n.thumb ? `<img src="${n.thumb}">` : '<span class="noimg"></span>'}<div><div class="tp-hd"><span class="n ${n.kind === 'range' ? 'r' : n.kind === 'time' ? 't' : ''}">${i + 1}</span>${when}${st !== 'open' ? ` · ${st}` : ''}${unread(n) ? ' · <u>new reply</u>' : ''}</div><div class="tp-tx">${esc(n.text)}</div></div></div>`;
		}).join('') + (list.length > 3 ? `<div class="tp-more">+${list.length - 3} more</div>` : '');
		tip.classList.add('on');
		const r = e.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
		tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
		tip.style.top = r.top - h - 10 + 'px';
	}
	function hideTip() { tip.classList.remove('on'); }
	// trimming a range: the edge follows the mouse (the frame too), and the note is saved with its new stretch on release
	let trim = null;
	async function saveTrim(n) {
		seek(n.t);
		await new Promise((ok) => (v.seeking ? v.addEventListener('seeked', ok, { once: true }) : ok()));
		const s = sceneAt(n.t);
		const shot = await grab(n);
		Object.assign(n, { scene: s.id || s.name, said: said(n.t, n.t2) }, shot ? { thumb: shot, thumbAt: new Date().toISOString() } : {});
		try { await api('/api/notes', 'POST', n); toast('Range updated'); } catch (e) { toast('Could not save: ' + e.message); }
		await refresh(true);
	}
	new ResizeObserver(() => buildTimeline()).observe(scroll);

	// the ruler and the filmstrip scrub; dragging along the comments track draws a range there, like the comment it becomes
	let drag = null;
	const sel = $('#sel');
	function hideSel() { sel.style.display = 'none'; }
	const xIn = (ev) => Math.max(0, Math.min(inner.clientWidth, ev.clientX - inner.getBoundingClientRect().left));
	inner.addEventListener('mousedown', (ev) => {
		if (ev.button !== 0) return;
		ev.preventDefault();
		drag = { x0: xIn(ev), moved: false, scrubOnly: !ev.target.closest('#rowNotes') };
		if (draft.t2 != null) { draft = {}; hideSel(); }
		v.pause();
		seek(px2t(drag.x0));
	});
	window.addEventListener('mousemove', (ev) => {
		const b = scroll.getBoundingClientRect(), hov = $('#hover');
		if (ev.clientY >= b.top && ev.clientY <= b.bottom && ev.clientX >= b.left && ev.clientX <= b.right) { hov.style.display = 'block'; hov.style.left = xIn(ev) + 'px'; } else hov.style.display = 'none';
		if (trim) {
			const t = +px2t(xIn(ev)).toFixed(3);
			if (trim.side === 't') trim.t = Math.min(t, trim.t2 - 0.1); else trim.t2 = Math.max(t, trim.t + 0.1);
			Object.assign(trim.e.style, { left: t2px(trim.t) + 'px', width: Math.max(22, t2px(trim.t2 - trim.t)) + 'px' });
			seek(trim.side === 't' ? trim.t : trim.t2);
			return;
		}
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
		if (trim) { const { n, t, t2 } = trim; trim = null; if (t !== n.t || t2 !== n.t2) { n.t = t; n.t2 = t2; saveTrim(n); } return; }
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
		$('#tc').innerHTML = DUR < 3600 ? `${code.slice(3)} <span class="of">/ ${tcode(DUR).slice(3)}</span>` : `${code} <span class="of">/ ${tcode(DUR)}</span>`;
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
		else if (e.key === 'ArrowDown') { e.preventDefault(); e.shiftKey ? stepNote(1) : stepScene(1); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); e.shiftKey ? stepNote(-1) : stepScene(-1); }
		else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); v.pause(); $('#cmText').focus(); }
		else if (e.key === 'p' || e.key === 'P') setMode(mode === 'point' ? null : 'point');
		else if (e.key === 'd' || e.key === 'D') setMode(mode === 'draw' ? null : 'draw');
		else if (e.key === 'm' || e.key === 'M') $('#audioBtn').click();
		else if (e.key === 'h' || e.key === 'H') toggleMarks();
		else if (e.key === 's' || e.key === 'S') $('#sideBtn').click();
		else if (e.key === 'f' || e.key === 'F') $('#fs').click();
		else if (e.key === 'Escape') { if (mode) setMode(null); else { draft = {}; hideSel(); renderComposer(); renderInk(true); } }
	});

	// ---- notes list: statuses and the thread with your agent -----------------------------------------------------------------------
	// the next or previous note in time, from the selected one, or from the playhead
	function stepNote(d) {
		const list = visible().slice().sort((a, b) => a.t - b.t);
		if (!list.length) return;
		const i = list.findIndex((n) => n.id === activeId), t = v.currentTime;
		let j = i >= 0 ? i + d : d > 0 ? list.findIndex((n) => n.t > t + 1e-3) : list.map((n) => n.t < t - 1e-3).lastIndexOf(true);
		if (j < 0 || j >= list.length) j = d > 0 ? list.length - 1 : 0;
		select(list[j].id);
	}
	function edit(n) {
		v.pause(); seek(n.t);
		editing = n;
		draft = { t: n.t, t2: n.t2, fx: n.fx, fy: n.fy, el: n.el, ink: n.ink ? JSON.parse(JSON.stringify(n.ink)) : undefined };
		$('#cmText').value = n.text; renderComposer(); $('#cmText').focus();
	}
	function remove(n) {
		if (activeId === n.id) activeId = null;
		if (editing && editing.id === n.id) resetComposer();
		gone.set(n.id, setTimeout(() => { gone.delete(n.id); notes = notes.filter((x) => x.id !== n.id); api(`/api/notes/${n.id}`, 'DELETE').catch((e) => { toast('Could not delete: ' + e.message); refresh(true); }); counts(); renderList(); renderMarks(); }, 5000));
		counts(); renderList(); renderMarks();
		toast('Note deleted', { label: 'Undo', run: () => { clearTimeout(gone.get(n.id)); gone.delete(n.id); counts(); renderList(); renderMarks(); } });
	}
	// deletes still waiting on their Undo happen now: before copying, or when the page goes away
	function flushGone(keepalive) {
		const done = [];
		for (const [id, t] of gone) { clearTimeout(t); gone.delete(id); notes = notes.filter((x) => x.id !== id); done.push(fetch(`/api/notes/${id}`, { method: 'DELETE', keepalive: !!keepalive }).catch(() => {})); }
		return Promise.all(done);
	}
	window.addEventListener('pagehide', () => flushGone(true));
	// the frame at a note's time in the video as it is now, for Before / Now once the video has been re-rendered
	const LOADED = +((/[?&]v=(\d+)/.exec(P.video) || [])[1] || 0), nowShots = new Map();
	const rerendered = (n) => { const at = Date.parse(n.thumbAt || n.created); return !!n.thumb && at > 0 && LOADED > at + 1000; };
	async function nowShot(n) {
		const key = n.id + '@' + n.t;
		if (nowShots.has(key)) return nowShots.get(key);
		if (v.seeking) await new Promise((ok) => v.addEventListener('seeked', ok, { once: true }));
		if (Math.abs(v.currentTime - n.t) > 0.05) return null;
		const c = document.createElement('canvas'); c.width = 320; c.height = Math.round((320 * H) / W);
		c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
		const url = c.toDataURL('image/jpeg', 0.8);
		nowShots.set(key, url);
		return url;
	}
	function select(id) {
		activeId = id;
		side(true);
		const n = notes.find((x) => x.id === id);
		if (n) { v.pause(); seek(n.t); markSeen(n); }
		counts(); renderList(); renderMarks();
	}
	function renderList() {
		const list = $('#list');
		const shown = visible();
		if (!shown.length) {
			list.innerHTML = notes.some(alive)
				? '<div class="empty">Every note is closed. Tick <b>Show resolved</b> to see them.</div>'
				: `<div class="empty">Write above: a note lands at the playhead. <b>Point</b> (P) attaches ${vl ? 'the element you click' : 'a spot'} in the frame, <b>Draw</b> (D) marks it up, and <b>dragging along the comments track</b> makes a range.<br><br>Your agent reads these over MCP (<b>Connect agent</b>), or <b>Copy for agent</b> and paste.</div>`;
			return;
		}
		const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.reply');
		if (focused) return; // don't yank the reply box while it's being typed in
		list.innerHTML = '';
		shown.forEach((n) => {
			const i = notes.indexOf(n);
			const st = n.status || 'open';
			const open = isOpenN(n);
			const e = document.createElement('div');
			e.className = 'note ' + st + (n.id === activeId ? ' active' : '');
			const when = n.kind === 'range' ? `${tcode(n.t).slice(3)}–${tcode(n.t2).slice(3)}` : tcode(n.t).slice(3);
			const cls = n.kind === 'range' ? 'r' : n.kind === 'time' ? 't' : '';
			const s = sceneAt(n.t);
			if (n.id === activeId && !document.documentElement.classList.contains('side-off')) markSeen(n);
			const isNew = unread(n);
			e.innerHTML = `${n.thumb ? `<img src="${n.thumb}">` : '<div class="noimg"></div>'}<div style="min-width:0"><div class="hd"><span class="n ${cls}">${i + 1}</span><span class="tcs">${when}</span>${isNew ? '<span class="new" title="New from your agent"></span>' : ''}${st !== 'open' ? `<span class="st ${st}">${st}</span>` : `<span class="scn">${esc(scenes().length > 1 ? s.name : '')}</span>`}<span class="acts"><button class="ed" title="Edit"><svg viewBox="0 0 24 24"><path d="M4 20l4-1 10-10-3-3L5 16z"/></svg></button><button class="x" title="Delete">×</button></span></div><div class="txt"></div>${n.fx != null || n.ink ? `<div class="el"></div>` : ''}${n.by === 'agent' ? '<div class="tags"><span class="tagp agent">from agent</span></div>' : ''}</div>`;
			e.querySelector('.txt').textContent = n.text;
			if (n.fx != null || n.ink) e.querySelector('.el').textContent = [n.fx != null && '◎ ' + (n.el ? elLabel(n.el) : `spot ${Math.round(n.fx * W)},${Math.round(n.fy * H)}`), n.ink && '✎ ' + ((n.inkInfo && n.inkInfo.shapes[0]) || 'drawing')].filter(Boolean).join(' · ');
			if ((n.thread || []).length) {
				const th = document.createElement('div');
				th.className = 'thread';
				th.innerHTML = n.thread.map((m) => `<div class="msg ${m.from === 'agent' ? 'agent' : ''}"><i>${m.from === 'agent' ? 'Agent' : 'You'}${m.at ? `<span class="ago" data-at="${esc(m.at)}">${ago(m.at)}</span>` : ''}</i>${esc(m.text)}</div>`).join('');
				e.appendChild(th);
			}
			if (n.id === activeId && rerendered(n)) {
				// the note's frame when you wrote it, and the same moment in the video as it is now
				const c = document.createElement('div');
				c.className = 'cmp';
				c.innerHTML = `<figure><img src="${n.thumb}"><figcaption>Before</figcaption></figure><figure><img class="now"><figcaption>Now</figcaption></figure>`;
				nowShot(n).then((url) => { if (url) c.querySelector('.now').src = url; });
				e.appendChild(c);
			}
			if (n.id === activeId) {
				const r = document.createElement('div');
				r.className = 'reply';
				r.innerHTML = `<textarea rows="1" placeholder="${n.thread && n.thread.length ? 'Reply…' : 'Add to this note…'}"></textarea><button class="btn" data-a="reply">Send</button><button class="btn ghost" data-a="status">${open ? 'Resolve' : 'Reopen'}</button>`;
				const input = r.querySelector('textarea');
				// grows with what you write; Enter sends, Shift+Enter starts a new line
				const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
				const send = async () => { const t = input.value.trim(); if (!t) return; input.value = ''; grow(); await api(`/api/notes/${n.id}/reply`, 'POST', { text: t }); input.blur(); await refresh(true); };
				input.addEventListener('input', grow);
				input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } else if (ev.key === 'Escape') input.blur(); ev.stopPropagation(); });
				r.querySelector('[data-a=reply]').onclick = (ev) => { ev.stopPropagation(); send(); };
				r.querySelector('[data-a=status]').onclick = async (ev) => { ev.stopPropagation(); await api(`/api/notes/${n.id}/status`, 'POST', { status: open ? 'resolved' : 'open' }); await refresh(true); const x = notes.find((y) => y.id === n.id); if (x) markSeen(x); counts(); renderMarks(); };
				r.onclick = (ev) => ev.stopPropagation();
				e.appendChild(r);
			}
			e.onclick = () => select(n.id);
			e.ondblclick = (ev) => { if (!ev.target.closest('.reply')) edit(n); };
			e.title = 'Double-click to edit · ⇧↑ ⇧↓ move between notes';
			e.querySelector('.ed').onclick = (ev) => { ev.stopPropagation(); edit(n); };
			e.querySelector('.x').onclick = (ev) => { ev.stopPropagation(); remove(n); };
			list.appendChild(e);
		});
		const a = list.querySelector('.note.active'); if (a) a.scrollIntoView({ block: 'nearest' });
	}
	// a confirm dialog in the app's own style; Enter confirms, Esc or a click outside cancels, and no shortcut leaks through
	function ask(title, body, yes) {
		const m = $('#modal');
		$('#modalTitle').textContent = title; $('#modalBody').textContent = body; $('#modalYes').textContent = yes;
		const back = document.activeElement;
		m.classList.add('on');
		$('#modalYes').focus();
		return new Promise((ok) => {
			const done = (v) => { m.classList.remove('on'); window.removeEventListener('keydown', key, true); m.onclick = $('#modalYes').onclick = $('#modalNo').onclick = null; if (back && back.focus) back.focus(); ok(v); };
			const key = (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter') { e.preventDefault(); done(document.activeElement !== $('#modalNo')); } };
			window.addEventListener('keydown', key, true);
			m.onclick = (e) => { if (e.target === m) done(false); };
			$('#modalYes').onclick = () => done(true);
			$('#modalNo').onclick = () => done(false);
		});
	}
	$('#clear').onclick = async () => {
		if (!notes.length) return;
		if (!(await ask('Delete all notes?', `This removes all ${notes.length} note${notes.length > 1 ? 's' : ''} on this video, with their replies. It can’t be undone.`, 'Delete all'))) return;
		gone.forEach(clearTimeout); gone.clear();
		await api('/api/notes', 'DELETE'); notes = []; counts(); renderList(); renderMarks();
	};

	// ---- sync with the file: your agent may reply or resolve while this is open ---------------------------------------------------
	async function refresh(force) {
		const r = await fetch('/api/review').then((x) => x.json()).catch(() => null);
		if (!r || !Array.isArray(r.notes)) return;
		// a re-render of the video: offer to load it once the file has stopped changing
		if (r.videoStamp && LOADED && r.videoStamp !== LOADED) {
			if (refresh.last === r.videoStamp && refresh.told !== r.videoStamp) { refresh.told = r.videoStamp; toast('The video was re-rendered', { label: 'Reload', ms: 12000, run: () => location.reload() }); }
			refresh.last = r.videoStamp;
		}
		if (!force && r.updated === updated) return;
		const agentMoved = updated && (r.notes || []).some((n) => { const o = notes.find((x) => x.id === n.id); return o ? (o.thread || []).length !== (n.thread || []).length || o.status !== n.status : n.by === 'agent'; });
		updated = r.updated;
		notes = r.notes || [];
		if (!seen) { seen = {}; notes.forEach((n) => (seen[n.id] = stamp(n))); localStorage.setItem(SEEN, JSON.stringify(seen)); }
		counts(); renderList(); renderMarks();
		if (agentMoved && !force) toast('Your agent updated the notes');
	}
	await refresh(true);
	setInterval(refresh, 2000);
	// reply times stay current
	setInterval(() => document.querySelectorAll('.msg .ago').forEach((e) => (e.textContent = ago(e.dataset.at))), 30000);

	// ---- copy for an agent (the same markdown the MCP server returns) ---------------------------------------------------------------
	async function copyText(s) {
		try { await navigator.clipboard.writeText(s); } catch { const ta = document.createElement('textarea'); ta.value = s; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
	}
	$('#copy').onclick = async () => {
		await flushGone();
		const open = notes.filter(isOpenN).length;
		if (!open) { toast('No open notes'); return; }
		await copyText(await fetch('/api/markdown?status=open').then((r) => r.text()));
		toast(`Copied ${open} note${open > 1 ? 's' : ''} — paste it to your agent`);
	};

	renderList(); buildTimeline(); fitStage(); renderComposer();
})();
