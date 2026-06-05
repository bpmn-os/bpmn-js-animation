import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import { classify, isStackable } from '../../lib/simulation/classify.js';

import miTaskXML from '../diagrams/mi-task.bpmn';
import eventSubXML from '../diagrams/event-subprocess.bpmn';
import boundaryXML from '../diagrams/boundary.bpmn';
import parallelXML from '../diagrams/parallel-gateway.bpmn';
import exclusiveXML from '../diagrams/exclusive-gateway.bpmn';
import subprocessXML from '../diagrams/subprocess.bpmn';

function classifyId(id) {
  return classify(get('elementRegistry').get(id));
}


describe('simulation/classify', function() {

  describe('multi-instance task diagram', function() {

    beforeEach(bootstrap(miTaskXML));
    afterEach(cleanup);

    it('classifies the process box', function() {
      expect(classifyId('Process_1')).to.include({ profile: 'activity', process: true });
    });

    it('classifies a multi-instance task', function() {
      expect(classifyId('MultiInstanceActivity_1')).to.include({
        key: 'task:task', profile: 'activity', task: 'task', multiInstance: true
      });
    });

    it('classifies start and end events', function() {
      expect(classifyId('StartEvent_1')).to.include({ profile: 'event', event: 'start' });
      expect(classifyId('Event_10nbvlp')).to.include({ profile: 'event', event: 'end' });
    });

    it('treats the MI activity as stackable', function() {
      expect(isStackable(get('elementRegistry').get('MultiInstanceActivity_1'))).to.be.true;
    });

  });


  describe('event sub-process diagram', function() {

    beforeEach(bootstrap(eventSubXML));
    afterEach(cleanup);

    it('classifies a non-interrupting event sub-process', function() {
      expect(classifyId('EventSubProcess_1')).to.include({
        key: 'eventSubProcess', profile: 'activity', eventSubProcess: true, interrupting: false
      });
    });

    it('treats a non-interrupting event sub-process as stackable', function() {
      expect(isStackable(get('elementRegistry').get('EventSubProcess_1'))).to.be.true;
    });

    it('classifies an intermediate throw event', function() {
      expect(classifyId('EscalationEvent_1')).to.include({ profile: 'event', event: 'throw' });
    });

    it('classifies a plain task', function() {
      expect(classifyId('Activity_1')).to.include({ task: 'task', multiInstance: false });
    });

  });


  describe('boundary event diagram', function() {

    beforeEach(bootstrap(boundaryXML));
    afterEach(cleanup);

    it('classifies an interrupting boundary event (cancelActivity default)', function() {
      expect(classifyId('BoundaryEvent_1')).to.include({
        profile: 'event', event: 'boundary', interrupting: true
      });
    });

  });


  describe('parallel gateway diagram', function() {

    beforeEach(bootstrap(parallelXML));
    afterEach(cleanup);

    it('classifies a parallel gateway', function() {
      expect(classifyId('Gateway_1')).to.include({
        key: 'gateway:parallel', profile: 'gateway', gateway: 'parallel'
      });
    });

  });


  describe('exclusive gateway diagram', function() {

    beforeEach(bootstrap(exclusiveXML));
    afterEach(cleanup);

    it('classifies an exclusive gateway', function() {
      expect(classifyId('Gateway_1')).to.include({
        key: 'gateway:exclusive', profile: 'gateway', gateway: 'exclusive'
      });
    });

  });


  describe('sub-process diagram', function() {

    beforeEach(bootstrap(subprocessXML));
    afterEach(cleanup);

    it('classifies a plain (non-event, non-MI) sub-process', function() {
      expect(classifyId('Activity_1')).to.include({
        key: 'subProcess', profile: 'activity', subProcess: true,
        eventSubProcess: false, multiInstance: false
      });
    });

    it('does not treat a plain sub-process as stackable', function() {
      expect(isStackable(get('elementRegistry').get('Activity_1'))).to.be.false;
    });

  });

});
