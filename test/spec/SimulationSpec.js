import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import miTaskXML from '../diagrams/mi-task.bpmn';
import collaborationXML from '../diagrams/collaboration.bpmn';
import eventSubXML from '../diagrams/event-subprocess.bpmn';

const PROCESS = 'Process_1';


describe('SimulationAPI', function() {

  describe('createToken — process/participant case', function() {

    beforeEach(bootstrap(miTaskXML));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('creates a token for a process instance', function() {
      const token = sim().createToken(PROCESS, 'I1');

      expect(token).to.exist;
      expect(token.label).to.equal('I1');
      expect(token.color).to.match(/^hsl\(/);
      expect(sim().getToken(PROCESS, 'I1')).to.equal(token);
    });

    it('places it at the ready position (above the top-left)', function() {
      const token = sim().createToken(PROCESS, 'I1');
      expect(token.state.position).to.include({ left: 0, top: 0, voffset: -15 });
    });

    it('increments the instance stack and draws the process box', function() {
      expect(get('animation').getStackSize(PROCESS)).to.equal(0);

      sim().createToken(PROCESS, 'I1');

      expect(get('animation').getStackSize(PROCESS)).to.equal(1);
      expect(get('animation').getProcessBox()).to.equal(PROCESS);
    });

    it('tags each instance with its own stack index', function() {
      const a = sim().createToken(PROCESS, 'I1');
      const b = sim().createToken(PROCESS, 'I2');

      expect(a.stackIndices).to.deep.equal({ [PROCESS]: 0 });
      expect(b.stackIndices).to.deep.equal({ [PROCESS]: 1 });
      expect(get('animation').getStackSize(PROCESS)).to.equal(2);
    });

    it('gives subsequent tokens distinct colors', function() {
      const a = sim().createToken(PROCESS, 'I1');
      const b = sim().createToken(PROCESS, 'I2');
      const c = sim().createToken(PROCESS, 'I3');

      expect(new Set([ a.color, b.color, c.color ]).size).to.equal(3);
    });

    it('registers the token as a tree root (no children yet)', function() {
      const token = sim().createToken(PROCESS, 'I1');
      expect(sim().getChildren(token)).to.deep.equal([]);
    });

    it('keeps the first instance in front by default', function() {
      sim().createToken(PROCESS, 'I1');
      sim().createToken(PROCESS, 'I2');
      expect(get('animation').getStackIndex(PROCESS)).to.equal(0);
    });

    it('reveals the touched instance when auto-focus is on', function() {
      sim().autoFocus(true);
      sim().createToken(PROCESS, 'I1');
      sim().createToken(PROCESS, 'I2');
      expect(get('animation').getStackIndex(PROCESS)).to.equal(1);

      sim().autoFocus(false);
      sim().createToken(PROCESS, 'I3');
      expect(get('animation').getStackIndex(PROCESS)).to.equal(1); // unchanged
    });

    it('rejects an unsupported node', function() {
      expect(() => sim().createToken('MultiInstanceActivity_1', 'X'))
        .to.throw(/not a process\/participant or a start event/);
    });

    it('rejects an unknown node', function() {
      expect(() => sim().createToken('Nope_1', 'X')).to.throw(/unknown element/);
    });

    it('rejects a duplicate (same node + label)', function() {
      sim().createToken(PROCESS, 'I1');
      expect(() => sim().createToken(PROCESS, 'I1')).to.throw(/already exists/);
    });

    it('clears all state', function() {
      sim().createToken(PROCESS, 'I1');
      sim().clear();

      expect(sim().getToken(PROCESS, 'I1')).to.be.undefined;
      expect(get('animation').getStackSize(PROCESS)).to.equal(0);
    });

  });


  describe('createToken — participant (collaboration) case', function() {

    beforeEach(bootstrap(collaborationXML));
    afterEach(cleanup);

    it('creates a token for a participant (pool) instance', function() {
      const token = get('simulation').createToken('Participant_1', 'I1');

      expect(token.label).to.equal('I1');
      expect(token.stackIndices).to.deep.equal({ Participant_1: 0 });
      expect(get('animation').getStackSize('Participant_1')).to.equal(1);
    });

    it('stacks instances per participant independently', function() {
      get('simulation').createToken('Participant_1', 'A1');
      get('simulation').createToken('Participant_1', 'A2');
      get('simulation').createToken('Participant_2', 'B1');

      expect(get('animation').getStackSize('Participant_1')).to.equal(2);
      expect(get('animation').getStackSize('Participant_2')).to.equal(1);
    });

  });


  describe('createToken — start event case', function() {

    beforeEach(bootstrap(miTaskXML));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('creates a child of the scope token at center, same label + color', function() {
      const root = sim().createToken(PROCESS, 'I1');
      const token = sim().createToken('StartEvent_1', 'I1');

      expect(token.label).to.equal('I1');
      expect(token.color).to.equal(root.color);
      expect(token.state.position).to.include({ left: 0.5, top: 0.5, hoffset: 5, voffset: 5 });
      expect(token.stackIndices).to.deep.equal({ [PROCESS]: 0 });
      expect(sim().getChildren(root)).to.include(token);
      expect(sim().getEntry('StartEvent_1', 'I1').position).to.equal('center');
    });

    it('honors the bounce flag', function() {
      sim().createToken(PROCESS, 'B');
      const token = sim().createToken('StartEvent_1', 'B', true);
      expect(token.state.bounce).to.be.true;
    });

    it('rejects when the scope has no token of that label', function() {
      expect(() => sim().createToken('StartEvent_1', 'I1'))
        .to.throw(/no token <I1> at scope <Process_1>/);
    });

  });


  describe('createToken — start event of event sub-process is rejected', function() {

    beforeEach(bootstrap(eventSubXML));
    afterEach(cleanup);

    it('rejects an event sub-process start event', function() {
      expect(() => get('simulation').createToken('EscalationStartEvent_1', 'X'))
        .to.throw(/event sub-process/);
    });

  });


  describe('advanceToken', function() {

    // animationDuration: 0 ⇒ glides resolve synchronously (no real timers)
    beforeEach(bootstrap(miTaskXML, { animation: { animationDuration: 0 } }));
    afterEach(cleanup);

    function sim() {
      return get('simulation');
    }

    it('advances a token to a named position', async function() {
      sim().createToken(PROCESS, 'I1');
      const token = await sim().advanceToken(PROCESS, 'I1', 'busy');

      expect(token.state.position).to.include({ left: 0.5, top: 0, voffset: 10 });
      expect(sim().getEntry(PROCESS, 'I1').position).to.equal('busy');
    });

    it('bounces at the target when asked', async function() {
      sim().createToken(PROCESS, 'I1');
      const token = await sim().advanceToken(PROCESS, 'I1', 'busy', true);
      expect(token.state.bounce).to.be.true;
    });

    it('updates bounce on a same-position call', async function() {
      sim().createToken(PROCESS, 'I1');
      await sim().advanceToken(PROCESS, 'I1', 'busy', true);
      const token = await sim().advanceToken(PROCESS, 'I1', 'busy', false);
      expect(token.state.bounce).to.be.false;
      expect(sim().getEntry(PROCESS, 'I1').position).to.equal('busy');
    });

    it('reaches the final position when steps are skipped (ready→exit)', async function() {
      sim().createToken(PROCESS, 'I1');
      const token = await sim().advanceToken(PROCESS, 'I1', 'exit');
      expect(token.state.position).to.include({ left: 1, top: 0, voffset: -15 });
    });

    it('is forward-only (rejects advancing backward)', async function() {
      sim().createToken(PROCESS, 'I1');
      await sim().advanceToken(PROCESS, 'I1', 'busy');

      let err;
      try { await sim().advanceToken(PROCESS, 'I1', 'ready'); } catch (e) { err = e; }
      expect(err).to.exist;
      expect(err.message).to.match(/cannot advance backward/);
    });

    it('rejects an unknown position', async function() {
      sim().createToken(PROCESS, 'I1');
      let err;
      try { await sim().advanceToken(PROCESS, 'I1', 'nope'); } catch (e) { err = e; }
      expect(err.message).to.match(/unknown position/);
    });

    it('rejects a non-activity/container node', async function() {
      let err;
      try { await sim().advanceToken('StartEvent_1', 'X', 'busy'); } catch (e) { err = e; }
      expect(err.message).to.match(/not an activity\/container/);
    });

    it('rejects a missing token', async function() {
      let err;
      try { await sim().advanceToken(PROCESS, 'NOPE', 'busy'); } catch (e) { err = e; }
      expect(err.message).to.match(/no token/);
    });

  });

});
