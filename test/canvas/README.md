# Canvas Regression Harness

- `npm run canvas` opens interactive transcript, diff, and prompt-navigation fixtures on port 3114.
- `npm run smoke:canvas` starts that server and checks real Electron mouse/keyboard behavior with temporary user data.
- `npm run smoke:animation` verifies the saved On/System/Reduced motion preference, progress pixels changing over time, hide/show recovery, and streamed-text cadence with Chromium's normal throttling enabled. Uses temporary SQLite/user data, never your app settings.
- `npm run smoke:diff` runs the pure geometry, diff, text-selection, and viewport-windowing checks.
- `npm run perf:canvas` records switch-to-first-paint times and a Chromium CPU profile for fresh main/agent history snapshots. It fails if a switch exceeds 500 ms or if the initial viewport materializes more than 500 text rows.

Set `CANVAS_PERF_SCALE=10` for 2,000 messages / a 3,000-step agent turn. The switch measurement starts after the fixture's structured clone (standing in for a completed history load), so it measures renderer latency rather than database or IPC latency. Results and CPU profiles go under ignored `test/.out/`.

Large histories keep a lightweight height index for the entire conversation but materialize only viewport-adjacent parts. Heights above the viewport can refine as they are visited; the current part's offset is anchored so refinement does not move the text being read. Prompt navigation targets stable message IDs, not stale pixel positions. Copy Message / Select All still resolve the original source on demand; the accessibility mirror is restricted to readable viewport text instead of recursively copying hidden tool results into the DOM.
