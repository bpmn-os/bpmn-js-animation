import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';

import AnimationModule from '../lib/index.js';

let viewer;
let container;

/**
 * Returns a beforeEach-friendly function that boots a NavigatedViewer with the
 * token-animation module and imports the given diagram. Resolves when ready.
 *
 * @param {string} xml
 * @param {object} [config] extra viewer config (e.g. { animation: { maxVisible } })
 */
export function bootstrap(xml, config = {}) {
  return function() {
    container = document.createElement('div');
    container.style.width = '900px';
    container.style.height = '600px';
    document.body.appendChild(container);

    viewer = new BpmnViewer({
      container,
      additionalModules: [ AnimationModule ],
      ...config
    });

    return viewer.importXML(xml);
  };
}

export function cleanup() {
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }

  if (container) {
    container.remove();
    container = null;
  }
}

export function get(name) {
  return viewer.get(name);
}

export function getViewer() {
  return viewer;
}

/** All rendered token dots (excludes the overflow marker). */
export function dots() {
  return Array.from(document.querySelectorAll('.bts-token-count:not(.bts-overflow)'));
}

/** The overflow "+N" marker element, or null. */
export function marker() {
  return document.querySelector('.bts-token-count.bts-overflow');
}
