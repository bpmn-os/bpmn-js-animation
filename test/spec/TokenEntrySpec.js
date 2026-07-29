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

  const detailed = () => createTokenEntry(token(), { renderDetail: (t, el) => { el.textContent = 'x'; } });

  it('is a simple entry without a renderer and a collapsible one with it', function() {
    const simple = place(createTokenEntry(token()));
    const expandable = place(detailed());

    expect(simple.element.classList.contains('bjs-simple-entry')).to.be.true;
    expect(simple.contentEl).to.be.null;
    expect(simple.element.querySelector('.bjs-collapsible-entry-arrow')).to.not.exist;

    expect(expandable.element.classList.contains('bjs-collapsible-entry')).to.be.true;
    expect(expandable.element.classList.contains('bjs-collapsible-entry-expandable')).to.be.true;
    expect(expandable.contentEl).to.exist;
    expect(expandable.element.querySelector('.bjs-collapsible-entry-arrow')).to.exist;
  });

  // A row that discloses nothing gives its summary the width a caret would have taken. The two kinds
  // never share a list, so this is a difference between panels rather than within one.
  it('gives the summary the caret\'s width when there is no caret', function() {
    const simple = place(createTokenEntry(token()));
    const expandable = place(detailed());

    const summary = (entry) => entry.element.querySelector('.bjs-token-summary').getBoundingClientRect();
    const caret = expandable.element.querySelector('.bjs-collapsible-entry-arrow').getBoundingClientRect();
    // the row's flex gap, read from the empty controls slot that sits right of the summary
    const gap = expandable.element.querySelector('.bjs-collapsible-entry-controls')
      .getBoundingClientRect().left - summary(expandable).right;

    expect(summary(simple).width).to.equal(summary(expandable).width + caret.width + gap);
    expect(summary(simple).left).to.equal(summary(expandable).left);
    expect(simple.element.getBoundingClientRect().height)
      .to.equal(expandable.element.getBoundingClientRect().height);
  });

});
