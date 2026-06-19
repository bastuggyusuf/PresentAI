// Popup logic — aktif tab'ı kontrol et, ayarları yükle/kaydet

const statusEl = document.getElementById('status');
const backendInput = document.getElementById('backend-url');
const keyInput = document.getElementById('api-key');

const SUPPORTED = [
  { host: 'meet.google.com', name: 'Google Meet', icon: '🟢' },
  { host: 'zoom.us', name: 'Zoom', icon: '🔵' },
  { host: 'teams.microsoft.com', name: 'Microsoft Teams', icon: '🟣' },
];

async function checkActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const url = tab.url || '';
  const supported = SUPPORTED.find(s => url.includes(s.host));
  if (supported) {
    statusEl.innerHTML = `${supported.icon} <strong>${supported.name}</strong> sayfasındasın.<br>PresentAI overlay'i sağ üstte görünmeli.`;
  } else {
    statusEl.innerHTML = '⚠️ Desteklenen bir sayfada değilsin.<br>Google Meet, Zoom veya Teams aç.';
  }
}

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const backendUrl = settings.backendUrl || 'http://localhost:8000';
  backendInput.value = backendUrl;
  keyInput.value = settings.apiKey || '';
  
  const dashLink = document.getElementById('dashboard-link');
  if (dashLink) {
    dashLink.href = `${backendUrl}/web/dashboard.html`;
  }
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const backendUrl = backendInput.value.trim();
  await chrome.storage.local.set({
    settings: {
      backendUrl: backendUrl,
      apiKey: keyInput.value.trim(),
    },
  });
  
  const dashLink = document.getElementById('dashboard-link');
  if (dashLink) {
    dashLink.href = `${backendUrl}/web/dashboard.html`;
  }
  
  const btn = document.getElementById('save-settings');
  const oldText = btn.textContent;
  btn.textContent = '✓ Kaydedildi';
  setTimeout(() => btn.textContent = oldText, 1500);
});

async function loadStats() {
  const { sessions = [] } = await chrome.storage.local.get('sessions');
  document.getElementById('total-count').textContent = sessions.length;
  // Bu oturum için: son 1 saat içindeki sayım
  const oneHourAgo = Date.now() - 3600_000;
  const recent = sessions.filter(s => s.timestamp > oneHourAgo).length;
  document.getElementById('session-count').textContent = recent;
}

checkActiveTab();
loadSettings();
loadStats();
