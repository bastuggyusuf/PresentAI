// PresentAI — Kurumsal Veri Setleri Sayfa Mantığı

// local storage ayarlarını al
const settings = JSON.parse(localStorage.getItem('presentai_settings') || '{}');
const BACKEND_URL = window.BACKEND_URL;
const USERNAME = settings.username || 'Asia';

// Durum değişkenleri
let selectedFile = null;
let allDatasets = [];
let activeCategory = 'all';

// Emojiler ve Renkler
const CAT_INFO = {
  "Şirket Genel Bilgileri": { emoji: "🏢", bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-400" },
  "Hedefler & Projeler": { emoji: "🎯", bg: "bg-purple-500/10", border: "border-purple-500/30", text: "text-purple-400" },
  "Yatırımcı Hazırlığı": { emoji: "🤝", bg: "bg-green-500/10", border: "border-green-500/30", text: "text-green-400" },
  "Anlaşma & Teklif": { emoji: "💼", bg: "bg-pink-500/10", border: "border-pink-500/30", text: "text-pink-400" }
};

// ─── INITIALIZE ──────────────────────────────────────────────────
function init() {
  document.getElementById('header-username').textContent = USERNAME;
  setupDragAndDrop();
  setupFormSubmit();
  setupFilters();
  loadDatasets();
}

// ─── DRAG & DROP VE DOSYA SEÇİMİ ──────────────────────────────────
function setupDragAndDrop() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const removeFileBtn = document.getElementById('removeFileBtn');

  // Tıklama ile seçme
  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  // Sürükleme Olayları
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    handleFiles(dt.files);
  });

  // Kaldırma butonu
  removeFileBtn.addEventListener('click', () => {
    selectedFile = null;
    fileInput.value = '';
    document.getElementById('fileInfo').classList.add('hidden');
    dropZone.classList.remove('hidden');
  });
}

function handleFiles(files) {
  if (files.length === 0) return;
  const file = files[0];

  // Dosya tipi doğrulaması (Sadece PDF)
  if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
    showToast('⚠️', 'Lütfen sadece PDF dosyası yükleyin.', 'red');
    return;
  }

  // Boyut doğrulaması (Maks 20MB)
  const maxBytes = 20 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast('⚠️', 'Dosya boyutu 20MB\'tan büyük olamaz.', 'red');
    return;
  }

  selectedFile = file;
  
  // Arayüzü güncelle
  document.getElementById('selectedFileName').textContent = `${file.name} (${formatBytes(file.size)})`;
  document.getElementById('fileInfo').classList.remove('hidden');
  document.getElementById('dropZone').classList.add('hidden');
}

// ─── VERİ SETLERİNİ GETİRME ───────────────────────────────────────
async function loadDatasets() {
  const listEl = document.getElementById('datasetList');
  listEl.innerHTML = '<div class="text-center p-12 text-slate-400">Yükleniyor...</div>';

  try {
    const res = await fetch(`${BACKEND_URL}/api/datasets`, { headers: window.getHeaders() });
    if (!res.ok) throw new Error('API Bağlantı Hatası');
    allDatasets = await res.json();
    
    filterAndRender();
  } catch (err) {
    listEl.innerHTML = '<div class="text-center p-12 text-red-400">Veriler sunucudan alınamadı. Backend bağlantısını kontrol edin.</div>';
    console.error(err);
  }
}

