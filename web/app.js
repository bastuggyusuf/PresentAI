// PresentAI Dashboard — Backend API integration

const ACCENT = {
  blue: '#3b82f6',
  purple: '#8b5cf6',
  pink: '#ec4899',
  green: '#10b981',
  yellow: '#f59e0b',
  red: '#ef4444',
};

async function initDashboard() {
  const listEl = document.getElementById('presentationList');
  if(listEl) listEl.innerHTML = '<div class="text-center p-6 text-slate-400">Yükleniyor...</div>';

  try {
    const base = window.BACKEND_URL;
    const res = await fetch(`${base}/api/presentations`, { headers: window.getHeaders() });
    if (!res.ok) throw new Error('API Error');
    let presentations = await res.json();
    
    if (presentations.length === 0) {
      if(listEl) listEl.innerHTML = '<div class="text-center p-6 text-slate-400">Henüz sunum bulunmuyor.</div>';
      return;
    }

    if(listEl) renderList(presentations);
    if(document.getElementById('trendChart')) renderCharts(presentations);
    updateStats(presentations);
  } catch (err) {
    if(listEl) listEl.innerHTML = '<div class="text-center p-6 text-red-400">Veriler alınamadı. Lütfen backend bağlantısını kontrol edin.</div>';
    console.error(err);
  }
}

