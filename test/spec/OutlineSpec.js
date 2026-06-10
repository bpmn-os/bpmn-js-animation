import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import diagramXML from '../diagram.bpmn';

// The animation module pulls in diagram-js's native `selection` + `outline` features and
// registers an OutlineProvider that only RESIZES the outline for stacked nodes — so native
// selection (and the bpmn-js ecosystem) stays in charge; just the frame grows for stacks.

describe('native stack-aware selection outline', function() {

  beforeEach(bootstrap(diagramXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  function outline(id) {
    const er = get('elementRegistry');
    return er.getGraphics(er.get(id)).querySelector('.djs-outline');
  }
  const width = id => +outline(id).getAttribute('width');

  it('uses the native diagram-js selection + outline features', function() {
    expect(get('selection')).to.exist;
    expect(get('outline')).to.exist;
    expect(outline('Task_1')).to.exist; // native outline is drawn
  });

  it('selection state goes through the native `selection` service', function() {
    const el = get('elementRegistry').get('Task_1');
    get('selection').select(el);
    expect(get('selection').get().map(e => e.id)).to.include('Task_1');
  });

  it('grows the native outline to wrap a stack', function() {
    const base = width('Task_1');
    get('primitives').setStackSize('Task_1', 3);
    expect(width('Task_1')).to.be.greaterThan(base);
  });

  it('restores the default size when the stack is cleared', function() {
    const base = width('Task_1');
    get('primitives').setStackSize('Task_1', 3);
    expect(width('Task_1')).to.be.greaterThan(base);

    get('primitives').setStackSize('Task_1', 0);
    expect(width('Task_1')).to.equal(base);
  });

  // The full module includes the `simulator`, which marks the container `.bts-simulation` so our CSS
  // hides the native selection box (a token-simulation-style view) — the outline geometry still tracks
  // the stack (above), it's just not painted. Selection state itself is untouched.
  it('the simulator marks the container so the native box is hidden', function() {
    const container = get('canvas').getContainer();
    expect(container.classList.contains('bts-simulation')).to.be.true;
  });

});
