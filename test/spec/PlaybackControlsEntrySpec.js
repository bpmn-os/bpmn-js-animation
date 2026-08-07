import { expect } from 'chai';

import createPlaybackControlsEntry from '../../lib/PlaybackControlsEntry';

// The control is plain DOM over two services, so it is exercised with stubs of them rather than a diagram.

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

const primitives = {
  getAnimationDuration: () => 500,
  setAnimationDuration: () => {}
};

// a playback stub: `source` is what the registered log source answers, `streaming` what the player says
function stub({ source, streaming }) {
  const played = [];

  return {
    played,
    getState: () => 'idle',
    getLogSource: () => (source === undefined ? null : () => source),
    isStreaming: streaming === undefined ? undefined : () => streaming,
    play: (log) => played.push(log)
  };
}

describe('createPlaybackControlsEntry', function() {

  let warned;
  const realWarn = console.warn;

  beforeEach(function() {
    warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
  });

  afterEach(function() {
    console.warn = realWarn;
  });

  it('plays what the log source answers', async function() {
    const playback = stub({ source: [ { token: {} } ] });

    createPlaybackControlsEntry({ playback, primitives }).runButton.click();
    await flush();

    expect(playback.played).to.have.length(1);
    expect(warned).to.be.empty;
  });

  // A run produced as it is played begins with nothing: the player has opened a stream and the log it
  // answers with will grow. Refusing it would throw away a run already under way — a manual run standing
  // at its first decision, or one whose first step produced no record.
  it('plays an empty log while the player says its stream is open', async function() {
    const playback = stub({ source: [], streaming: true });

    createPlaybackControlsEntry({ playback, primitives }).runButton.click();
    await flush();

    expect(playback.played).to.have.length(1);
    expect(playback.played[0]).to.be.empty;
    expect(warned).to.be.empty;
  });

  it('refuses an empty log when no stream is open', async function() {
    const playback = stub({ source: [], streaming: false });

    createPlaybackControlsEntry({ playback, primitives }).runButton.click();
    await flush();

    expect(playback.played).to.be.empty;
    expect(warned.join('')).to.contain('no execution log to play');
  });

  // a player that does not produce runs at all answers nothing here, and is asked for a complete log
  it('refuses an empty log from a player that does not stream', async function() {
    const playback = stub({ source: [] });

    createPlaybackControlsEntry({ playback, primitives }).runButton.click();
    await flush();

    expect(playback.played).to.be.empty;
    expect(warned.join('')).to.contain('no execution log to play');
  });

  it('refuses when the source answers with nothing at all', async function() {
    const playback = stub({ source: null, streaming: true });

    createPlaybackControlsEntry({ playback, primitives }).runButton.click();
    await flush();

    expect(playback.played).to.be.empty;
    expect(warned.join('')).to.contain('no execution log to play');
  });

});
