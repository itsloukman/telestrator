---
name: video-launcher
description: Review and fix a rendered video (HyperFrames, Remotion or any MP4) from frame-accurate feedback. Use when the user wants to review a video, asks to "check the video feedback", "address my notes on the video", "watch for feedback", or "critique the render", or when you've just rendered a video and want the user's notes on it.
---

# video-launcher

The user leaves notes on exact frames of a rendered video: pointing at an element, drawing on the frame, or marking a time range. You read them over the `video-launcher` MCP server, fix the source, re-render, and close each note.

## If the tools aren't there

The MCP tools (`get_feedback`, `watch_feedback`, …) come from the `video-launcher` server. If you don't have them, ask the user to run this once, then start a new session:

```sh
npx video-launcher init
```

## Open a review for the user

After a render, open it so they can leave notes:

```sh
npx video-launcher path/to/video.mp4   # or a project folder: the newest render in ./renders, ./out, or the folder
```

Pass `--composition <index.html>` if a HyperFrames composition isn't found automatically; pointing then names real elements.

## Address the feedback

1. `get_feedback` returns the open notes. Each one has its time and frame, scene and scene file, what's being said, the element pointed at (CSS path, **source file:line**, **its current styles**), what was drawn, and the frame itself as an image. Read the images.
2. If a note asks a question, answer it with `reply` rather than changing anything.
3. For each note:
   - `acknowledge` it, so the reviewer sees you've picked it up.
   - Change the source: the **Source** line and the scene file tell you where. Use **Styles now** as the starting point ("font-size 48px" plus "too small" means make it bigger than 48px).
   - If it's ambiguous, `reply` with a question and move on. Don't guess.
   - If you won't change it, `dismiss` it with the reason.
4. Re-render, then check your fix with `get_frame` at the note's time.
5. `resolve` each note with one line on what you changed.

## Hands-free (watch mode)

When the user says "watch mode" or "keep going while I review": call `watch_feedback` in a loop. It waits until the reviewer adds notes, then returns the batch. Handle each note as above, then call `watch_feedback` again. Stop when the user says so, or after a few timeouts in a row with nothing new.

## Critique mode

When the user asks you to critique or check the render: step through it with `get_frame` (every scene start, every few seconds, around text and transitions). For each real problem (text that's hard to read, cut-off elements, typos, bad timing, jumps, contrast), call `add_note` with the time, where in the frame (`x`, `y` from 0 to 1), and what's wrong. The reviewer sees your notes marked "from agent" and decides what to fix. Keep to issues you can see in the frames. Don't pad the list.
