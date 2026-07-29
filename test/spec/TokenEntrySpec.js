import { expect } from 'chai';

import createTokenEntry from '../../lib/TokenEntry';

import sidePanelCSS from 'bpmn-js-side-panel/assets/side-panel.css';
import tokenPanelCSS from '../../assets/token-panel.css';

// createTokenEntry is plain DOM, so it is exercised without a diagram. The stylesheets are loaded
// because what is asserted here is geometry, which a headless browser measures and a fake DOM cannot.

function token() {
  return { node: 'Task_1', label: 'I1', color: '#3399ff', state: {} };
}

describe('createTokenEntry', function() {

  let host;

  before(function() {
    const style = document.createElement('style');
    style.textContent = sidePanelCSS + tokenPanelCSS;
    style.setAttribute('data-token-entry-spec', '');
    document.head.appendChild(style);
  });

  after(function() {
    document.querySelector('style[data-token-entry-spec]').remove();
  });

  beforeEach(function() {
    host = document.createElement('div');
    host.style.width = '300px';
    document.body.appendChild(host);
  });

  afterEach(function() {
    host.remove();
  });

  function place(entry) {
    host.appendChild(entry.element);
    return entry;
  }

  it('is expandable exactly when a renderer is given', function() {
    const plain = place(createTokenEntry(token()));
    const expandable = place(createTokenEntry(token(), { renderDetail: (t, el) => { el.textContent = 'x'; } }));

    expect(plain.contentEl).to.be.null;
    expect(plain.element.classList.contains('bjs-collapsible-entry-expandable')).to.be.false;
    expect(expandable.contentEl).to.exist;
    expect(expandable.element.classList.contains('bjs-collapsible-entry-expandable')).to.be.true;
  });

  // A caret must not change what a collapsed row looks like, so that a list holding rows of both
  // kinds keeps one alignment. The side panel reserves the caret's space on a row that has none.
  it('has the same shape with and without a caret', function() {
    const plain = place(createTokenEntry(token()));
    const expandable = place(createTokenEntry(token(), { renderDetail: (t, el) => { el.textContent = 'x'; } }));

    const summary = (entry) => entry.element.querySelector('.bjs-token-summary').getBoundingClientRect();

    expect(summary(plain).width).to.equal(summary(expandable).width);
    expect(summary(plain).right).to.equal(summary(expandable).right);
    expect(plain.element.getBoundingClientRect().height)
      .to.equal(expandable.element.getBoundingClientRect().height);
  });

});
