import { expect } from 'chai';

import { bootstrapModeler, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';

/**
 * A mode that is not `model` refuses modelling through the rules, which diagram-js asks before it offers a
 * gesture, so what is forbidden is not offered rather than offered and quietly ignored. A host may keep part
 * of the modeller alive within such a mode by declaring exceptions, in terms of the `modeling` operations it
 * thinks in; `ModeRules` is the one place that vocabulary meets diagram-js's rule names.
 *
 * The exception below has the shape of what a host showing execution data during a run needs: a note it may
 * move and take away, and one context pad entry, offered on the element the note is about.
 */

const NOTE = 'bpmn:TextAnnotation';

const exceptions = [ {
  operations: [ 'moveShape', 'moveElements', 'removeElements' ],
  entries: [ 'append.text-annotation' ],
  applies: (operation, element) =>
    operation === 'contextPad' ? element.type === 'bpmn:Task' : element.type === NOTE
} ];

describe('Mode, and what it permits while a run is on', function() {

  beforeEach(bootstrapModeler(linearXML, { mode: { exceptions } }));
  afterEach(cleanup);

  const task = () => get('elementRegistry').get('Task_1');

  // a note of the kind the exception is about, made while modelling is still allowed
  function note() {
    return get('modeling').appendShape(task(), { type: NOTE, width: 100, height: 30 },
      { x: task().x, y: task().y - 80 });
  }

  it('refuses a gesture on an element no exception is about', function() {
    const rules = get('rules'),
          shape = task();

    expect(rules.allowed('elements.move', { shapes: [ shape ] }), 'while modelling').to.not.equal(false);

    get('mode').setMode('playback');

    expect(rules.allowed('elements.move', { shapes: [ shape ] })).to.equal(false);
    expect(rules.allowed('shape.resize', { shape })).to.equal(false);
    expect(rules.allowed('elements.delete', { elements: [ shape ] })).to.equal(false);
    expect(rules.allowed('connection.start', { source: shape })).to.equal(false);
  });

  it('leaves an element an exception is about to the rules below', function() {
    const rules = get('rules'),
          box = note();

    get('mode').setMode('playback');

    expect(rules.allowed('elements.move', { shapes: [ box ], target: box.parent }),
      'a move it permits').to.not.equal(false);
    expect(rules.allowed('elements.delete', { elements: [ box ] }),
      'a deletion it permits').to.not.equal(false);
    expect(rules.allowed('shape.resize', { shape: box }),
      'a resize it does not name').to.equal(false);
  });

  it('refuses a gesture naming an element it is not about, even beside one it is', function() {
    const rules = get('rules'),
          box = note();

    get('mode').setMode('playback');

    expect(rules.allowed('elements.move', { shapes: [ box, task() ] })).to.equal(false);
  });

  it('leaves modelling whole again when the mode returns to model', function() {
    const mode = get('mode'),
          rules = get('rules');

    mode.setMode('playback');
    mode.setMode('model');

    expect(rules.allowed('elements.move', { shapes: [ task() ] })).to.not.equal(false);
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
          canvas = get('canvas'),
          box = note();

    mode.setMode('playback');

    expect(canvas.hasMarker(box, 'bts-editable')).to.be.true;
    expect(canvas.hasMarker(task(), 'bts-editable')).to.be.false;

    mode.setMode('model');

    expect(canvas.hasMarker(box, 'bts-editable')).to.be.false;
  });

  it('lets the keyboard take away what a run permits, and nothing else', function() {
    const editorActions = get('editorActions'),
          elementRegistry = get('elementRegistry'),
          box = note();

    get('mode').setMode('playback');

    get('selection').select(task());
    editorActions.trigger('removeSelection');
    expect(elementRegistry.get('Task_1'), 'a task the exception is not about').to.exist;

    get('selection').select(box);
    editorActions.trigger('removeSelection');
    expect(elementRegistry.get(box.id), 'the note it is about').to.not.exist;
  });

  it('takes exceptions after the fact as well', function() {
    const mode = get('mode'),
          rules = get('rules'),
          box = note();

    mode.setExceptions([]);
    mode.setMode('playback');

    expect(rules.allowed('elements.move', { shapes: [ box ] })).to.equal(false);

    mode.setExceptions(exceptions);

    expect(rules.allowed('elements.move', { shapes: [ box ], target: box.parent })).to.not.equal(false);
  });
});
