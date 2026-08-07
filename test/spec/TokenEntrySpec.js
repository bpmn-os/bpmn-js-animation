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

  // Both kinds start their summary at the reading inset, and each ends it where its own kind ends: a row
  // that discloses nothing runs to the reading inset on the right too, since a line of text stops where a
  // line of text stops; one that discloses stops short of its caret, which keeps the smaller gap a
  // circular control keeps from an edge. The two kinds never share a list, so this is a difference between
  // panels rather than within one.
  it('insets the summary by the reading inset, and stops short of a caret where there is one', function() {
    const simple = place(createTokenEntry(token()));
    const expandable = place(detailed());

    const summary = (entry) => entry.element.querySelector('.bjs-token-summary').getBoundingClientRect();
    const caret = expandable.element.querySelector('.bjs-collapsible-entry-arrow').getBoundingClientRect();

    // the two measures the side panel keeps: where a line of text stops, and where a circular control sits
    const measure = (name, fallback) =>
      parseFloat(getComputedStyle(simple.element).getPropertyValue(name)) || fallback;
    const inset = measure('--bjs-entry-inset', 12),
          controlGap = measure('--bjs-control-gap', 4);

    const startsAt = (entry) =>
      summary(entry).left - entry.element.getBoundingClientRect().left;

    expect([ startsAt(simple), startsAt(expandable) ]).to.deep.equal([ inset, inset ]);

    // a line of text stops at the reading inset; a circular control stops at the smaller control gap
    expect(simple.element.getBoundingClientRect().right - summary(simple).right).to.equal(inset);
    expect(expandable.element.getBoundingClientRect().right - caret.right).to.equal(controlGap);

    // The two are not the same height for the same summary: a simple entry is a box of content and takes
    // the inset a box takes, where a collapsible entry's header is a row and takes a row's. Since the two
    // kinds never share a list, that is a difference between panels and never one within a list.
    expect(simple.element.getBoundingClientRect().height)
      .to.be.above(expandable.element.getBoundingClientRect().height);
  });

  // A panel that asks something of the reader about a token puts its control on the row. The control
  // acts on the token; it neither selects it nor advances it, which is what the row's own clicks do.
  it('carries a panel\'s control, whose clicks are its own', async function() {
    let acted = 0, clicked = 0, advanced = 0;

    const control = document.createElement('button');
    control.addEventListener('click', () => acted++);

    const entry = place(createTokenEntry(token(), {
      controls: control,
      onClick: () => clicked++,
      onDblClick: () => advanced++
    }));

    expect(entry.controlsEl.firstChild).to.equal(control);
    expect(control.getBoundingClientRect().right)
      .to.be.at.most(entry.element.getBoundingClientRect().right);

    control.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // the row defers its own click by 250ms so a double click can cancel it: waiting past that is what
    // shows the control's click never started it
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(acted).to.equal(1);
    expect(clicked).to.equal(0);
    expect(advanced).to.equal(0);
  });

});
