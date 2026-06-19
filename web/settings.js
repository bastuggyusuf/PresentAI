// PresentAI — Settings Page Logic

const DEFAULTS = {
  backendUrl: 'http://localhost:8000',
  apiKey: '',
  wakeWord: 'Ceylan',
  frameInterval: 30,
  assistInterval: 30,
  username: 'Asia',
};

// ─── INIT ─────────────────────────────────────────────────────
function initSettings() {
  loadSettings();
  setupEventListeners();
  fetchModelInfo();
  fetchDbInfo();
}

// ─── LOAD / SAVE ──────────────────────────────────────────────
function loadSettings() {
  const saved = JSON.parse(localStorage.getItem('presentai_settings') || '{}');
  const s = { ...DEFAULTS, ...saved };

  document.getElementById('setting-backend-url').value = s.backendUrl;
  document.getElementById('setting-api-key').value = s.apiKey || '';
  document.getElementById('setting-wake-word').value = s.wakeWord;
  document.getElementById('setting-frame-interval').value = s.frameInterval;
  document.getElementById('setting-assist-interval').value = s.assistInterval;
  document.getElementById('setting-username').value = s.username;

  document.getElementById('frame-interval-value').textContent = `${s.frameInterval}s`;
  document.getElementById('assist-interval-value').textContent = `${s.assistInterval}s`;
}

function saveSettings() {
  const settings = {
    backendUrl: document.getElementById('setting-backend-url').value.trim(),
    apiKey: document.getElementById('setting-api-key').value.trim(),
    wakeWord: document.getElementById('setting-wake-word').value.trim(),
    frameInterval: parseInt(document.getElementById('setting-frame-interval').value),
    assistInterval: parseInt(document.getElementById('setting-assist-interval').value),
    username: document.getElementById('setting-username').value.trim(),
  };

  localStorage.setItem('presentai_settings', JSON.stringify(settings));
  showToast('✅', 'Ayarlar başarıyla kaydedildi!', 'green');
}

function resetSettings() {
  localStorage.removeItem('presentai_settings');
  loadSettings();
  showToast('🔄', 'Ayarlar varsayılanlara sıfırlandı.', 'blue');
}

// ─── EVENT LISTENERS ──────────────────────────────────────────
function setupEventListeners() {
  // Save button
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  // Reset button
  document.getElementById('btn-reset-settings').addEventListener('click', resetSettings);

  // Range sliders
  document.getElementById('setting-frame-interval').addEventListener('input', (e) => {
    document.getElementById('frame-interval-value').textContent = `${e.target.value}s`;
  });

  document.getElementById('setting-assist-interval').addEventListener('input', (e) => {
    document.getElementById('assist-interval-value').textContent = `${e.target.value}s`;
  });

  // Test connection
  document.getElementById('btn-test-connection').addEventListener('click', testConnection);

  // Clear DB
  document.getElementById('btn-clear-db').addEventListener('click', clearDatabase);
}

// ─── TEST CONNECTION ──────────────────────────────────────────
async function testConnection() {
  const statusEl = document.getElementById('connection-status');
  const btn = document.getElementById('btn-test-connection');
  const url = document.getElementById('setting-backend-url').value.trim();

  btn.disabled = true;
  btn.innerHTML = '<span class="animate-spin">⏳</span> Test ediliyor...';
  statusEl.classList.remove('hidden');
  statusEl.className = 'mt-3 text-sm text-yellow-300';
  statusEl.textContent = '⏳ Bağlantı test ediliyor...';

  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      statusEl.className = 'mt-3 text-sm text-green-400';
      statusEl.innerHTML = `✅ Bağlantı başarılı! Durum: ${data.status} — Model: ${data.model || 'Bilinmiyor'}`;
    } else {
      statusEl.className = 'mt-3 text-sm text-red-400';
      statusEl.textContent = `❌ Sunucu yanıt verdi ama hata var (${res.status})`;
    }
  } catch (err) {
    statusEl.className = 'mt-3 text-sm text-red-400';
    statusEl.textContent = '❌ Bağlantı kurulamadı. Backend çalışıyor mu?';
  }

  btn.disabled = false;
  btn.innerHTML = '<span>🔗</span> Test Et';
}

// ─── FETCH MODEL INFO ─────────────────────────────────────────
async function fetchModelInfo() {
  try {
    const url = document.getElementById('setting-backend-url').value.trim();
    const res = await fetch(`${url}/health`);
    if (res.ok) {
      const data = await res.json();
      document.getElementById('model-name').textContent = data.model || 'Bilinmiyor';
    }
  } catch {
    document.getElementById('model-name').textContent = 'Bağlantı yok';
    document.getElementById('model-name').className = 'font-bold text-red-400';
  }
}

// ─── FETCH DB INFO ────────────────────────────────────────────
async function fetchDbInfo() {
  try {
    const url = document.getElementById('setting-backend-url').value.trim();
    const res = await fetch(`${url}/api/presentations`, {
      headers: window.getHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('db-info').textContent = `${data.length} sunum kaydı mevcut`;
    }
  } catch {
    document.getElementById('db-info').textContent = 'Veritabanına erişilemiyor';
  }
}

// ─── CLEAR DATABASE ───────────────────────────────────────────
async function clearDatabase() {
  if (!confirm('⚠️ Tüm sunum verileriniz kalıcı olarak silinecek!\n\nDevam etmek istiyor musunuz?')) return;
  if (!confirm('🔴 Bu işlem geri alınamaz. Emin misiniz?')) return;

  try {
    const url = document.getElementById('setting-backend-url').value.trim();
    const res = await fetch(`${url}/api/presentations/clear`, {
      method: 'DELETE',
      headers: window.getHeaders()
    });
    if (res.ok) {
      showToast('🗑️', 'Tüm sunum verileri başarıyla silindi.', 'red');
      fetchDbInfo();
    } else {
      showToast('❌', 'Silme işlemi başarısız oldu.', 'red');
    }
  } catch {
    showToast('❌', 'Backend bağlantısı kurulamadı.', 'red');
  }
}

// ─── TOAST ────────────────────────────────────────────────────
function showToast(icon, message, color = 'purple') {
  const container = document.getElementById('toastContainer');
  const borderColor = {
    green: 'border-green-500/30',
    red: 'border-red-500/30',
    blue: 'border-blue-500/30',
    purple: 'border-purple-500/30',
  }[color] || 'border-slate-700';

  const toast = document.createElement('div');
  toast.className = `bg-slate-800 border ${borderColor} text-white px-6 py-3 rounded-xl shadow-2xl flex items-center gap-3 transition-all transform translate-y-10 opacity-0`;
  toast.innerHTML = `
    <span class="text-xl">${icon}</span>
    <div class="font-medium text-sm">${message}</div>
  `;
  container.appendChild(toast);

  setTimeout(() => toast.classList.remove('translate-y-10', 'opacity-0'), 10);

  setTimeout(() => {
    toast.classList.add('opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── BAŞLAT ───────────────────────────────────────────────────
initSettings();
