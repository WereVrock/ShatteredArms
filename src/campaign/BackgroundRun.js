// Helpers that keep a long headless run going while the browser tab is in
// the background.
//
// Browsers clamp setTimeout in hidden tabs to about once per second (and
// to once per minute after a few minutes), which turns a run that yields
// every 50 ms into a crawl. MessageChannel messages are not timers, so
// yielding through one is not throttled that way.
//
// A held Web Lock also asks Chrome not to freeze the page. It is a no-op
// where navigator.locks does not exist (insecure context, old browser).

const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const waiting = [];

if (channel) {
  channel.port1.onmessage = () => {
    const resolve = waiting.shift();
    if (resolve) resolve();
  };
}

// Lets the browser handle pending events (clicks, the Stop button, DOM
// updates), then continues. Not subject to background-tab timer clamping.
export function yieldToEventLoop() {
  if (!channel) return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
}

// Runs `task` (a function returning a promise) while holding a Web Lock.
export function runWithKeepAlive(task) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!locks || typeof locks.request !== 'function') {
    return Promise.resolve().then(task);
  }
  return locks.request('shattered-arms-ai-campaign', () => task());
}