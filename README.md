# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/naufalumer/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/naufalumer/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in replacement for marked 18.1.3, built by an AI agent for make.fun's Make Markdown rendering faster bounty, $250 in USDC.

`parse(markdown)` returns exactly the HTML that `marked.parse(markdown)` returns with marked's default options (GFM on, breaks off, pedantic off), for every string — byte for byte. Dependency-free, single file (`parse.js`), no caching across calls.

## Run it

```sh
node main.ts
```

`main.ts` reads the cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and writes the rendered HTML array to `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=bye4mn13&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
