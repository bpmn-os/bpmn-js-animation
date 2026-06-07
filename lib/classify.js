import { is } from 'bpmn-js/lib/util/ModelUtil';

/**
 * Classify a bpmn-js element into the descriptor the SimulationAPI branches on —
 * the single place every *static* BPMN read lives (type, loop characteristics,
 * triggeredByEvent, isInterrupting, gateway kind, …). The functions never read the
 * moddle directly; they call `classify` and switch on the result.
 *
 * Returns `{ key, profile, … }`:
 *  - `profile`: `'activity'` (top-edge lifecycle sweep) | `'event'` | `'gateway'` |
 *    `'container'` (pool) — drives the Part C position lookup.
 *  - `key`: a stable string for the prescribed-behaviour table (icon cues etc.).
 *  - flags the functions need: `multiInstance`, `eventSubProcess`, `interrupting`,
 *    `collapsed`, plus `gateway`/`event`/`task`/`process` sub-kinds.
 *
 * @param {import('diagram-js/lib/model').Base} element
 * @return {{ key: string, profile: string|null, [k: string]: any }}
 */
export function classify(element) {
  const bo = element && element.businessObject;

  if (!bo) {
    return { key: 'unknown', profile: null };
  }

  // gateways — single center point
  if (is(element, 'bpmn:Gateway')) {
    const gateway =
      is(element, 'bpmn:ParallelGateway') ? 'parallel' :
      is(element, 'bpmn:InclusiveGateway') ? 'inclusive' :
      is(element, 'bpmn:EventBasedGateway') ? 'eventBased' :
      is(element, 'bpmn:ComplexGateway') ? 'complex' :
      'exclusive';
    return { key: 'gateway:' + gateway, profile: 'gateway', gateway };
  }

  // events — single center point
  if (is(element, 'bpmn:Event')) {
    if (is(element, 'bpmn:BoundaryEvent')) {
      // cancelActivity defaults to true ⇒ interrupting
      return {
        key: 'event:boundary', profile: 'event', event: 'boundary',
        interrupting: bo.cancelActivity !== false,
        attachedTo: bo.attachedToRef && bo.attachedToRef.id
      };
    }
    if (is(element, 'bpmn:StartEvent')) {
      // isInterrupting defaults to true (only meaningful inside an event sub-process)
      return {
        key: 'event:start', profile: 'event', event: 'start',
        interrupting: bo.isInterrupting !== false
      };
    }
    if (is(element, 'bpmn:EndEvent')) {
      return { key: 'event:end', profile: 'event', event: 'end' };
    }
    const throwing = is(element, 'bpmn:IntermediateThrowEvent');
    return {
      key: throwing ? 'event:throw' : 'event:catch', profile: 'event',
      event: throwing ? 'throw' : 'catch'
    };
  }

  // pool / participant — container
  if (is(element, 'bpmn:Participant')) {
    return { key: 'participant', profile: 'container' };
  }

  // implicit process box — activity profile, the root plane element
  if (is(element, 'bpmn:Process')) {
    return { key: 'process', profile: 'activity', process: true };
  }

  // activities — top-edge lifecycle sweep
  if (is(element, 'bpmn:Activity')) {
    const multiInstance = isMultiInstance(bo);
    const loop = isStandardLoop(bo);

    if (is(element, 'bpmn:SubProcess')) {
      const eventSubProcess = !!bo.triggeredByEvent;
      return {
        key: eventSubProcess ? 'eventSubProcess' : 'subProcess',
        profile: 'activity',
        subProcess: true,
        eventSubProcess,
        multiInstance,
        loop,
        collapsed: element.collapsed === true,
        interrupting: eventSubProcess ? eventSubStartInterrupting(bo) : undefined
      };
    }

    if (is(element, 'bpmn:CallActivity')) {
      return { key: 'callActivity', profile: 'activity', multiInstance, loop };
    }

    const task =
      is(element, 'bpmn:SendTask') ? 'send' :
      is(element, 'bpmn:ReceiveTask') ? 'receive' :
      is(element, 'bpmn:UserTask') ? 'user' :
      is(element, 'bpmn:ManualTask') ? 'manual' :
      is(element, 'bpmn:ServiceTask') ? 'service' :
      is(element, 'bpmn:ScriptTask') ? 'script' :
      is(element, 'bpmn:BusinessRuleTask') ? 'businessRule' :
      'task';
    return { key: 'task:' + task, profile: 'activity', task, multiInstance, loop };
  }

  return { key: 'unknown', profile: null };
}

/**
 * A node whose instances stack: the process, a multi-instance activity, or a
 * non-interrupting event sub-process. (Mirrors the example's `isStackable`.)
 */
export function isStackable(element) {
  const c = classify(element);
  if (c.process) {
    return true;
  }
  if (c.multiInstance) {
    return true;
  }
  if (c.eventSubProcess) {
    return c.interrupting === false;
  }
  return false;
}

function isMultiInstance(bo) {
  return !!(bo.loopCharacteristics &&
    bo.loopCharacteristics.$type === 'bpmn:MultiInstanceLoopCharacteristics');
}

// A standard loop (the ↻ marker) — repeats sequentially on one token, so it may re-enter
// `ready`. (bpmn-js exposes no helper; its renderer reads loopCharacteristics inline too.)
function isStandardLoop(bo) {
  return !!(bo.loopCharacteristics &&
    bo.loopCharacteristics.$type === 'bpmn:StandardLoopCharacteristics');
}

// An event sub-process is interrupting iff its (single) start event is interrupting.
function eventSubStartInterrupting(bo) {
  const start = (bo.flowElements || []).find(fe => fe.$type === 'bpmn:StartEvent');
  return start ? start.isInterrupting !== false : true;
}