function renderList(presentations) {
  const ratingFor = score => {
    if (score >= 90) return { stars: '⭐⭐⭐⭐⭐', color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30' };
    if (score >= 75) return { stars: '⭐⭐⭐⭐', color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/30' };
    if (score >= 60) return { stars: '⭐⭐⭐', color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30' };
    if (score >= 40) return { stars: '⭐⭐', color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' };
    return { stars: '⭐', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' };
  };

  const formatDuration = s => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}d ${sec}s` : `${sec}s`;
  };

  const formatDate = iso => {
    const d = new Date(iso);
    const months = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };

  const formatTime = iso => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const list = document.getElementById('presentationList');
  
  // Make sure toggleAccordion is attached to the window
  window.toggleAccordion = function(id) {
    const el = document.getElementById('acc-' + id);
    if (el) {
      el.classList.toggle('hidden');
    }
  };

  list.innerHTML = presentations.map((p, idx) => {
    const r = ratingFor(p.score);
    const hasDetails = p.transcript || p.summary || p.suggestions;
    const btnText = hasDetails ? '👁️ Detaylar' : '';
    
    const summaryHtml = p.summary ? `<div class="mb-4"><h4 class="font-bold text-sm text-slate-300 mb-1">🤖 Yapay Zeka Özeti</h4><p class="text-sm text-slate-400 leading-relaxed">${escapeHtml(p.summary)}</p></div>` : '';
    const suggestHtml = p.suggestions ? `<div class="mb-4"><h4 class="font-bold text-sm text-slate-300 mb-1">💡 Öneriler</h4><p class="text-sm text-slate-400 leading-relaxed">${escapeHtml(p.suggestions)}</p></div>` : '';
    const transcriptHtml = p.transcript ? `<div><h4 class="font-bold text-sm text-slate-300 mb-1">🎤 Tam Konuşma Metni</h4><p class="text-xs text-slate-500 italic max-h-32 overflow-y-auto p-2 bg-slate-900 rounded border border-slate-700">${escapeHtml(p.transcript)}</p></div>` : '';

    return `
      <div class="mb-3">
        <div class="flex items-center gap-4 p-4 border ${r.border} ${r.bg} rounded-xl hover:bg-slate-800/40 transition cursor-pointer" onclick="toggleAccordion(${p.id || idx})">
          <div class="w-14 h-14 rounded-xl ${r.bg} border ${r.border} flex items-center justify-center font-black text-xl ${r.color}">
            ${p.score}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2 mb-1">
              <div class="font-bold">${r.stars}</div>
              <div class="text-xs text-slate-500">${formatDate(p.date)}</div>
            </div>
            <div class="text-xs text-slate-400 flex flex-wrap gap-3">
              <span>🕐 ${formatTime(p.startTime)} → ${formatTime(p.endTime)}</span>
              <span>⏱️ ${formatDuration(p.durationSec)}</span>
              <span>🗣️ ${p.wpm} WPM</span>
              <span>📝 ${p.fillerCount} dolgu</span>
              <span>${p.dominantEmotion === 'Happy' ? '😊' : p.dominantEmotion === 'Sad' ? '😢' : '😐'} ${p.dominantEmotion}</span>
              <span class="hidden sm:inline">🎯 ${p.tone}</span>
            </div>
          </div>
          <div class="text-slate-400 font-semibold text-xs hover:text-white transition">${btnText}</div>
        </div>
        
        <div id="acc-${p.id || idx}" class="hidden p-5 mt-2 bg-slate-800/30 border border-slate-700/50 rounded-xl transition-all">
          ${!hasDetails ? '<p class="text-slate-500 text-sm">Bu sunum için detaylı metin verisi bulunamadı.</p>' : ''}
          ${summaryHtml}
          ${suggestHtml}
          ${transcriptHtml}
        </div>
      </div>
    `;
  }).join('');
}

function updateStats(presentations) {
  // Update total presentations
  const totalPres = document.querySelector('div.grid-cols-2.md\\:grid-cols-4 > div:nth-child(1) .text-4xl');
  if(totalPres) totalPres.innerHTML = presentations.length;

  // Update average score
  const avgScore = presentations.reduce((sum, p) => sum + p.score, 0) / presentations.length;
  const avgPres = document.querySelector('div.grid-cols-2.md\\:grid-cols-4 > div:nth-child(2) .text-4xl');
  if(avgPres) avgPres.innerHTML = Math.round(avgScore);

  // Update best score
  const bestScore = Math.max(...presentations.map(p => p.score));
  const bestPres = document.querySelector('div.grid-cols-2.md\\:grid-cols-4 > div:nth-child(3) .text-4xl');
  if(bestPres) bestPres.innerHTML = bestScore;

  // Update total duration
  const totalSec = presentations.reduce((sum, p) => sum + p.durationSec, 0);
  const hours = (totalSec / 3600).toFixed(1);
  const durPres = document.querySelector('div.grid-cols-2.md\\:grid-cols-4 > div:nth-child(4) .text-4xl');
  if(durPres) durPres.innerHTML = `${hours}<span class="text-xl">h</span>`;
  
  // Update selected presentation (first item)
  if (presentations.length > 0) {
     const lastP = presentations[0];
     const lastScoreEl = document.querySelector('.lg\\:col-span-2 \\+ div > div:first-child .text-5xl');
     if(lastScoreEl) lastScoreEl.innerHTML = lastP.score;
  }
}

function renderCharts(presentations) {
  // Sort presentations ascending for trend chart
  const sorted = [...presentations].sort((a,b) => new Date(a.date) - new Date(b.date));
  
  const trendLabels = sorted.map(p => {
     const d = new Date(p.date);
     return `${d.getDate()} ${['Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'][d.getMonth()]}`;
  });
  const trendScores = sorted.map(p => p.score);

  const emotionDist = { Happy: 0, Neutral: 0, Surprise: 0, Sad: 0, Angry: 0, Fear: 0, Disgust: 0 };
  presentations.forEach(p => {
    if (emotionDist[p.dominantEmotion] !== undefined) {
      emotionDist[p.dominantEmotion]++;
    } else {
      emotionDist['Neutral']++;
    }
  });

  // ─── TREND CHART ─────────────────────────────────────────
  new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: {
      labels: trendLabels,
      datasets: [{
        label: 'Skor',
        data: trendScores,
        borderColor: ACCENT.purple,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 250);
          g.addColorStop(0, 'rgba(139, 92, 246, 0.4)');
          g.addColorStop(1, 'rgba(139, 92, 246, 0)');
          return g;
        },
        fill: true,
        tension: 0.4,
        borderWidth: 3,
        pointRadius: 5,
        pointBackgroundColor: ACCENT.pink,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => `Skor: %${ctx.parsed.y}` },
        },
      },
      scales: {
        y: {
          beginAtZero: false,
          min: 50,
          max: 100,
          ticks: { color: '#94a3b8', callback: v => `%${v}` },
          grid: { color: 'rgba(148, 163, 184, 0.08)' },
        },
        x: {
          ticks: { color: '#94a3b8' },
          grid: { display: false },
        },
      },
    },
  });

  // ─── RADAR CHART ─────────────────────────────────────────
  new Chart(document.getElementById('radarChart'), {
    type: 'radar',
    data: {
      labels: ['Göz Teması', 'Konuşma Netliği', 'Duygu Dengesi', 'Akıcılık', 'Sakinlik'],
      datasets: [{
        label: 'Son Sunum',
        data: [92, 88, 81, 90, 78], // Could be dynamic if we had these fields
        borderColor: ACCENT.purple,
        backgroundColor: 'rgba(139, 92, 246, 0.2)',
        borderWidth: 2,
        pointBackgroundColor: ACCENT.pink,
        pointBorderColor: '#fff',
        pointRadius: 4,
      }, {
        label: 'Ortalama',
        data: [75, 70, 68, 72, 65],
        borderColor: ACCENT.blue,
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        borderWidth: 1.5,
        borderDash: [4, 4],
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          labels: { color: '#cbd5e1', usePointStyle: true, padding: 16 },
        },
      },
      scales: {
        r: {
          beginAtZero: true,
          max: 100,
          ticks: { color: '#64748b', backdropColor: 'transparent', stepSize: 25 },
          grid: { color: 'rgba(148, 163, 184, 0.12)' },
          angleLines: { color: 'rgba(148, 163, 184, 0.12)' },
          pointLabels: { color: '#cbd5e1', font: { size: 12, weight: '600' } },
        },
      },
    },
  });

  // ─── EMOTION DONUT ───────────────────────────────────────
  new Chart(document.getElementById('emotionChart'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(emotionDist),
      datasets: [{
        data: Object.values(emotionDist),
        backgroundColor: [ACCENT.green, '#64748b', ACCENT.yellow, ACCENT.blue, ACCENT.red, ACCENT.purple, ACCENT.pink],
        borderColor: '#0f172a',
        borderWidth: 3,
      }],
    },
    options: {
      responsive: true,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#cbd5e1', font: { size: 11 }, padding: 12, usePointStyle: true },
        },
      },
    },
  });
}

initDashboard();

// Ödeme başarısını kontrol et ve bildirimi göster
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('payment') === 'success') {
  const alertDiv = document.createElement('div');
  alertDiv.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 z-50 bg-gradient-to-r from-green-500 to-emerald-600 border border-green-400 text-white px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 animate-bounce';
  alertDiv.innerHTML = `
    <span class="text-xl">🎉</span>
    <div>
      <div class="font-bold">Ödeme Başarılı!</div>
      <div class="text-xs text-green-100">PresentAI Pro Sürümünüz başarıyla aktif edildi. Keyifli sunumlar!</div>
    </div>
    <button onclick="this.parentElement.remove()" class="text-white hover:text-green-200 font-bold ml-4">✕</button>
  `;
  document.body.appendChild(alertDiv);
  setTimeout(() => {
    alertDiv.style.transition = 'opacity 0.5s ease';
    alertDiv.style.opacity = '0';
    setTimeout(() => alertDiv.remove(), 500);
  }, 5000);
}
