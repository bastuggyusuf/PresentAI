// PresentAI — Statistics Page Logic

const COLORS = {
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  green: '#10b981',
  yellow: '#f59e0b',
  red: '#ef4444',
  cyan: '#06b6d4',
  orange: '#f97316',
};

const EMOTION_EMOJIS = {
  Happy: '😊', Neutral: '😐', Surprise: '😲', Sad: '😢',
  Angry: '😡', Fear: '😨', Disgust: '🤢',
};

let allPresentations = [];
let charts = {};

// ─── INIT ─────────────────────────────────────────────────────
async function initStatistics() {
  try {
    const base = window.BACKEND_URL;
    const res = await fetch(`${base}/api/presentations`, { headers: window.getHeaders() });
    if (!res.ok) throw new Error('API Error');
    allPresentations = await res.json();

    if (allPresentations.length === 0) {
      document.querySelector('main').innerHTML = `
        <div class="text-center py-20">
          <div class="text-6xl mb-4">📊</div>
          <div class="text-xl font-bold text-slate-300 mb-2">Henüz veri yok</div>
          <div class="text-sm text-slate-500">İlk sunumunuzu yapın, istatistikler burada görünecek!</div>
          <a href="dashboard.html" class="inline-block mt-6 px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-xl font-bold text-sm transition">← Dashboard'a Dön</a>
        </div>`;
      return;
    }

    applyFilter('7');
    setupFilterButtons();
  } catch (err) {
    document.querySelector('main').innerHTML = `
      <div class="text-center py-20 text-red-400">
        <div class="text-6xl mb-4">⚠️</div>
        <div class="text-xl font-bold mb-2">Veriler alınamadı</div>
        <div class="text-sm text-slate-500">Backend bağlantısını kontrol edin</div>
      </div>`;
    console.error(err);
  }
}

// ─── FILTER ───────────────────────────────────────────────────
function setupFilterButtons() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilter(btn.dataset.range);
    });
  });
}

function applyFilter(range) {
  let filtered;
  if (range === 'all') {
    filtered = allPresentations;
  } else {
    const days = parseInt(range);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    filtered = allPresentations.filter(p => new Date(p.date) >= cutoff);
  }

  if (filtered.length === 0) filtered = allPresentations;

  updateSummaryCards(filtered);
  updateBestWorst(filtered);
  renderAllCharts(filtered);
}

// ─── SUMMARY CARDS ────────────────────────────────────────────
function updateSummaryCards(data) {
  document.getElementById('stat-total').textContent = data.length;

  const avgScore = Math.round(data.reduce((s, p) => s + p.score, 0) / data.length);
  document.getElementById('stat-avg').textContent = avgScore;

  const bestScore = Math.max(...data.map(p => p.score));
  document.getElementById('stat-best').textContent = bestScore;

  const avgWpm = Math.round(data.reduce((s, p) => s + p.wpm, 0) / data.length);
  document.getElementById('stat-wpm').textContent = avgWpm;

  const totalSec = data.reduce((s, p) => s + p.durationSec, 0);
  const hours = (totalSec / 3600).toFixed(1);
  document.getElementById('stat-duration').innerHTML = `${hours}<span class="text-xl">h</span>`;
}

