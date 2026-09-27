# video-launcher

Frame-accurate feedback on a rendered video, for AI agents.

You made a video with an agent: [HyperFrames](https://github.com/heygen-com/hyperframes), [Remotion](https://remotion.dev), or anything else that renders an MP4. Now you need to tell the agent what to change. "The title at 0:12 is too small" is a guess the agent has to decode. With video-launcher you pause on the frame, **point** at the title or **draw** on it, write one line, and your agent gets back exactly this:

```md
## 1. 45.60s (frame 1368) · The app (desktop → phone)
- **Feedback:** make the cover bigger
- **Narration there:** “seconds. Pick a cover, a font,”
- **Scene:** s4 (assets/js/s4-app.js)
- **Pointing at:** `.phone2 > … > .cvr > .sc` — near “Cocktail bars in Bangkok”
- **Element box:** 1018,286 330×420 (in 1920×1080)
- **Drawn on the frame** (1920×1080): arrow from 384,810 to 768,594 (pink) pointing at “Cocktail bars in Bangkok”
```

It also gets **the frame itself, with your drawing on it**, as an image over MCP.

## Quick start

```sh
npx video-launcher path/to/video.mp4
```

A folder works too, and resolves to its newest render (`./renders`, `./out`, or the folder):

```sh
npx video-launcher .
```

The review opens in your browser. Write in the sidebar and the note lands at the playhead. Before you press **Add note**, you can attach one or more of these:

- **Point (P):** click something in the frame. On a HyperFrames composition this names the exact element; on a plain video it records the spot.
- **Draw (D):** pen, arrow, box or text, in six colours.
- **Range:** drag across the filmstrip to cover a stretch of time.

Then connect your agent once:

```sh
claude mcp add video-launcher -- npx -y video-launcher mcp
```

After that, ask it to *"check the video feedback"*. There's also a **Copy for agent** button if you'd rather paste.

## What it knows about your video

| You have | Pointing | Scenes on the timeline | What's being said |
| --- | --- | --- | --- |
| Any MP4 / MOV / WebM | the spot, in video pixels | one clip | from `<video>.srt` / `.vtt` if present |
| A **HyperFrames** project | **the element** under your click, resolved on that exact frame | the root clips (`data-start` / `data-duration`) | captions, or the sidecar |
| **Remotion** (`out/video.mp4`) | the spot, in video pixels | one clip, or the sidecar | captions, or the sidecar |

Notes always carry **seconds and frame numbers**. Pass `--fps` to match your composition.

**How pointing works.** video-launcher serves the composition from the same origin and injects a small adapter. The adapter seeks every `window.__timelines` GSAP timeline to the time you paused on and applies clip visibility. The UI then hit-tests the DOM exactly where you clicked. It follows the HyperFrames contract, so it works without the HyperFrames runtime. If your composition drives itself some other way, give it a hook:

```html
<script>
	window.__videoLauncher = {
		seek(t) { /* put the DOM in its state at t seconds */ },
		info() { return { width: 1920, height: 1080, fps: 30, scenes: [{ id: 'intro', name: 'Intro', start: 0 }] } } // optional
	};
</script>
```

### The sidecar (optional)

This is a JSON file named `<video>.review.json`, or `video-launcher.json`, placed next to the video. Every key is optional:

```json
{
	"title": "Launch film v7",
	"fps": 30,
	"scenes": [{ "id": "s1", "name": "Everyone asks", "file": "src/scenes/asks.tsx", "start": 0 }],
	"transcript": [{ "start": 0.5, "end": 3.4, "text": "You've been there." }],
	"words": [["You've", 0.48, 0.76], ["been", 0.76, 0.88]]
}
```

`file` shows up in the feedback, so the agent knows which source file owns the scene. If your pipeline already knows its scene boundaries and voice-over timing, write this file at render time.

## For agents (MCP)

| Tool | What it does |
| --- | --- |
| `list_reviews` | Lists the reviews under the project, with open counts |
| `get_feedback` | Returns open notes (or `resolved` / `dismissed` / `all`) as markdown with note ids. Each annotated note also comes with its frame as an image |
| `get_frame` | Returns any frame at `t` seconds as an image, for checking a spot or verifying a re-render. Needs `ffmpeg` |
| `reply` | Asks the reviewer a question on a note. It appears under the note in the review UI |
| `resolve` | Closes a note with a line on what changed |
| `dismiss` | Closes a note without changing anything, with the reason |

The MCP server reads and writes the same review files the UI uses, so the UI doesn't need to be running. When the UI is open, it picks up the agent's replies and resolutions within two seconds. You can answer in the note's thread, or reopen the note.

Other MCP clients need two things:
- command: `npx`
- args: `["-y", "video-launcher", "mcp"]`

Run it from your project folder, or pass `--root <dir>`.

## Where notes live

Each review is saved to `<video folder>/.video-launcher/<video file name>.json`. Everything stays local and nothing is uploaded. Commit the folder if you want the feedback in git, or add `.video-launcher` to `.gitignore`.

## CLI

```
npx video-launcher <video | folder> [--composition <html> | --no-composition] [--captions <srt|vtt>]
                                    [--meta <json>] [--fps <n>] [--port <n>] [--no-open]
npx video-launcher mcp [--root <dir>]
```

## Keys

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | step one frame (`⇧` for one second) |
| `↑` `↓` | previous / next scene |
| `N` | write a note |
| `P` | point |
| `D` | draw (`⌘Z` undoes a mark) |
| `⌘↵` | add the note |
| `Esc` | leave a tool, or drop what's attached |
| `M` | toggle sound |
| `F` | fullscreen |

## Development

```sh
npm install
npm test
node bin/cli.js path/to/video.mp4
```

There are no build steps. The UI is `ui/index.html` plus `ui/app.js`, the composition adapter is `ui/adapter.js`, and the server, MCP server and formatting live in `src/`.

## License

MIT
