/**
 * relay.js — isolated-world content script on supplynote.in.
 *
 * A content script cannot see the page's `window.angular`, and an injected
 * MAIN-world script cannot talk to `chrome.runtime`. This file is the thin
 * bridge between the two:
 *
 *   service worker --chrome.runtime--> relay.js --window.postMessage--> bridge.js
 *   bridge.js --window.postMessage--> relay.js --chrome.runtime--> service worker
 *
 * It contains no automation logic and should never need changing.
 */
(() => {
  const NS = 'SNACC_PO';
  let tabId = null;

  // The service worker tells us our own tab id once, so that responses can be
  // correlated without an extra round-trip per message.
  chrome.tabs?.getCurrent?.((tab) => {
    if (tab?.id !== undefined) tabId = tab.id;
  });

  // Responses and broadcasts coming back from the MAIN world.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS || data.__dir !== 'res') return;
    try {
      chrome.runtime.sendMessage({
        kind: 'bridge-response',
        payload: {
          id: data.id,
          ok: data.ok,
          result: data.result,
          error: data.error,
          broadcast: data.broadcast,
          // Streaming step-by-step updates from a long-running command such as
          // runPo. These must not resolve the pending request.
          progress: data.progress,
          partial: !!data.partial,
          tabId: tabId
        }
      });
    } catch {
      // The service worker may have been torn down mid-run; the orchestrator
      // retries, so dropping a stray response is safe.
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind !== 'bridge-command') return false;
    if (message.tabId !== undefined) tabId = message.tabId;

    window.postMessage(
      { __ns: NS, __dir: 'cmd', id: message.id, type: message.type, args: message.args },
      '*'
    );

    // Acknowledge receipt immediately. The actual result comes back
    // asynchronously via the window message listener above.
    sendResponse({ accepted: true, tabId });
    return false;
  });

  // Tell the service worker we are alive on this page, so it does not have to
  // poll with executeScript to discover that.
  try {
    chrome.runtime.sendMessage({ kind: 'relay-ready', url: location.href, title: document.title, tabId });
  } catch {
    /* extension was reloaded; nothing to do */
  }
})();
