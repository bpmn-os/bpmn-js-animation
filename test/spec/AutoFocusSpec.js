import { expect } from 'chai';

import { bootstrap, cleanup, get } from '../TestHelper';

import linearXML from '../diagrams/linear.bpmn';

/**
 * Auto-focus is a setting of the animator's, not of any control drawn for it.
 *
 * It governs the canvas — while it is on, every event brings its instance to the front and drills to its
 * plane before animating — so a host draws the control where its own furniture over the canvas goes, and may
 * draw more than one. That is why the state is readable and announced rather than held inside a checkbox:
 * two controls over one state can only agree if neither of them owns it.
 */
describe('Auto-focus, the setting a host draws a control for', function() {

  afterEach(cleanup);

  // `animator: {}` states no opinion, where the test helper otherwise turns the setting off for the specs
  // that are about something else (see TestHelper).
  describe('by default', function() {

    beforeEach(bootstrap(linearXML, { animator: {} }));

    it('is on, and the animation is told so as the animator is built', function() {
      expect(get('animator').getAutoFocus()).to.be.true;
      expect(get('animation').isAutoFocus()).to.be.true;
    });
  });

  describe('when the host says otherwise', function() {

    beforeEach(bootstrap(linearXML, { animator: { autoFocus: false } }));

    it('is off', function() {
      expect(get('animator').getAutoFocus()).to.be.false;
      expect(get('animation').isAutoFocus()).to.be.false;
    });
  });

  describe('once a host writes it', function() {

    beforeEach(bootstrap(linearXML, { animator: {} }));

    function announced() {
      const seen = [];

      get('eventBus').on('autoFocus.changed', (event) => seen.push(event.autoFocus));

      return seen;
    }

    it('is announced with the value it now has', function() {
      const seen = announced();

      get('animator').autoFocus(false);

      expect(get('animator').getAutoFocus()).to.be.false;
      expect(seen).to.eql([ false ]);

      get('animator').autoFocus(true);
      expect(seen).to.eql([ false, true ]);
    });

    it('announces nothing when it is written what it already is', function() {
      const seen = announced();

      get('animator').autoFocus(true);
      get('animator').autoFocus(true);

      expect(seen).to.eql([], 'a control that writes what it reads sets nothing off');
    });

    it('reaches the animation, which is what makes the reveal happen', function() {
      get('animator').autoFocus(false);
      expect(get('animation').isAutoFocus()).to.be.false;

      get('animator').autoFocus(true);
      expect(get('animation').isAutoFocus()).to.be.true;
    });
  });
});
