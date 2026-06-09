import { expect } from 'chai';

import { bootstrap, cleanup, get, getViewer } from '../TestHelper';

import collaborationXML from '../diagrams/collaboration.bpmn';

import { playCollaboration, executionLog } from '../../demo/playback.js';

const ORDER_POOL = 'Participant_1c07lhk';
const MACHINE_POOL = 'Participant_0gkimz7';

// Guards demo/playback.js against model-id / simulation-API drift: the whole step log must replay
// through the `simulation` service and clean up after itself.
describe('demo/playback', function() {

  beforeEach(bootstrap(collaborationXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('every step is { node, label, pos } (+ optional animate)', function() {
    expect(executionLog).to.be.an('array').that.is.not.empty;
    for (const step of executionLog) {
      expect(step).to.have.keys([ 'node', 'label', 'pos' ].concat(step.animate !== undefined ? [ 'animate' ] : []));
      expect(step.node, 'node').to.be.a('string');
      expect(step.label, 'label').to.be.a('string');
      expect(step.pos, 'pos').to.be.a('string');
    }
  });

  it('replays the full log and leaves no tokens or stacks behind', async function() {
    await playCollaboration(getViewer(), executionLog);

    const anim = get('animation');
    expect(anim.getTokens(), 'all tokens consumed').to.have.length(0);
    expect(anim.getStacks(ORDER_POOL), 'order pool empty').to.eql([]);
    expect(anim.getStacks(MACHINE_POOL), 'machine pool empty').to.eql([]);
  });
});
