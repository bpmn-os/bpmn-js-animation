import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import collaborationXML from '../diagrams/collaboration.bpmn';

import eventLog from '../../examples/collaboration.json';

const ORDER_POOL = 'Participant_1c07lhk';
const MACHINE_POOL = 'Participant_0gkimz7';

// Guards the bundled event log (examples/collaboration.json) + record/replay against model-id / API
// drift: the whole log must replay through the `animator` service and clean up after itself.
describe('event-log playback (examples/collaboration.json)', function() {

  beforeEach(bootstrap(collaborationXML, { animation: { animationDuration: 0 } }));
  afterEach(cleanup);

  it('every entry is a flat { action, node, label } event', function() {
    expect(eventLog).to.be.an('array').that.is.not.empty;
    for (const entry of eventLog) {
      expect(entry.action, 'action').to.be.a('string');
      expect(entry.node, 'node').to.be.a('string');
      expect(entry.label, 'label').to.be.a('string');
    }
  });

  it('replays to a clean finish with auto-focus on', async function() {
    const animator = get('animator');
    animator.autoFocus(true);
    await animator.replay(eventLog);

    const anim = get('primitives');
    expect(anim.getTokens(), 'all tokens consumed').to.have.length(0);
    expect(anim.getStacks(ORDER_POOL), 'order pool empty').to.eql([]);
    expect(anim.getStacks(MACHINE_POOL), 'machine pool empty').to.eql([]);
  });

  it('records BPMN events as flat objects, and round-trips through replay', async function() {
    const sim = get('animation');
    const simulator = get('simulator'); // owns record
    const animator = get('animator');   // owns replay

    // record a short run driven via the API (the simulator captures calls on the shared instance)
    simulator.startRecording();
    sim.createToken({ node: 'MachineProcess', label: 'M1' });
    sim.createToken({ node: 'StartEventMachine', label: 'M1' });
    await sim.advanceToken({ node: 'StartEventMachine', label: 'M1', sequenceFlow: 'Flow_1rghjse' });
    await sim.advanceToken({ node: 'ConditionalEvent', label: 'M1' });
    const recorded = simulator.stopRecording();

    expect(recorded).to.have.length(4);
    expect(recorded[0]).to.eql({ action: 'createToken', node: 'MachineProcess', label: 'M1' });
    expect(recorded[2]).to.eql({ action: 'advanceToken', node: 'StartEventMachine', label: 'M1', sequenceFlow: 'Flow_1rghjse' });

    // replay it onto a clean diagram → same single waiting token at the conditional
    sim.clear();
    animator.autoFocus(true);
    await animator.replay(recorded);
    expect(get('animation').getToken('ConditionalEvent', 'M1'), 'M1 waits at the conditional').to.exist;
  });
});
