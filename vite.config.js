import { defineConfig } from 'vite';

// Builds the `demo/` app — the package's example app, deployed to GitHub Pages. One page
// (`index.html`) hosts both the interactive simulator and the event-log playback (a Simulate ⇄ Play
// toggle). `root: 'demo'` serves it; `fs.allow: ['..']` lets it read the sibling lib/ + assets/ +
// examples/. `base` is the gh-pages sub-path (https://bpmn-os.github.io/<repo>/) in CI; output goes
// to the repo-root dist/.
export default defineConfig({
  root: 'demo',
  base: process.env.GITHUB_ACTIONS ? '/bpmn-js-animation/' : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    fs: {
      allow: [ '..' ]
    }
  }
});
