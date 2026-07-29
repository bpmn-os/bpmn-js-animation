import { expect } from 'chai';

import { bootstrapPanel, cleanup, get } from '../TestHelper';

import collaborationXML from '../diagrams/collaboration.bpmn';
import executionLog from '../../examples/collaboration.json';

// A run belongs to the diagram it plays on. A host loading another model clears that diagram, and the
// controller must return to idle so its run button says Run rather than Pause. The duration is
// non-zero so a replay is genuinely in flight when the diagram goes.

describe('Playback, when its diagram goes away', function() {

  beforeEach(bootstrapPanel(collaborationXML, { animation: { animationDuration: 200 } }));
  afterEach(cleanup);

  const runButton = () => document.querySelector('.bjs-token-run');

  it('returns to idle from playing, and the run button follows', function() {
    const playback = get('playback');
    playback.play(executionLog);   // deliberately not awaited: it stays in flight

    expect(playback.getState()).to.equal('playing');
    expect(runButton().title).to.equal('Pause');

    get('eventBus').fire('diagram.clear');

    expect(playback.getState()).to.equal('idle');
    expect(runButton().title).to.equal('Run');
  });

  it('returns to idle from paused as well', function() {
    const playback = get('playback');
    playback.play(executionLog);
    playback.pause();

    expect(playback.getState()).to.equal('paused');
    expect(runButton().title).to.equal('Resume');

    get('eventBus').fire('diagram.clear');

    expect(playback.getState()).to.equal('idle');
    expect(runButton().title).to.equal('Run');
  });

  it('drops the log it was playing, the diagram it came from being gone', function() {
    const playback = get('playback');
    playback.play(executionLog);
    expect(playback.getLog()).to.equal(executionLog);

    get('eventBus').fire('diagram.clear');

    expect(playback.getLog()).to.be.null;
  });

  it('keeps a registered log source, which belongs to the host and not to the diagram', function() {
    const playback = get('playback');
    const source = () => executionLog;
    playback.setLogSource(source);
    playback.play(executionLog);

    get('eventBus').fire('diagram.clear');

    expect(playback.getLogSource()).to.equal(source);
  });

  it('lets the abandoned run unwind without reporting anything', async function() {
    const playback = get('playback');
    const run = playback.play(executionLog);

    get('eventBus').fire('diagram.clear');
    expect(playback.getState()).to.equal('idle');

    // The abandoned replay goes on unwinding against a diagram whose tokens are gone, and fails as it
    // does. That failure is expected rather than the host's to handle, so awaiting the run neither
    // throws nor moves a state the controller has already left. Without the guard this rejects, and
    // in an application it surfaces as an unhandled rejection, `play` being called and not awaited.
    await run;

    expect(playback.getState()).to.equal('idle');
  });

});