// ─── VERİ SETLERİNİ LİSTELEME ─────────────────────────────────────
function renderDatasets(datasets) {
  const listEl = document.getElementById('datasetList');
  const activeCountText = document.getElementById('activeCountText');
  
  if (datasets.length === 0) {
    listEl.innerHTML = `
      <div class="text-center p-12 border border-dashed border-slate-800 rounded-2xl bg-slate-950/20 text-slate-500">
        <div class="text-4xl mb-3">📁</div>
        <p class="font-semibold text-slate-400 mb-1">Kütüphane Boş</p>
        <p class="text-xs text-slate-500">Henüz kurumsal bir veri seti eklemediniz.</p>
      </div>
    `;
    activeCountText.textContent = '0 Aktif';
    return;
  }

  // Aktif veri setlerini say (tüm kütüphane genelinde)
  const activeCount = allDatasets.filter(d => d.is_active === 1).length;
  activeCountText.textContent = `${activeCount} Aktif`;

  listEl.innerHTML = datasets.map(d => {
    const cat = CAT_INFO[d.category] || { emoji: "📄", bg: "bg-slate-800", border: "border-slate-700", text: "text-slate-300" };
    const checkedAttr = d.is_active === 1 ? 'checked' : '';
    
    return `
      <div class="dataset-card flex flex-col md:flex-row md:items-center justify-between p-5 border border-slate-800 bg-slate-900/40 rounded-2xl gap-4">
        <!-- Sol kısım: Bilgi ve Simge -->
        <div class="flex items-center gap-4 min-w-0">
          <div class="w-12 h-12 rounded-xl ${cat.bg} border ${cat.border} flex items-center justify-center text-xl shrink-0">
            ${cat.emoji}
          </div>
          <div class="min-w-0">
            <h3 class="font-bold text-white text-base truncate">${escapeHtml(d.name)}</h3>
            <div class="flex items-center gap-2 text-xs text-slate-500 mt-1 flex-wrap">
              <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-semibold">${escapeHtml(d.category)}</span>
              <span>•</span>
              <span class="truncate max-w-[150px]" title="${escapeHtml(d.filename)}">📂 ${escapeHtml(d.filename)}</span>
              <span>•</span>
              <span>⚖️ ${formatBytes(d.file_size)}</span>
              <span>•</span>
              <span>📅 ${formatDate(d.upload_date)}</span>
            </div>
          </div>
        </div>

        <!-- Sağ Kısım: Toggle ve Silme -->
        <div class="flex items-center justify-between md:justify-end gap-6 border-t border-slate-800 md:border-none pt-3 md:pt-0">
          <!-- Toggle Butonu -->
          <div class="flex items-center gap-2.5">
            <span class="text-xs font-semibold ${d.is_active === 1 ? 'text-purple-400' : 'text-slate-500'} transition">
              ${d.is_active === 1 ? 'Sunumda Aktif' : 'Pasif'}
            </span>
            <div class="relative inline-block w-10 align-middle select-none">
              <input type="checkbox" id="toggle-${d.id}" ${checkedAttr} onclick="toggleActive(${d.id})"
                class="toggle-checkbox absolute block w-5 h-5 rounded-full bg-slate-800 border-2 border-slate-700 appearance-none cursor-pointer checked:border-purple-500 right-5 checked:right-0 transition-all">
              <label for="toggle-${d.id}" class="toggle-label block overflow-hidden h-5 rounded-full bg-slate-950 cursor-pointer border border-slate-800"></label>
            </div>
          </div>

          <!-- Silme Butonu -->
          <button onclick="deleteDataset(${d.id}, '${d.name.replace(/'/g, "\\'")}')" class="p-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 hover:text-red-300 rounded-xl transition cursor-pointer">
            🗑️
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// ─── KATEGORİ FİLTRELEME MANTIĞI ──────────────────────────────────
function setupFilters() {
  const buttons = document.querySelectorAll('.filter-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Deaktif et diğerlerini
      buttons.forEach(b => {
        b.classList.remove('active', 'bg-purple-600', 'text-white');
        b.classList.add('border-slate-800', 'text-slate-400');
      });
      
      // Aktif et seçileni
      btn.classList.add('active', 'bg-purple-600', 'text-white');
      btn.classList.remove('border-slate-800', 'text-slate-400');
      
      activeCategory = btn.getAttribute('data-category');
      filterAndRender();
    });
  });
}

function filterAndRender() {
  const filtered = activeCategory === 'all' 
    ? allDatasets 
    : allDatasets.filter(d => d.category === activeCategory);
  renderDatasets(filtered);
}

// ─── VERİ SETİ YÜKLEME ────────────────────────────────────────────
function setupFormSubmit() {
  const form = document.getElementById('uploadForm');
  const submitBtn = document.getElementById('submitBtn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!selectedFile) {
      showToast('⚠️', 'Lütfen bir PDF dosyası seçin.', 'red');
      return;
    }

    const name = document.getElementById('datasetName').value.trim();
    const category = document.getElementById('datasetCategory').value;

    if (!name) {
      showToast('⚠️', 'Lütfen veri seti tanımını girin.', 'red');
      return;
    }

    // Yükleme durumu göster
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="animate-spin">⏳</span> İndeksleniyor...';

    const formData = new FormData();
    formData.append('file', selectedFile);
    formData.append('name', name);
    formData.append('category', category);

    try {
      const res = await fetch(`${BACKEND_URL}/api/datasets`, {
        method: 'POST',
        headers: window.getHeaders(null),
        body: formData
      });

      if (!res.ok) throw new Error('API Yükleme Hatası');
      const data = await res.json();

      showToast('✅', 'Veri seti başarıyla yüklendi ve yapay zeka hafızasına eklendi.', 'green');
      
      // Formu sıfırla
      form.reset();
      selectedFile = null;
      document.getElementById('fileInfo').classList.add('hidden');
      document.getElementById('dropZone').classList.remove('hidden');
      
      // Listeyi yenile
      loadDatasets();
    } catch (err) {
      showToast('❌', 'Veri seti yüklenemedi. Sunucu hatası.', 'red');
      console.error(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>🚀</span> Veri Setini Yükle';
    }
  });
}

// ─── AKTİFLİK DURUMUNU DEĞİŞTİRME ──────────────────────────────────
async function toggleActive(id) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/datasets/${id}/toggle`, {
      method: 'PUT',
      headers: window.getHeaders()
    });
    if (!res.ok) throw new Error('API Hatası');
    const data = await res.json();
    
    showToast('🔄', `Veri seti durumu güncellendi: ${data.is_active === 1 ? 'Aktif' : 'Pasif'}`, 'purple');
    loadDatasets();
  } catch (err) {
    showToast('❌', 'Durum güncellenemedi. Sunucu hatası.', 'red');
    console.error(err);
  }
}

// ─── VERİ SETİ SİLME ──────────────────────────────────────────────
async function deleteDataset(id, name) {
  if (!confirm(`"${name}" isimli veri setini tamamen silmek istediğinizden emin misiniz?\n\nBu işlem veri setini yapay zeka asistanı hafızasından ve sistemden kalıcı olarak silecektir.`)) {
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/datasets/${id}`, {
      method: 'DELETE',
      headers: window.getHeaders()
    });
    if (!res.ok) throw new Error('API Hatası');
    
    showToast('🗑️', 'Veri seti sistemden ve AI hafızasından silindi.', 'red');
    loadDatasets();
  } catch (err) {
    showToast('❌', 'Silme işlemi başarısız oldu.', 'red');
    console.error(err);
  }
}

// ─── YARDIMCI FONKSİYONLAR ────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return dateStr;
    const months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return dateStr;
  }
}

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

// Başlat
init();
