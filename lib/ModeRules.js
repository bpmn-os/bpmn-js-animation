import inherits from 'inherits';

import RuleProvider from 'diagram-js/lib/features/rules/RuleProvider';

/**
 * ModeRules — how a mode that is not `model` refuses modelling.
 *
 * diagram-js asks before it offers: the context pad omits an entry whose rule says no, the resize handles
 * are not drawn where a resize is refused, a drag will not engage, an alignment or a deletion is not
 * offered. Refusing through the rules therefore leaves an interface that tells the truth, where replacing
 * the modeller's methods left one that offered a gesture and then did nothing with it. It also needs no
 * list of methods kept in step with diagram-js, since a feature asks about its own operation of its own
 * accord.
 *
 * What a host may keep alive within the read-only mode is stated as {@link Mode}'s exceptions, in terms of
 * `modeling` operations, which is what a host thinks in and what it would call itself. The table below is
 * the only place that vocabulary meets diagram-js's rule names, so an exception written once holds however
 * the refusal is implemented.
 *
 * Programmatic modelling is deliberately untouched: a host calling `modeling.moveShape` during a run is
 * doing so on purpose, and diagram-js's own rules do not stand in the way of one either.
 */

// rule → the `modeling` operations it stands for, and how to read the elements it concerns from its context
const RULES = {
  'elements.move': { operations: [ 'moveElements', 'moveShape' ], elements: c => c.shapes },
  'shape.resize': { operations: [ 'resizeShape' ], elements: c => c.shape },
  'shape.create': { operations: [ 'createShape', 'appendShape' ], elements: c => [ c.shape, c.target ] },
  'elements.create': { operations: [ 'createShape', 'appendShape' ], elements: c => c.elements },
  'shape.attach': { operations: [ 'updateAttachment' ], elements: c => [ c.shape, c.target ] },
  'shape.replace': { operations: [ 'replaceShape' ], elements: c => c.element },
  'elements.delete': { operations: [ 'removeElements', 'removeShape', 'removeConnection' ],
    elements: c => c.elements },
  'connection.start': { operations: [ 'createConnection' ], elements: c => c.source },
  'connection.create': { operations: [ 'createConnection' ], elements: c => [ c.source, c.target ] },
  'connection.reconnect': { operations: [ 'reconnectStart', 'reconnectEnd' ],
    elements: c => [ c.connection, c.source, c.target ] },
  'connection.updateWaypoints': { operations: [ 'updateWaypoints' ], elements: c => c.connection },
  'element.copy': { operations: [ 'pasteElements' ], elements: c => c.element },
  'elements.align': { operations: [ 'alignElements' ], elements: c => c.elements },
  'elements.distribute': { operations: [ 'distributeElements' ], elements: c => c.elements },
  'element.autoResize': { operations: [ 'resizeShape' ], elements: c => c.elements }
};

// above every provider a host or bpmn-js registers, so a refusal is not overridden from below
const PRIORITY = 5000;

export default function ModeRules(eventBus, injector) {
  this._injector = injector;

  RuleProvider.call(this, eventBus);
}

ModeRules.$inject = [ 'eventBus', 'injector' ];

inherits(ModeRules, RuleProvider);

ModeRules.prototype.init = function() {
  Object.entries(RULES).forEach(([ rule, { operations, elements } ]) => {
    this.addRule(rule, PRIORITY, (context) => {
      const mode = this._mode();

      // in `model` mode, and in a viewer without the mode service, nothing here has anything to say
      if (!mode || !mode.isModellingDisabled()) {
        return;
      }

      return permits(mode, operations, elements(context || {}));
    });
  });
};

// resolved lazily: the rules are registered as the provider is constructed, which is before the mode
// service is necessarily built, and a rule is asked only once the diagram is running
ModeRules.prototype._mode = function() {
  return this._injector.get('mode', false);
};

/**
 * Whether an exception permits one of the operations a rule stands for, on every element it concerns.
 *
 * `false` refuses, and nothing at all leaves the question to the rules below, so an operation a mode permits
 * is still subject to whatever the model itself says about it — a text annotation may be moved because the
 * host permits it, and still not be dropped somewhere bpmn-js forbids.
 */
function permits(mode, operations, elements) {
  const named = [].concat(elements || []).filter(element => element && element.id);

  const allowed = named.length > 0 &&
    named.every(element => operations.some(operation => mode.allows(operation, element)));

  return allowed ? undefined : false;
}
