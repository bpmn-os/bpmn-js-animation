import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import simpleProcessXML from '../../examples/simple-process.bpmn';
import gatewaysXML from '../../examples/gateways.bpmn';
import collapsedSubprocessXML from '../../examples/collapsed-subprocess.bpmn';
import linkEventsXML from '../../examples/link-events.bpmn';
import eventBasedXML from '../../examples/event-based-gateway.bpmn';
import multiInstanceXML from '../../examples/multi-instance.bpmn';
import collaborationXML from '../../examples/collaboration.bpmn';

import simpleProcessLog from '../../examples/simple-process.json';
import gatewaysLog from '../../examples/gateways.json';
import collapsedSubprocessLog from '../../examples/collapsed-subprocess.json';
import linkEventsLog from '../../examples/link-events.json';
import eventBasedLog from '../../examples/event-based-gateway.json';
import multiInstanceLog from '../../examples/multi-instance.json';
import collaborationLog from '../../examples/collaboration.json';

// Every bundled showcase log must replay through the `animator` and clean up after itself — no token,
// stack, or process box left behind. This is the guard that the derived removals (a scope's consume
// garbage-collecting its untriggered boundary listeners and event-sub waiters, an event-based gateway
// cancelling its losing branches) actually reach every token the log no longer consumes explicitly.
describe('execution-log playback (every bundled example)', function() {

  const EXAMPLES = [
    { name: 'simple-process', xml: simpleProcessXML, log: simpleProcessLog },
    { name: 'gateways', xml: gatewaysXML, log: gatewaysLog },
    { name: 'collapsed-subprocess', xml: collapsedSubprocessXML, log: collapsedSubprocessLog },
    { name: 'link-events', xml: linkEventsXML, log: linkEventsLog },
    { name: 'event-based-gateway', xml: eventBasedXML, log: eventBasedLog },
    { name: 'multi-instance', xml: multiInstanceXML, log: multiInstanceLog },
    { name: 'collaboration', xml: collaborationXML, log: collaborationLog }
  ];

  afterEach(cleanup);

  for (const { name, xml, log } of EXAMPLES) {
    it(`${name} replays to a clean finish`, async function() {
      await bootstrap(xml, { animation: { animationDuration: 0 } })();

      const animator = get('animator');
      animator.autoFocus(true);
      await animator.replay(log);

      expect(get('primitives').getTokens(), `${name}: all tokens consumed`).to.have.length(0);
    });
  }

  it('multi-instance: all three MI sub-instances stack before any is consumed', async function() {
    await bootstrap(multiInstanceXML, { animation: { animationDuration: 0 } })();

    const animator = get('animator');
    animator.autoFocus(true);
    // entries 0..14 create the three Activity_2 sub-instances (no consume yet)
    await animator.replay(multiInstanceLog.slice(0, 15));

    expect(get('primitives').getStacks('Activity_2'), 'three MI instances stacked').to.have.length(3);
  });
});
