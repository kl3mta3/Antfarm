// The house farm's own thread.
//
// The simulation used to share a thread with the web server, so a busy farm
// (a big nest at 24×) left page loads, the live stream and the health check
// waiting their turn behind the ticks. Here it gets a thread to itself: it
// ticks, builds the frames viewers are sent, and saves, and the server only
// passes messages. Whatever the farm is doing, the server stays responsive.
//
// Messages from the server:
//   { type: 'watching', on }            whether anyone is watching (frames are
//                                        only built when someone is)
//   { type: 'call', id, method, arg }    a request; answered with
//                                        { type: 'reply', id, result | error }
// Messages to the server:
//   { type: 'frame', event, data }      the next frame, FRAME_HZ times a second
const { parentPort, workerData } = require('worker_threads');
const { createHouse } = require('./house');

const { root, dataFile, build, frameHz, saveSeconds } = workerData;
const house = createHouse({ root, dataFile, build });
house.start();

let watching = false;
setInterval(() => {
  if (!watching) return;
  const f = house.frame();
  parentPort.postMessage({ type: 'frame', event: f.event, data: f.data });
}, 1000 / frameHz);

function save(why) {
  try { house.save(); return true; }
  catch (e) { console.error('Could not save the house farm (' + why + '): ' + e.message); return false; }
}
setInterval(() => save('periodic'), saveSeconds * 1000);

const METHODS = {
  keyframe: () => house.keyframe(false),
  pheromones: () => house.pheromones(),
  status: () => house.status(),
  ant: i => house.ant(i),
  // The server's reply to a keeper includes the controls as they now stand.
  act: a => ({ result: house.act(a), status: house.status() }),
  save: why => save(why),
};

parentPort.on('message', m => {
  if (m.type === 'watching') { watching = !!m.on; return; }
  if (m.type !== 'call') return;
  let reply;
  try {
    if (!Object.prototype.hasOwnProperty.call(METHODS, m.method)) throw new Error('Unknown request: ' + m.method);
    reply = { type: 'reply', id: m.id, result: METHODS[m.method](m.arg) };
  } catch (e) {
    reply = { type: 'reply', id: m.id, error: e.message };
  }
  parentPort.postMessage(reply);
});
