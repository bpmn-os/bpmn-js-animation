import { expect } from 'chai';

import { bootstrapModeler, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';

/**
 * A mode that is not `model` is read-only, and a host may keep a part of the modeller alive within it by
 * declaring exceptions. The exception used here permits a note to be appended to a task and moved, and keeps
 * one context pad entry, which is the shape of what a host showing execution data during a run needs.
 */

const NOTE = 'bpmn:TextAnnotation';

// appending a note is about the task it hangs off, and the pad is offered there, which is where the entry
// that appends it lives; everything else — moving one, and the gesture that moves it — is about the note
const exceptions = [ {
  operations: [ 'appendShape', 'moveShape' ],
  entries: [ 'append.text-annotation' ],
  applies: (operation, element) =>
    operation === 'appendShape' || operation === 'contextPad'
      ? element.type === 'bpmn:Task'
      : element.type === NOTE
} ];

// a mouse event at an element's centre, which is what a move gesture is started from
function moveEvent(element) {
  return {
    x: element.x + element.width / 2,
    y: element.y + element.height / 2,
    clientX: 0, clientY: 0,
    target: document.querySelector('.djs-container'),
    preventDefault: () => {},
    stopPropagation: () => {}
  };
}

describe('Mode, and what it permits while a run is on', function() {

  beforeEach(bootstrapModeler(linearXML, { mode: { exceptions } }));
  afterEach(cleanup);

  const task = () => get('elementRegistry').get('Task_1');

  function note() {
    return get('elementRegistry').filter(element => element.type === NOTE)[0];
  }

  it('refuses an operation no exception names', function() {
    const modeling = get('modeling'),
          shape = task(),
          x = shape.x;

    get('mode').setMode('playback');
    modeling.moveShape(shape, { x: 40, y: 0 });

    expect(shape.x).to.equal(x);
  });

  it('runs an operation an exception names, on an element it is about', function() {
    const modeling = get('modeling');

    get('mode').setMode('playback');

    const appended = modeling.appendShape(task(), { type: NOTE, width: 100, height: 30 },
      { x: task().x, y: task().y - 80 });

    expect(appended).to.exist;

    const y = appended.y;

    modeling.moveShape(appended, { x: 0, y: -20 });

    expect(appended.y).to.equal(y - 20, 'the note it permits a move on has moved');
  });

  it('leaves the model alone again when the mode returns to model', function() {
    const mode = get('mode'),
          modeling = get('modeling'),
          shape = task();

    mode.setMode('playback');
    mode.setMode('model');

    modeling.moveShape(shape, { x: 40, y: 0 });

    expect(shape.x).to.not.equal(0, 'modelling is whole again');
  });

  it('opens the context pad only where an entry is kept, and keeps only that entry', function() {
    const contextPad = get('contextPad'),
          mode = get('mode');

    mode.setMode('playback');

    contextPad.open(task());
    expect(contextPad.isOpen()).to.be.true;

    const entries = Array.from(document.querySelectorAll('.djs-context-pad .entry'))
      .map(entry => entry.getAttribute('data-action'));

    expect(entries).to.eql([ 'append.text-annotation' ]);

    contextPad.close();
    contextPad.open(get('elementRegistry').get('StartEvent_1'));

    expect(contextPad.isOpen()).to.be.false;
  });

  it('marks what a gesture is permitted on, and unmarks it when the mode ends', function() {
    const mode = get('mode'),
          canvas = get('canvas');

    mode.setMode('playback');

    const appended = get('modeling').appendShape(task(), { type: NOTE, width: 100, height: 30 },
      { x: task().x, y: task().y - 80 });

    expect(canvas.hasMarker(appended, 'bts-editable')).to.be.true;
    expect(canvas.hasMarker(task(), 'bts-editable')).to.be.false;

    mode.setMode('model');

    expect(canvas.hasMarker(appended, 'bts-editable')).to.be.false;
  });

  it('lets a drag start on an element an exception is about, and on nothing else', function() {
    const mode = get('mode'),
          dragging = get('dragging');

    mode.setMode('playback');

    const box = get('modeling').appendShape(task(), { type: NOTE, width: 100, height: 30 },
      { x: task().x, y: task().y - 80 });

    expect(mode.concerns(box)).to.be.true;
    expect(mode.concerns(task())).to.be.false;

    get('move').start(moveEvent(box), box, true);
    expect(dragging.context(), 'a gesture on the box engages').to.exist;
    dragging.cancel();

    get('move').start(moveEvent(task()), task(), true);
    expect(dragging.context(), 'a gesture on anything else does not').to.not.exist;
  });

  it('takes exceptions after the fact as well', function() {
    const mode = get('mode');

    mode.setExceptions([]);
    mode.setMode('playback');

    const shape = task(),
          x = shape.x;

    get('modeling').appendShape(shape, { type: NOTE, width: 100, height: 30 }, { x: shape.x, y: shape.y - 80 });

    expect(note()).to.not.exist;
    expect(shape.x).to.equal(x);
  });
});