// ─── BEST / WORST ─────────────────────────────────────────────
function updateBestWorst(data) {
  const formatDate = iso => {
    const d = new Date(iso);
    const months = ['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };

  const sorted = [...data].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  if (best) {
    document.getElementById('best-score').textContent = best.score;
    document.getElementById('best-date').textContent = formatDate(best.date);
    document.getElementById('best-wpm').textContent = best.wpm;
    document.getElementById('best-filler').textContent = best.fillerCount;
    document.getElementById('best-emotion').textContent = `${EMOTION_EMOJIS[best.dominantEmotion] || '😐'} ${best.dominantEmotion}`;
  }

  if (worst) {
    document.getElementById('worst-score').textContent = worst.score;
    document.getElementById('worst-date').textContent = formatDate(worst.date);
    document.getElementById('worst-wpm').textContent = worst.wpm;
    document.getElementById('worst-filler').textContent = worst.fillerCount;
    document.getElementById('worst-emotion').textContent = `${EMOTION_EMOJIS[worst.dominantEmotion] || '😐'} ${worst.dominantEmotion}`;
  }
}

// ─── CHARTS ───────────────────────────────────────────────────
function destroyCharts() {
  Object.values(charts).forEach(c => c.destroy());
  charts = {};
}

function renderAllCharts(data) {
  destroyCharts();

  const sorted = [...data].sort((a, b) => new Date(a.date) - new Date(b.date));
  const labels = sorted.map(p => {
    const d = new Date(p.date);
    return `${d.getDate()} ${['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'][d.getMonth()]}`;
  });

  // ─── SKOR TRENDİ ─────────────────────────────
  charts.score = new Chart(document.getElementById('scoreTrendChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Skor',
        data: sorted.map(p => p.score),
        borderColor: COLORS.purple,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 280);
          g.addColorStop(0, 'rgba(139, 92, 246, 0.35)');
          g.addColorStop(1, 'rgba(139, 92, 246, 0)');
          return g;
        },
        fill: true,
        tension: 0.4,
        borderWidth: 3,
        pointRadius: 5,
        pointBackgroundColor: COLORS.pink,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, ticks: { color: '#94a3b8', callback: v => `%${v}` }, grid: { color: 'rgba(148,163,184,0.08)' } },
        x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
      },
    },
  });

  // ─── WPM GRAFİĞİ ─────────────────────────────
  const wpmData = sorted.map(p => p.wpm);
  const wpmColors = wpmData.map(w => w >= 120 && w <= 150 ? COLORS.green : w < 100 || w > 170 ? COLORS.red : COLORS.yellow);

  charts.wpm = new Chart(document.getElementById('wpmChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'WPM',
        data: wpmData,
        backgroundColor: wpmColors.map(c => c + '80'),
        borderColor: wpmColors,
        borderWidth: 2,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        annotation: undefined,
      },
      scales: {
        y: {
          min: 0,
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(148,163,184,0.08)' },
        },
        x: { ticks: { color: '#94a3b8', maxRotation: 45 }, grid: { display: false } },
      },
    },
  });

  // ─── DOLGU KELİME ─────────────────────────────
  charts.filler = new Chart(document.getElementById('fillerChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Dolgu Kelime',
        data: sorted.map(p => p.fillerCount),
        borderColor: COLORS.orange,
        backgroundColor: 'rgba(249, 115, 22, 0.15)',
        fill: true,
        tension: 0.3,
        borderWidth: 2.5,
        pointRadius: 4,
        pointBackgroundColor: COLORS.orange,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, ticks: { color: '#94a3b8', stepSize: 1 }, grid: { color: 'rgba(148,163,184,0.08)' } },
        x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
      },
    },
  });

  // ─── DUYGU PASTA GRAFİĞİ ─────────────────────
  const emotionDist = {};
  data.forEach(p => {
    const e = p.dominantEmotion || 'Neutral';
    emotionDist[e] = (emotionDist[e] || 0) + 1;
  });

  const emotionLabels = Object.keys(emotionDist).map(e => `${EMOTION_EMOJIS[e] || '😐'} ${e}`);
  const emotionColors = [COLORS.green, '#64748b', COLORS.yellow, COLORS.blue, COLORS.red, COLORS.purple, COLORS.pink];

  charts.emotion = new Chart(document.getElementById('emotionPieChart'), {
    type: 'doughnut',
    data: {
      labels: emotionLabels,
      datasets: [{
        data: Object.values(emotionDist),
        backgroundColor: emotionColors.slice(0, emotionLabels.length),
        borderColor: '#0f172a',
        borderWidth: 3,
      }],
    },
    options: {
      responsive: true,
      cutout: '55%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#cbd5e1', font: { size: 12 }, padding: 14, usePointStyle: true },
        },
      },
    },
  });

  // ─── SÜRE GRAFİĞİ ────────────────────────────
  charts.duration = new Chart(document.getElementById('durationChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Süre (dk)',
        data: sorted.map(p => Math.round(p.durationSec / 60 * 10) / 10),
        backgroundColor: 'rgba(6, 182, 212, 0.5)',
        borderColor: COLORS.cyan,
        borderWidth: 2,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, ticks: { color: '#94a3b8', callback: v => `${v}dk` }, grid: { color: 'rgba(148,163,184,0.08)' } },
        x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
      },
    },
  });
}

// ─── BAŞLAT ───────────────────────────────────────────────────
initStatistics();
