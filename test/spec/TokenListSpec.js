import { expect } from 'chai';

import createTokenList from '../../lib/TokenList';

// createTokenList is plain DOM (it needs no diagram services), so it is exercised directly.

function token(node, label, extra = {}) {
  return { node, label, color: '#3399ff', state: {}, ...extra };
}

describe('createTokenList', function() {

  let list;

  beforeEach(function() {
    list = createTokenList();
  });

  describe('keying', function() {

    it('keys a row by its node and label', function() {
      list.add(token('Task_1', 'I1'));

      expect(list.keys()).to.eql([ 'Task_1|I1' ]);
    });

    it('gives two tokens of one label at different nodes two rows', function() {
      list.add(token('Task_1', 'I1'));
      list.add(token('Task_2', 'I1'));

      expect(list.element.children).to.have.length(2);
      expect(list.keys()).to.eql([ 'Task_1|I1', 'Task_2|I1' ]);
    });

    it('gives two tokens of one identity one row', function() {
      const first = list.add(token('Task_1', 'I1'));
      const second = list.add(token('Task_1', 'I1', { color: '#ff0000' }));

      expect(second).to.equal(first);
      expect(list.element.children).to.have.length(1);
    });

    it('honours a key the caller supplies', function() {
      const byLabel = createTokenList({ key: (t) => t.label });

      byLabel.add(token('Task_1', 'I1'));
      byLabel.add(token('Task_2', 'I1'));

      expect(byLabel.element.children).to.have.length(1);
      expect(byLabel.keys()).to.eql([ 'I1' ]);
    });

  });

  describe('rekey', function() {

    it('keeps the row itself', function() {
      const entry = list.add(token('Task_1', 'I1'));
      const element = entry.element;

      const rekeyed = list.rekey(token('Task_1', 'I1'), token('Task_2', 'I1'));

      expect(rekeyed).to.equal(entry);
      expect(list.element.children[0]).to.equal(element);
      expect(element.parentNode).to.equal(list.element);
      expect(list.keys()).to.eql([ 'Task_2|I1' ]);
    });

    it('keeps the body it was drawn with', function() {
      const detailed = createTokenList({ renderDetail: (t, el) => { el.textContent = t.node; } });
      const entry = detailed.add(token('Task_1', 'I1'));
      const body = entry.contentEl;

      detailed.rekey(token('Task_1', 'I1'), token('Task_2', 'I1'));

      expect(entry.element.contains(body)).to.be.true;
      expect(body.textContent).to.equal('Task_2');
    });

    it('updates the row from its new token', function() {
      const entry = list.add(token('Task_1', 'I1'));

      list.rekey(token('Task_1', 'I1'), token('Task_2', 'I1'));

      expect(entry.token().node).to.equal('Task_2');
      expect(entry.element.querySelector('.bjs-token-node').textContent).to.equal('Task_2');
    });

    it('leaves the row where it stands', function() {
      list.add(token('Task_1', 'I1'));
      list.add(token('Task_1', 'I2'));
      list.add(token('Task_1', 'I3'));

      list.rekey(token('Task_1', 'I2'), token('Task_2', 'I2'));

      expect(list.keys()).to.eql([ 'Task_1|I1', 'Task_2|I2', 'Task_1|I3' ]);
    });

    it('adds nothing for a token it does not list', function() {
      const rekeyed = list.rekey(token('Task_1', 'I1'), token('Task_2', 'I1'));

      expect(rekeyed).to.be.undefined;
      expect(list.element.children).to.have.length(0);
    });

    it('keeps the listed row when the new key is taken', function() {
      const moving = list.add(token('Task_1', 'I1'));
      const listed = list.add(token('Task_2', 'I1'));

      const rekeyed = list.rekey(token('Task_1', 'I1'), token('Task_2', 'I1'));

      expect(rekeyed).to.equal(listed);
      expect(moving.element.parentNode).to.be.null;
      expect(list.keys()).to.eql([ 'Task_2|I1' ]);
    });

  });

  describe('the rest of the list', function() {

    it('removes, updates and reads back by the pair', function() {
      const entry = list.add(token('Task_1', 'I1'));

      expect(list.has(token('Task_1', 'I1'))).to.be.true;
      expect(list.has(token('Task_2', 'I1'))).to.be.false;
      expect(list.get(token('Task_1', 'I1'))).to.equal(entry);

      list.update(token('Task_1', 'I1', { color: '#ff0000' }));
      expect(entry.token().color).to.equal('#ff0000');

      list.remove(token('Task_1', 'I1'));
      expect(list.element.children).to.have.length(0);
      expect(list.keys()).to.eql([]);
    });

    it('reconciles to exactly the tokens it is given', function() {
      list.add(token('Task_1', 'I1'));
      list.add(token('Task_2', 'I2'));

      list.sync([ token('Task_2', 'I2'), token('Task_3', 'I3') ]);

      expect(list.keys()).to.eql([ 'Task_2|I2', 'Task_3|I3' ]);
    });

  });

});
