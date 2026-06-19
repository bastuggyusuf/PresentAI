// PresentAI Background Service Worker (Manifest V3)
// Content script ile mesajlaşır, geçmiş oturumları storage'a yazar.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PresentAI] Extension yüklendi');
  chrome.storage.local.set({
    sessions: [],
    settings: { backendUrl: 'http://localhost:8000', apiKey: '' },
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'session_started') {
    console.log('[PresentAI] Oturum başladı:', sender.tab?.url);
    sendResponse({ ok: true });
  } else if (msg.type === 'session_stopped') {
    console.log('[PresentAI] Oturum bitti');
    // İleride: oturumu storage'a kaydet
    sendResponse({ ok: true });
  } else if (msg.type === 'get_settings') {
    chrome.storage.local.get('settings').then(d => sendResponse(d.settings || {}));
    return true; // async response
  } else if (msg.type === 'fetch_api') {
    const { url, options } = msg;
    fetch(url, options)
      .then(async response => {
        const contentType = response.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const data = isJson ? await response.json() : await response.text();
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          data: data
        };
      })
      .then(result => {
        sendResponse({ ok: true, result });
      })
      .catch(error => {
        console.error('[PresentAI Background] fetch_api error:', error);
        sendResponse({ ok: false, error: error.message });
      });
    return true; // Asenkron yanıt döneceğimizi bildirir
  }
});

// Toolbar icon click: popup açar (manifest'te default_popup tanımlı)
