import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import miTaskXML from '../diagrams/mi-task.bpmn';
import collaborationXML from '../diagrams/collaboration.bpmn';

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

    it('rejects a non-process/participant node', function() {
      expect(() => sim().createToken('MultiInstanceActivity_1', 'X'))
        .to.throw(/not a bpmn:Process or bpmn:Participant/);
    });

    it('rejects an unknown node', function() {
      expect(() => sim().createToken('Nope_1', 'X')).to.throw(/unknown element/);
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

});
