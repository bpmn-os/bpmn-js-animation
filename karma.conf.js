/* eslint-env node */

// Karma + Mocha + webpack, running in headless Chrome (provided by puppeteer).
// A real browser is required: the animator uses SVG getPointAtLength, diagram-js
// overlays and requestAnimationFrame, none of which exist in a fake DOM.

const path = require('path');

// Use a system Chrome (override with CHROME_BIN). `--no-sandbox` keeps it
// working in CI/containers; harmless for a normal desktop run.
process.env.CHROME_BIN = process.env.CHROME_BIN || 'google-chrome';

module.exports = function(karma) {
  karma.set({
    basePath: '',

    frameworks: [ 'mocha', 'webpack' ],

    files: [
      'test/**/*Spec.js'
    ],

    preprocessors: {
      'test/**/*Spec.js': [ 'webpack' ]
    },

    reporters: [ 'progress' ],

    browsers: [ 'ChromeHeadlessNoSandbox' ],

    customLaunchers: {
      ChromeHeadlessNoSandbox: {
        base: 'ChromeHeadless',
        flags: [ '--no-sandbox', '--disable-gpu' ]
      }
    },

    singleRun: true,
    autoWatch: false,

    webpack: {
      mode: 'development',
      module: {
        rules: [
          { test: /\.bpmn$/, type: 'asset/source' },
          { test: /\.css$/, type: 'asset/source' }
        ]
      },
      resolve: {
        mainFields: [ 'browser', 'module', 'main' ],
        modules: [ 'node_modules', path.resolve(__dirname) ]
      }
    }
  });
};
