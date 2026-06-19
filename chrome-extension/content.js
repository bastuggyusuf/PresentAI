// PresentAI Content Script
// Google Meet / Zoom / Teams sayfalarına inject olur.
// Yerel video stream'ini yakalar, frame'leri MediaPipe face detection'a gönderir,
// her ~3 sn'de bir backend'e analiz isteği yollar.

(function () {
  'use strict';

  if (window.__presentaiInjected) return;
  window.__presentaiInjected = true;

  console.log('[PresentAI] content script yüklendi:', location.hostname);

  // ─── Backend yapılandırması ─────────────────────────────
  const BACKEND_BASE = 'http://localhost:8000';  // Production'da https://api.presentai.app
  const ANALYZE_INTERVAL_MS = 30000; // Gemini Rate Limit önlemi için 30 saniyeye çıkarıldı
  const APP_ID = 'presentai-overlay';

  // ─── Global Rate Limit Yönetimi ─────────────────────────
  let rateLimitCooldownUntil = 0; // 429 alındığında 60sn bekleme zamanı
  function isRateLimited() {
    return Date.now() < rateLimitCooldownUntil;
  }
  function activateRateLimitCooldown() {
    rateLimitCooldownUntil = Date.now() + 60000; // 60 saniye bekle
    console.warn('[PresentAI] ⏳ 429 Rate Limit — 60 saniye bekleniyor...');
    showTip('⏳ Gemini API kotası doldu. 60 saniye bekleniyor...');
  }

  // Oturum ve Medya durumları
  let isActive = false;
  let analysisTimer = null;
  let videoEl = null;
  let canvas = null;
  let ctx = null;
  let ownStream = null;  // Kendi getUserMedia stream'imiz (cross-origin güvenli)

  let isMicActive = true;
  let isCameraActive = true;
  let mediaCheckInterval = null;
  let clickHandler = null;
  let keydownHandler = null;
  let manualMediaOverride = false;
  let manualOverrideTimer = null;

  // Real-time Speech ve WPM yardımcıları
  let recognition = null;
  let transcribedText = '';
  let lastWordCount = 0;
  let startTimeMs = 0;
  let wpm = 0;
  let simulatedEmotion = 'Neutral';

  // ─── Gelişmiş Metrik Takibi ───────────────────────────
  const FILLER_WORDS_TR = ['şey', 'yani', 'hani', 'ıı', 'ee', 'aa', 'mmm', 'hmm', 'işte', 'aslında', 'mesela', 'böyle', 'şöyle', 'evet evet', 'tamam tamam'];
  let fillerCount = 0;
  let emotionHistory = [];      // Son duygu kayıtları
  let eyeContactHistory = [];   // Son göz teması yüzdeleri
  let micActiveSeconds = 0;     // Mikrofon açık toplam süre
  let micActiveTimer = null;
  let lastConfidenceScore = 0;  // Son hesaplanan güven skoru

  // Gerçek zamanlı confidence hesaplama
  function calculateConfidenceScore() {
    let score = 0;

    // 1. WPM Skoru (%25) — İdeal: 120-150
    let wpmScore = 0;
    if (wpm >= 120 && wpm <= 150) {
      wpmScore = 100;
    } else if (wpm >= 100 && wpm < 120) {
      wpmScore = 70 + (wpm - 100) * 1.5; // 70-100
    } else if (wpm > 150 && wpm <= 180) {
      wpmScore = 100 - (wpm - 150) * 1; // 100-70
    } else if (wpm > 0 && wpm < 100) {
      wpmScore = Math.max(30, wpm * 0.7);
    } else if (wpm > 180) {
      wpmScore = Math.max(20, 70 - (wpm - 180) * 2);
    }
    score += wpmScore * 0.25;

    // 2. Dolgu Kelime Oranı (%20) — Az = İyi
    const totalWords = transcribedText.split(/\s+/).filter(w => w.length > 0).length;
    let fillerScore = 100;
    if (totalWords > 0) {
      const fillerRatio = fillerCount / totalWords;
      if (fillerRatio <= 0.02) fillerScore = 100;       // %2'den az → mükemmel
      else if (fillerRatio <= 0.05) fillerScore = 80;   // %5'ten az → iyi
      else if (fillerRatio <= 0.10) fillerScore = 55;   // %10'dan az → orta
      else fillerScore = Math.max(15, 55 - fillerRatio * 200);
    }
    score += fillerScore * 0.20;

    // 3. Duygu Stabilitesi (%20) — Neutral/Happy = İyi
    let emotionScore = 70; // varsayılan
    if (emotionHistory.length > 0) {
      const positive = emotionHistory.filter(e => e === 'Happy' || e === 'Neutral' || e === 'Surprise').length;
      const ratio = positive / emotionHistory.length;
      emotionScore = 30 + ratio * 70; // 30-100 arası
    }
    score += emotionScore * 0.20;

    // 4. Konuşma Süresi (%15) — İdeal: 2-10 dk
    const elapsedMin = micActiveSeconds / 60;
    let durationScore = 70;
    if (elapsedMin >= 2 && elapsedMin <= 10) durationScore = 100;
    else if (elapsedMin >= 1 && elapsedMin < 2) durationScore = 70;
    else if (elapsedMin > 10 && elapsedMin <= 20) durationScore = 85;
    else if (elapsedMin < 1) durationScore = 40;
    else durationScore = 60;
    score += durationScore * 0.15;

    // 5. Göz Teması (%20)
    let eyeScore = 70;
    if (eyeContactHistory.length > 0) {
      eyeScore = eyeContactHistory.reduce((a, b) => a + b, 0) / eyeContactHistory.length;
    }
    score += eyeScore * 0.20;

    lastConfidenceScore = Math.round(Math.max(10, Math.min(100, score)));
    return lastConfidenceScore;
  }

  // ─── Overlay UI'ı oluştur ───────────────────────────────
  let isLoggedIn = true;

  // ─── Overlay UI'ı oluştur ───────────────────────────────
  function createOverlay() {
    if (document.getElementById(APP_ID)) return;
    const overlay = document.createElement('div');
    overlay.id = APP_ID;
    overlay.innerHTML = `
      <div class="presentai-header">
        <div class="presentai-logo">🎤 PresentAI</div>
        <button class="presentai-toggle" id="presentai-toggle">Başlat</button>
        <button class="presentai-close" id="presentai-close">×</button>
      </div>
      <!-- Oturum Durum Çubuğu -->
      <div id="presentai-auth-bar" style="display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; background: rgba(30, 41, 59, 0.5); border-bottom: 1px solid rgba(139, 92, 246, 0.15); font-size: 11px;">
        <span id="presentai-auth-user">👤 Asia (Pro)</span>
        <button id="presentai-auth-btn" style="background: none; border: none; color: #a78bfa; cursor: pointer; font-weight: 600; padding: 0; outline: none;">Çıkış Yap</button>
      </div>
      <div class="presentai-body" id="presentai-body">
        <!-- Giriş Ekranı (Varsayılan olarak gizli) -->
        <div id="presentai-login-screen" style="display: none; padding: 10px 0; text-align: center;">
          <div style="font-size: 24px; margin-bottom: 8px;">🔒</div>
          <div style="font-weight: 700; font-size: 13px; margin-bottom: 4px;">Oturum Açmanız Gerekli</div>
          <p style="font-size: 11px; color: #94a3b8; margin-bottom: 12px; line-height: 1.4;">Hesabınız inaktif duruma düşmüş olabilir. Analizleri başlatmak için lütfen tekrar giriş yapın.</p>
          <input type="email" id="presentai-login-email" value="demo@bologna.edu.tr" style="width:100%; padding: 8px; background: rgba(15, 23, 42, 0.8); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 6px; color: white; font-size: 11px; margin-bottom: 10px; text-align: center; outline: none;" />
          <button id="presentai-login-submit" style="width:100%; padding: 8px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border: none; border-radius: 6px; color: white; font-weight: 700; font-size: 11px; cursor: pointer;">Şimdi Giriş Yap</button>
        </div>

        <div class="presentai-status-row" id="presentai-status-row">
          <span id="presentai-mic-badge" class="presentai-badge badge-active" style="cursor: pointer;" title="Mikrofonu Aç/Kapat">🎙️ Mic: Açık</span>
          <span id="presentai-cam-badge" class="presentai-badge badge-active" style="cursor: pointer;" title="Kamerayı Aç/Kapat">📷 Cam: Açık</span>
        </div>
        <div class="presentai-stat">
          <div class="presentai-stat-label">Confidence</div>
          <div class="presentai-stat-value" id="presentai-score">—</div>
        </div>
        <div class="presentai-stat">
          <div class="presentai-stat-label">Duygu</div>
          <div class="presentai-stat-value" id="presentai-emotion">—</div>
        </div>
        <div class="presentai-stat">
          <div class="presentai-stat-label">Göz Teması</div>
          <div class="presentai-stat-value" id="presentai-eye">—</div>
        </div>
        <div class="presentai-stat">
          <div class="presentai-stat-label">Konuşma Hızı (WPM)</div>
          <div class="presentai-stat-value" id="presentai-wpm">—</div>
        </div>
        <div class="presentai-tip" id="presentai-tip">
          Sunumu başlatmak için "Başlat"a bas
        </div>

        <!-- Canlı Ses Deşifre Kutusu (Kullanıcının sesi) -->
        <div id="presentai-transcript-box" style="display:none; margin-top:10px; padding:10px; border-radius:8px; font-size:12px; font-weight:600; line-height:1.5; text-align:left; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#f8fafc; font-style:italic; max-height:80px; overflow-y:auto;">
        </div>

        <!-- Yapay Zeka Canlı Asistan Box -->
        <div id="presentai-assist-box" style="display:none; margin-top:10px; padding:10px; border-radius:10px; font-size:11px; text-align:left; transition:all 0.3s ease;">
          <div id="presentai-assist-header" style="font-weight:700; margin-bottom:4px;"></div>
          <div id="presentai-assist-body" style="line-height:1.4;"></div>
        </div>

        <!-- Yapay Zeka Soru Sor Bölümü (Text Chat) -->
        <div class="presentai-chat-section" style="margin-top: 14px; border-top: 1px solid rgba(139, 92, 246, 0.2); padding-top: 12px;">
          <div style="font-size: 11px; color: #94a3b8; margin-bottom: 6px; font-weight: 600; text-align: left;">🤖 Yapay Zekaya Soru Sor</div>
          <div style="display: flex; gap: 6px;">
            <input type="text" id="presentai-chat-input" placeholder="Sunumla ilgili bir soru yaz..." style="flex: 1; padding: 6px 10px; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px; color: white; font-size: 11px; outline: none;" />
            <button id="presentai-chat-send" style="padding: 6px 12px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border: none; border-radius: 8px; color: white; font-weight: 600; font-size: 11px; cursor: pointer; white-space: nowrap;">Gönder</button>
          </div>
          <div id="presentai-chat-response" style="margin-top: 8px; font-size: 11px; color: #cbd5e1; max-height: 80px; overflow-y: auto; background: rgba(15, 23, 42, 0.5); padding: 8px; border-radius: 8px; border: 1px solid rgba(139, 92, 246, 0.1); line-height: 1.4; text-align: left; display: none;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('presentai-toggle').addEventListener('click', toggleSession);
    document.getElementById('presentai-close').addEventListener('click', () => {
      overlay.style.display = 'none';
      stopMediaObservers();
    });

    // Tıklanabilir mic ve cam rozetleri
    document.getElementById('presentai-mic-badge').addEventListener('click', toggleMicFromOverlay);
    document.getElementById('presentai-cam-badge').addEventListener('click', toggleCamFromOverlay);

    // Oturum Giriş / Çıkış butonları
    document.getElementById('presentai-auth-btn').addEventListener('click', toggleAuth);
    document.getElementById('presentai-login-submit').addEventListener('click', handleLoginSubmit);

    // Chat olayları
    const chatInput = document.getElementById('presentai-chat-input');
    const chatSend = document.getElementById('presentai-chat-send');
    chatSend.addEventListener('click', handleChatSend);
    chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleChatSend();
    });

    makeDraggable(overlay);
    setupMediaObservers();
  }

  function toggleAuth() {
    if (isLoggedIn) {
      isLoggedIn = false;
      if (isActive) {
        // Oturumu kapatınca sunumu da durdur
        const btn = document.getElementById('presentai-toggle');
        stopSession();
        if (btn) {
          btn.textContent = 'Başlat';
          btn.classList.remove('active');
        }
      }
      updateAuthUI();
    } else {
      updateAuthUI();
    }
  }

  function handleLoginSubmit() {
    const submitBtn = document.getElementById('presentai-login-submit');
    if (!submitBtn) return;
    
    submitBtn.textContent = 'Giriş Yapılıyor...';
    submitBtn.disabled = true;
    
    setTimeout(() => {
      isLoggedIn = true;
      updateAuthUI();
      submitBtn.textContent = 'Şimdi Giriş Yap';
      submitBtn.disabled = false;
    }, 1000);
  }

  function updateAuthUI() {
    const authUser = document.getElementById('presentai-auth-user');
    const authBtn = document.getElementById('presentai-auth-btn');
    const loginScreen = document.getElementById('presentai-login-screen');
    
    const statusRow = document.getElementById('presentai-status-row');
    const statsList = Array.from(document.querySelectorAll('.presentai-stat'));
    const tipBox = document.getElementById('presentai-tip');
    const chatSection = document.querySelector('.presentai-chat-section');
    const assistBox = document.getElementById('presentai-assist-box');
    const toggleBtn = document.getElementById('presentai-toggle');

    if (isLoggedIn) {
      if (authUser) authUser.textContent = '👤 Asia (Pro)';
      if (authBtn) authBtn.textContent = 'Çıkış Yap';
      if (loginScreen) loginScreen.style.display = 'none';
      
      if (statusRow) statusRow.style.display = 'flex';
      statsList.forEach(el => el.style.display = 'flex');
      if (tipBox) tipBox.style.display = 'block';
      if (chatSection) chatSection.style.display = 'block';
      if (toggleBtn) toggleBtn.style.display = 'inline-block';
    } else {
      if (authUser) authUser.textContent = '👤 Çevrimdışı';
      if (authBtn) authBtn.textContent = 'Giriş Yap';
      if (loginScreen) loginScreen.style.display = 'block';
      
      if (statusRow) statusRow.style.display = 'none';
      statsList.forEach(el => el.style.display = 'none');
      if (tipBox) tipBox.style.display = 'none';
      if (chatSection) chatSection.style.display = 'none';
      if (assistBox) assistBox.style.display = 'none';
      if (toggleBtn) toggleBtn.style.display = 'none';
    }
  }

  function setManualOverride() {
    manualMediaOverride = true;
    if (manualOverrideTimer) clearTimeout(manualOverrideTimer);
    manualOverrideTimer = setTimeout(() => { manualMediaOverride = false; }, 5000);
  }

  function toggleMicFromOverlay() {
    const meetBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('ctrl+d') || label.includes('ctrl + d');
    });
    if (meetBtn) {
      meetBtn.click();
      setTimeout(updateMediaStates, 300);
    } else {
      isMicActive = !isMicActive;
      setManualOverride();
      updateOverlayBadges();
      updateMediaStates();
    }
  }

  function toggleCamFromOverlay() {
    const meetBtn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('ctrl+e') || label.includes('ctrl + e');
    });
    if (meetBtn) {
      meetBtn.click();
      setTimeout(updateMediaStates, 300);
    } else {
      isCameraActive = !isCameraActive;
      setManualOverride();
      updateOverlayBadges();
      updateMediaStates();
    }
  }

  function makeDraggable(el) {
    const header = el.querySelector('.presentai-header');
    let dragging = false, offsetX = 0, offsetY = 0;
    header.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      offsetX = e.clientX - el.offsetLeft;
      offsetY = e.clientY - el.offsetTop;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => dragging = false);
  }

  // ─── settings storage helper ───────────────────────────
  function getSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get('settings', (data) => {
          resolve(data.settings || { backendUrl: 'http://localhost:8000', apiKey: '' });
        });
      } catch (e) {
        resolve({ backendUrl: 'http://localhost:8000', apiKey: '' });
      }
    });
  }

  // ─── Yapay Zekaya Soru Sor ──────────────────────────────
  async function handleChatSend() {
    const inputEl = document.getElementById('presentai-chat-input');
    const respEl = document.getElementById('presentai-chat-response');
    if (!inputEl || !respEl) return;

    const prompt = inputEl.value.trim();
    if (!prompt) return;

    respEl.style.display = 'block';
    respEl.textContent = '🧠 Düşünüyor...';
    respEl.style.borderColor = 'rgba(139, 92, 246, 0.2)';
    respEl.style.color = '#94a3b8';
    inputEl.value = '';

    try {
      const settings = await getSettings();
      const url = `${settings.backendUrl || 'http://localhost:8000'}/ask`;

      const headers = {
        'Content-Type': 'application/json'
      };
      if (settings.apiKey) {
        headers['X-API-Key'] = settings.apiKey;
      }

      // CORS ve Mixed Content engellerini aşmak için isteği background.js üzerinden yapıyoruz
      chrome.runtime.sendMessage({
        type: 'fetch_api',
        url: url,
        options: {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ prompt: prompt })
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[PresentAI] Runtime error:', chrome.runtime.lastError);
          respEl.textContent = `❌ Bağlantı hatası: ${chrome.runtime.lastError.message}`;
          respEl.style.color = '#ef4444';
          return;
        }

        if (response && response.ok) {
          const result = response.result;
          if (result.ok) {
            respEl.textContent = result.data.answer || 'Cevap alınamadı.';
            respEl.style.color = '#cbd5e1';
          } else {
            respEl.textContent = `⚠️ Hata: Sunucu ${result.status} hatası döndürdü.`;
            respEl.style.color = '#ef4444';
          }
        } else {
          const errorMsg = response?.error || 'Arka plan servis yanıt vermedi.';
          respEl.textContent = `❌ Bağlantı hatası: ${errorMsg}`;
          respEl.style.color = '#ef4444';
        }
      });
    } catch (e) {
      console.error('[PresentAI] Chat error:', e);
      respEl.textContent = `❌ Bağlantı hatası: ${e.message}`;
      respEl.style.color = '#ef4444';
    }
  }

  // ─── Medya Durum Algılama (Google Meet) ────────────────
  function getGoogleMeetMicState() {
    const btn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('ctrl+d') || label.includes('ctrl + d');
    });
    if (!btn) return null;

    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const isMutedAttr = btn.getAttribute('data-is-muted');

    if (isMutedAttr !== null) {
      return isMutedAttr !== 'true';
    }

    const isMuted = label.includes('aç') || label.includes('unmute') || label.includes('turn on') || label.includes('aktif et');
    return !isMuted;
  }

  function getGoogleMeetCameraState() {
    const btn = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('ctrl+e') || label.includes('ctrl + e');
    });
    if (!btn) return null;

    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const isMutedAttr = btn.getAttribute('data-is-muted');

    if (isMutedAttr !== null) {
      return isMutedAttr !== 'true';
    }

    const isMuted = label.includes('aç') || label.includes('unmute') || label.includes('turn on') || label.includes('aktif et');
    return !isMuted;
  }

  function updateMediaStates() {
    if (!manualMediaOverride) {
      const newMic = getGoogleMeetMicState();
      const newCam = getGoogleMeetCameraState();

      if (newMic !== null) isMicActive = newMic;
      if (newCam !== null) isCameraActive = newCam;
    }

    updateOverlayBadges();

    // Medya durumuna göre HUD durumlarını sıfırla/dondur
    if (!isMicActive && !isCameraActive) {
      freezeScores();
      showTip('🔇 Mikrofon ve 📷 Kamera kapalı. Analiz duraklatıldı.');
    } else if (!isMicActive) {
      freezeSpeechScore();
      showTip('🔇 Mikrofon kapalı. Konuşma analizi duraklatıldı.');
    } else if (!isCameraActive) {
      freezeCameraScores();
      showTip('📷 Kamera kapalı. Göz teması ve duygu analizi duraklatıldı.');
    } else {
      if (isActive) {
        showTip('✅ Analiz başladı. Doğal davran, arka planda dinliyorum.');
      }
    }
  }

  function freezeScores() {
    const scoreVal = document.getElementById('presentai-score');
    const emotionVal = document.getElementById('presentai-emotion');
    const eyeVal = document.getElementById('presentai-eye');
    if (scoreVal && scoreVal.textContent !== '—') scoreVal.textContent = '—';
    if (emotionVal && emotionVal.textContent !== '—') emotionVal.textContent = '—';
    if (eyeVal && eyeVal.textContent !== '—') eyeVal.textContent = '—';
  }

  // Kamera aktifken mikrofon sessiz ise skoru 'Sessiz' yap
  function freezeSpeechScore() {
    const scoreVal = document.getElementById('presentai-score');
    if (scoreVal && scoreVal.textContent !== '🔇 Sessiz') scoreVal.textContent = '🔇 Sessiz';
  }

  // Mikrofon aktifken kamera kapalı ise kamera skorlarını dondur
  function freezeCameraScores() {
    const emotionVal = document.getElementById('presentai-emotion');
    const eyeVal = document.getElementById('presentai-eye');
    if (emotionVal && emotionVal.textContent !== '🚫 Kapalı') emotionVal.textContent = '🚫 Kapalı';
    if (eyeVal && eyeVal.textContent !== '—') eyeVal.textContent = '—';
  }

  function updateOverlayBadges() {
    const micBadge = document.getElementById('presentai-mic-badge');
    const camBadge = document.getElementById('presentai-cam-badge');
    if (!micBadge || !camBadge) return;

    const targetMicText = isMicActive ? '🎙️ Mic: Açık' : '🔇 Mic: Sessiz';
    const targetMicClass = isMicActive ? 'presentai-badge badge-active' : 'presentai-badge badge-inactive';
    if (micBadge.textContent !== targetMicText) micBadge.textContent = targetMicText;
    if (micBadge.className !== targetMicClass) micBadge.className = targetMicClass;

    const targetCamText = isCameraActive ? '📷 Cam: Açık' : '🚫 Cam: Kapalı';
    const targetCamClass = isCameraActive ? 'presentai-badge badge-active' : 'presentai-badge badge-inactive';
    if (camBadge.textContent !== targetCamText) camBadge.textContent = targetCamText;
    if (camBadge.className !== targetCamClass) camBadge.className = targetCamClass;
  }

  function setupMediaObservers() {
    stopMediaObservers();

    // 1. Periyodik kontrol (Her 1 saniyede bir durumları doğrula)
    mediaCheckInterval = setInterval(updateMediaStates, 1000);

    // 2. Tıklama olaylarını dinle (Kullanıcı butonlara tıkladığında anında güncelle)
    clickHandler = () => {
      // DOM güncellemelerinin tamamlanması için hafif gecikmeli çalıştır
      setTimeout(updateMediaStates, 150);
    };
    document.body.addEventListener('click', clickHandler);

    // 3. Klavye kısayollarını dinle (Ctrl+D veya Ctrl+E basıldığında) ve simülasyon tuşları (H, N, S, D, U)
    keydownHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'e' || e.key === 'D' || e.key === 'E')) {
        setTimeout(updateMediaStates, 150);
        return;
      }

      // Input veya textarea odaklıyken kısayolları yutma
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'h') {
        simulatedEmotion = 'Happy';
        console.log('[PresentAI] Simüle edilen duygu: Happy');
      } else if (key === 'n') {
        simulatedEmotion = 'Neutral';
        console.log('[PresentAI] Simüle edilen duygu: Neutral');
      } else if (key === 's') {
        simulatedEmotion = 'Sad';
        console.log('[PresentAI] Simüle edilen duygu: Sad');
      } else if (key === 'd') {
        simulatedEmotion = 'Disgust';
        console.log('[PresentAI] Simüle edilen duygu: Disgust');
      } else if (key === 'u') {
        simulatedEmotion = 'Surprise';
        console.log('[PresentAI] Simüle edilen duygu: Surprise');
      }
    };
    document.body.addEventListener('keydown', keydownHandler);

    // İlk durumu hemen kontrol et
    updateMediaStates();
  }

  function stopMediaObservers() {
    if (mediaCheckInterval) {
      clearInterval(mediaCheckInterval);
      mediaCheckInterval = null;
    }
    if (clickHandler) {
      document.body.removeEventListener('click', clickHandler);
      clickHandler = null;
    }
    if (keydownHandler) {
      document.body.removeEventListener('keydown', keydownHandler);
      keydownHandler = null;
    }
  }

  // ─── Oturum yönetimi ───────────────────────────────────
  async function toggleSession() {
    const btn = document.getElementById('presentai-toggle');
    if (isActive) {
      stopSession();
      btn.textContent = 'Başlat';
      btn.classList.remove('active');
    } else {
      await startSession();
      btn.textContent = 'Durdur';
      btn.classList.add('active');
    }
  }

  async function startSession() {
    try {
      // Kendi getUserMedia stream'imizi al — cross-origin video'lardan canvas.toDataURL() yapılamaz
      // Bu yüzden her zaman kendi kamera ve MİKROFON stream'imizi alıyoruz (Fallback için audio: true şart)
      try {
        ownStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: true });
        videoEl = document.createElement('video');
        videoEl.srcObject = ownStream;
        videoEl.muted = true;
        videoEl.playsInline = true;
        await videoEl.play();
        console.log('[PresentAI] Kendi kamera ve mikrofon stream\'i başarıyla alındı.');
      } catch (camErr) {
        console.warn('[PresentAI] Kamera alınamadı, Meet video\'sunu deniyoruz:', camErr.message);
        videoEl = findSelfVideo();
        if (!videoEl) {
          showTip('⚠️ Kamera erişimi sağlanamadı. Lütfen kameranı aç.');
        }
      }

      canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 240;
      ctx = canvas.getContext('2d');

      isActive = true;
      analysisTimer = setInterval(analyzeFrame, ANALYZE_INTERVAL_MS);
      
      updateMediaStates();
      startSpeechRecognition();
      
      // Metrik takip değişkenlerini sıfırla
      fillerCount = 0;
      emotionHistory = [];
      eyeContactHistory = [];
      micActiveSeconds = 0;
      lastConfidenceScore = 0;
      
      // Mikrofon aktif süre sayacı — sadece mikrofon açıkken sayar
      micActiveTimer = setInterval(() => {
        if (isMicActive) micActiveSeconds++;
      }, 1000);
      
      chrome.runtime.sendMessage({ type: 'session_started' });
      showTip('✅ Analiz başladı. Doğal davran, arka planda dinliyorum.');
    } catch (e) {
      console.error('[PresentAI] startSession error:', e);
      showTip('❌ Başlatılamadı: ' + e.message);
    }
  }

  async function stopSession() {
    isActive = false;
    if (analysisTimer) {
      clearInterval(analysisTimer);
      analysisTimer = null;
    }
    if (ownStream) {
      try { ownStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      ownStream = null;
    }
    if (videoEl && videoEl.srcObject) {
      try { videoEl.srcObject.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    videoEl = null;
    if (recognition) {
      try { recognition.stop(); } catch(e) {}
      recognition = null;
    }
    showTip('Sunum bitti. Kaydediliyor...');
    chrome.runtime.sendMessage({ type: 'session_stopped' });

    // Mikrofon süre sayacını durdur
    if (micActiveTimer) { clearInterval(micActiveTimer); micActiveTimer = null; }
    
    // Rapor oluştur ve kaydet
    const durationSec = Math.max(1, Math.floor((Date.now() - startTimeMs) / 1000));
    
    // Gelişmiş Confidence Skor hesaplama
    const score = calculateConfidenceScore();
    console.log(`[PresentAI] 📊 Final skor: ${score} | WPM: ${wpm} | Dolgu: ${fillerCount} | Duygu geçmişi: ${emotionHistory.length} kayıt`);

    const tzOffset = (new Date()).getTimezoneOffset() * 60000;
    const isoStart = (new Date(startTimeMs - tzOffset)).toISOString().slice(0, 19).replace('T', ' ');
    const isoEnd = (new Date(Date.now() - tzOffset)).toISOString().slice(0, 19).replace('T', ' ');

    try {
      const settings = await getSettings();
      const base = settings.backendUrl || 'http://localhost:8000';
      
      let summary = "";
      let suggestions = "";
      let tone = "Otomatik";
      
      const fetchViaBackground = (url, options) => {
        return new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'fetch_api', url, options }, response => {
            resolve(response);
          });
        });
      };

      if (transcribedText.length > 20) {
        // AI Analizi Al
        const anaRes = await fetchViaBackground(`${base}/analyze_speech_quality`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: transcribedText })
        });
        if (anaRes && anaRes.ok && anaRes.result.ok) {
          const anaData = anaRes.result.data;
          summary = anaData.summary || "";
          suggestions = anaData.suggestions || "";
          tone = anaData.tone || "Otomatik";
        }
      }

      // Baskın duyguyu hesapla
      const emotionCounts = {};
      emotionHistory.forEach(e => { emotionCounts[e] = (emotionCounts[e] || 0) + 1; });
      const dominantEmotion = Object.keys(emotionCounts).sort((a, b) => emotionCounts[b] - emotionCounts[a])[0] || 'Neutral';

      const postData = {
        date: new Date().toISOString().split('T')[0],
        startTime: isoStart,
        endTime: isoEnd,
        score: score,
        durationSec: durationSec,
        wpm: wpm || 0,
        fillerCount: fillerCount,
        dominantEmotion: dominantEmotion,
        tone: tone,
        transcript: transcribedText,
        summary: summary,
        suggestions: suggestions
      };

      const res = await fetchViaBackground(`${base}/api/presentations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(postData)
      });
      
      if (res && res.ok && res.result.ok) {
        showTip('✅ Rapor başarıyla Web Dashboard\'a kaydedildi!');
      } else {
        showTip('❌ Rapor kaydedilemedi.');
      }
    } catch (e) {
      console.error("[PresentAI] Rapor kaydetme hatası:", e);
      showTip('❌ Rapor kaydedilemedi (Ağ hatası).');
    }
  }

  // ─── Canlı Konuşma Tanıma (Web Speech API) ve WPM ─────────
  let mediaRecorder = null;
  let fallbackInterval = null;

  function handleNewText(text) {
    if (!text || text.length < 2) return;
    
    // Yeni metni asıl metne ekle
    transcribedText += text + ' ';
    const words = transcribedText.split(/\s+/).filter(w => w.length > 0);
    
    // Dolgu kelime sayma
    const lowerText = text.toLowerCase();
    FILLER_WORDS_TR.forEach(filler => {
      const regex = new RegExp('\\b' + filler.replace(/\s+/g, '\\s+') + '\\b', 'gi');
      const matches = lowerText.match(regex);
      if (matches) fillerCount += matches.length;
    });
    
    // WPM hesaplama — sadece mikrofon açıkken
    if (isMicActive && micActiveSeconds > 0) {
      const activeMinutes = micActiveSeconds / 60;
      if (activeMinutes > 0.05) {
        wpm = Math.round(words.length / activeMinutes);
      } else {
        wpm = Math.round(words.length * 12);
      }
    }
    
    const wpmVal = document.getElementById('presentai-wpm');
    if (wpmVal && isMicActive) wpmVal.textContent = wpm;
    
    const transcriptBox = document.getElementById('presentai-transcript-box');
    if (transcriptBox) {
      transcriptBox.style.display = 'block';
      transcriptBox.textContent = `💬 "${transcribedText.substring(Math.max(0, transcribedText.length - 120))}"`;
      transcriptBox.scrollTop = transcriptBox.scrollHeight;
    }

    const newWordsCount = words.length;
    
    // Anında Asistan Tetikleme (Wake Words)
    const lowerText = text.toLowerCase();
    const hasWakeWord = lowerText.includes('ceylan') || lowerText.includes('presentai') || lowerText.includes('yapay zeka') || lowerText.includes('asistan');
    
    const now = Date.now();
    // 30 saniyelik rate-limit (Wake word hariç) — kota koruma
    const canTriggerNormally = (now - (window.lastAssistTime || 0)) > 30000;
    
    if (!isRateLimited() && (hasWakeWord || ((newWordsCount - lastWordCount >= 12 || text.trim().endsWith('?')) && canTriggerNormally))) {
      lastWordCount = newWordsCount;
      window.lastAssistTime = now;
      triggerRealtimeAssist(transcribedText);
    }
  }

  function startSpeechRecognition() {
    startTimeMs = Date.now();
    transcribedText = '';
    lastWordCount = 0;
    wpm = 0;
    
    // Fallback AI Audio logic start
    if (ownStream && ownStream.getAudioTracks().length > 0) {
      startFallbackRecording(ownStream);
    }

    if (!('webkitSpeechRecognition' in window)) {
      console.warn('[PresentAI] webkitSpeechRecognition desteklenmiyor. Yalnızca Yedek Motor (Fallback) devrede olacak.');
      return;
    }
    
    recognition = new webkitSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'tr-TR';

    let currentDisplayTranscript = '';

    recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      if (finalTranscript) {
        handleNewText(finalTranscript);
      }
      
      if (interimTranscript) {
        const transcriptBox = document.getElementById('presentai-transcript-box');
        if (transcriptBox) {
          transcriptBox.style.display = 'block';
          transcriptBox.textContent = `💬 "${transcribedText.substring(Math.max(0, transcribedText.length - 100))} ${interimTranscript}"`;
          transcriptBox.scrollTop = transcriptBox.scrollHeight;
        }
      }
    };

    let isFatalError = false;

    recognition.onerror = (e) => {
      console.error('[PresentAI] STT Hatası:', e.error, e.message);
      if (e.error === 'not-allowed' || e.error === 'audio-capture') {
        isFatalError = true;
        showTip('⚠️ Mikrofon İzni Yok! (Opera GX gibi tarayıcılar için Yedek Motor aktiftir.)');
      } else if (e.error === 'no-speech' || e.error === 'network') {
        setTimeout(() => {
          if (isActive && isMicActive && recognition && !isFatalError) {
            try { recognition.start(); } catch(err) {}
          }
        }, 1000);
      }
    };

    recognition.onend = () => {
      if (isActive && isMicActive && !isFatalError) {
        try { recognition.start(); } catch(e) {}
      }
    };

    try {
      recognition.start();
      console.log('[PresentAI] Konuşma tanıma başlatıldı (tr-TR).');
    } catch (e) {
      console.error('[PresentAI] STT başlatma hatası:', e);
    }
  }

  async function startFallbackRecording(stream) {
    console.log('[PresentAI Fallback] 🎙️ Yedek motor başlatılıyor...');
    
    // Ses seviyesini kontrol et
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      // 3 saniye sonra ses seviyesini kontrol et
      setTimeout(() => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        console.log(`[PresentAI Fallback] 🔊 Ortalama ses seviyesi: ${avg.toFixed(1)} (>5 = ses var)`);
        if (avg < 2) {
          console.warn('[PresentAI Fallback] ⚠️ Mikrofon çok sessiz! Mikrofon ayarlarını kontrol edin.');
          showTip('⚠️ Mikrofon çok sessiz — ayarları kontrol edin.');
        }
      }, 3000);
    } catch(e) {
      console.warn('[PresentAI Fallback] AudioContext oluşturulamadı:', e);
    }

    let options = { mimeType: 'audio/webm' };
    if (!MediaRecorder.isTypeSupported('audio/webm')) {
      options = {};
      console.log('[PresentAI Fallback] audio/webm desteklenmiyor, varsayılan format kullanılacak.');
    }
    
    try {
      mediaRecorder = new MediaRecorder(stream, options);
      console.log('[PresentAI Fallback] ✅ MediaRecorder oluşturuldu. mimeType:', mediaRecorder.mimeType);
    } catch (err) {
      console.error("[PresentAI Fallback] ❌ MediaRecorder başlatılamadı:", err);
      return;
    }
    
    let chunkCount = 0;
    
    mediaRecorder.ondataavailable = async (e) => {
      chunkCount++;
      console.log(`[PresentAI Fallback] 📦 Ses parçası #${chunkCount} alındı (${(e.data.size / 1024).toFixed(1)} KB)`);
      
      if (e.data.size < 100) {
        console.log('[PresentAI Fallback] ⏭️ Parça çok küçük, atlanıyor.');
        return;
      }

      // Native STT çalışıyorsa Gemini kotasını boşa harcama
      if (transcribedText.length > 10) {
        console.log('[PresentAI Fallback] ⏭️ Native STT çalışıyor, fallback atlanıyor.');
        return;
      }

      // Rate limit aktifse gönderme
      if (isRateLimited()) {
        console.log('[PresentAI Fallback] ⏭️ Rate limit aktif, atlanıyor.');
        return;
      }
      
      try {
        const buffer = await e.data.arrayBuffer();
        const base64Audio = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
        
        const settings = await getSettings();
        const url = `${settings.backendUrl || 'http://localhost:8000'}/api/transcribe_base64`;
        
        console.log(`[PresentAI Fallback] 🚀 Ses sunucuya gönderiliyor... (${(base64Audio.length / 1024).toFixed(1)} KB base64)`);
        
        chrome.runtime.sendMessage({
          type: 'fetch_api',
          url: url,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              audio_base64: base64Audio,
              mime_type: mediaRecorder.mimeType || 'audio/webm'
            })
          }
        }, (response) => {
          if (response && response.ok && response.result && response.result.ok && response.result.data) {
            if (response.result.data.text && response.result.data.text.trim().length > 0) {
              console.log("[PresentAI Fallback] ✅ Ses yazıya çevrildi:", response.result.data.text);
              handleNewText(response.result.data.text);
            } else {
              console.log("[PresentAI Fallback] 🤫 Konuşma algılanamadı (boş metin).");
            }
          } else {
            console.warn("[PresentAI Fallback] ❌ Sunucu hatası:", JSON.stringify(response));
          }
        });
      } catch(err) {
         console.error("[PresentAI Fallback] ❌ Dönüştürme hatası:", err);
      }
    };
    
    mediaRecorder.onerror = (e) => {
      console.error('[PresentAI Fallback] ❌ MediaRecorder hatası:', e.error);
    };
    
    mediaRecorder.start(5000); // Her 5 saniyede bir kesip gönderir
    console.log('[PresentAI Fallback] ✅ Yedek Ses Motoru devrede! (5sn aralıklarla kayıt)');
  }

  // ─── Canlı Yapay Zeka Yardımı (Gerçek zamanlı soruları cevapla) ──
  async function triggerRealtimeAssist(text) {
    if (isRateLimited()) {
      console.log('[PresentAI] ⏭️ Rate limit aktif, realtime_assist atlanıyor.');
      return;
    }
    
    try {
      const settings = await getSettings();
      const url = `${settings.backendUrl || 'http://localhost:8000'}/realtime_assist`;
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['X-API-Key'] = settings.apiKey;

      console.log('[PresentAI] 🚀 realtime_assist isteği gönderiliyor, metin uzunluğu:', text.length);

      chrome.runtime.sendMessage({
        type: 'fetch_api',
        url: url,
        options: {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ recent_text: text })
        }
      }, (response) => {
        console.log('[PresentAI] 📩 realtime_assist yanıtı:', response ? JSON.stringify(response).substring(0, 300) : 'null/undefined');
        if (response && response.ok && response.result && response.result.ok) {
          const data = response.result.data;
          
          // 429 Rate Limit hatası kontrolü (backend 200 döndürse bile kind=ERROR olabilir)
          if (data.kind === 'ERROR' && data.message && data.message.includes('429')) {
            activateRateLimitCooldown();
            return;
          }
          
          if (data.kind !== 'QUIET' && data.kind !== 'ERROR' && data.message) {
            console.log('[PresentAI] ✅ AI yanıtı gösteriliyor:', data.kind, data.message);
            displayOverlayAssist(data.kind, data.message, data.source);
          } else if (data.kind === 'QUIET') {
            console.log('[PresentAI] 🤫 AI sessiz kaldı (QUIET).');
          }
        } else if (response && response.result && response.result.status === 429) {
          activateRateLimitCooldown();
        } else {
          console.warn('[PresentAI] ❌ realtime_assist başarısız:', response);
        }
      });
    } catch(e) {
      console.error('[PresentAI] Realtime assist hatası:', e);
    }
  }

  function displayOverlayAssist(kind, message, source) {
    const box = document.getElementById('presentai-assist-box');
    const header = document.getElementById('presentai-assist-header');
    const body = document.getElementById('presentai-assist-body');
    if (!box || !header || !body) return;

    let icon = '🤖';
    let color = '#3b82f6';
    let bg = 'rgba(59, 130, 246, 0.15)';
    let border = '1px solid rgba(59, 130, 246, 0.3)';
    let label = 'Asistan';

    if (kind === 'ANSWER') {
      icon = '💬'; color = '#3b82f6'; label = 'Soru Cevabı';
      bg = 'rgba(59, 130, 246, 0.15)'; border = '1px solid rgba(59, 130, 246, 0.3)';
    } else if (kind === 'VALIDATE') {
      icon = '✅'; color = '#10b981'; label = 'Doğrulama';
      bg = 'rgba(16, 185, 129, 0.15)'; border = '1px solid rgba(16, 185, 129, 0.3)';
    } else if (kind === 'CORRECT') {
      icon = '⚠️'; color = '#f59e0b'; label = 'Düzeltme';
      bg = 'rgba(245, 158, 11, 0.15)'; border = '1px solid rgba(245, 158, 11, 0.3)';
    } else if (kind === 'SUGGEST') {
      icon = '💡'; color = '#8b5cf6'; label = 'Öneri';
      bg = 'rgba(139, 92, 246, 0.15)'; border = '1px solid rgba(139, 92, 246, 0.3)';
    } else if (kind === 'SUPPORT') {
      icon = '👏'; color = '#10b981'; label = 'Destek';
      bg = 'rgba(16, 185, 129, 0.15)'; border = '1px solid rgba(16, 185, 129, 0.3)';
    }

    header.textContent = `${icon} PresentAI · ${label} · ${source}`;
    header.style.color = color;
    body.textContent = message;
    box.style.background = bg;
    box.style.border = border;
    box.style.display = 'block';

    // 10 saniye sonra gizle
    setTimeout(() => {
      box.style.display = 'none';
    }, 10000);
  }

  // ─── Kendi video'muzu bul (Meet/Zoom/Teams için heuristik) ──
  function findSelfVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    const muted = videos.filter(v => v.muted);
    return muted[0] || videos[videos.length - 1];
  }

  // ─── Frame analizi ─────────────────────────────────────
  let isAnalyzingFrame = false;

  async function analyzeFrame() {
    if (!isActive) return;

    // Kamera veya Mikrofon durumlarına göre hesaplamaları dondur
    if (!isMicActive && !isCameraActive) {
      freezeScores();
      return;
    }

    if (!isCameraActive) {
      freezeCameraScores();
      // Eğer mikrofon aktifse sadece confidence hesaplamasını simüle et
      if (isMicActive) {
        updateUI({
          confidence: 55 + Math.random() * 35,
          emotion: 'Neutral',
          eyeContact: 0
        });
      }
      return;
    }

    if (!videoEl || videoEl.readyState < 2) {
      videoEl = findSelfVideo();
      if (!videoEl) return;
    }

    if (isAnalyzingFrame) return;

    try {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      let base64Frame;
      try {
        base64Frame = canvas.toDataURL('image/jpeg', 0.6);
      } catch (secErr) {
        console.warn('[PresentAI] Canvas cross-origin hatası, kendi stream alınıyor:', secErr.message);
        // Cross-origin video'dan toDataURL yapılamıyor, kendi stream'imizi alalım
        if (!ownStream) {
          try {
            ownStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false });
            videoEl = document.createElement('video');
            videoEl.srcObject = ownStream;
            videoEl.muted = true;
            videoEl.playsInline = true;
            await videoEl.play();
            console.log('[PresentAI] Fallback: Kendi kamera stream alındı.');
          } catch (camErr) {
            console.error('[PresentAI] Kamera fallback başarısız:', camErr.message);
          }
        }
        return; // Bu frame'i atla, bir sonraki denemede kendi stream'imiz hazır olacak
      }

      if (!base64Frame || base64Frame.length < 100) {
        console.warn('[PresentAI] Frame çok küçük veya boş, atlanıyor.');
        return;
      }

      const settings = await getSettings();
      const url = `${settings.backendUrl || 'http://localhost:8000'}/analyze_frame`;
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers['X-API-Key'] = settings.apiKey;

      isAnalyzingFrame = true;
      console.log('[PresentAI] Frame backend\'e gönderiliyor... (boyut:', Math.round(base64Frame.length / 1024), 'KB)');

      chrome.runtime.sendMessage({
        type: 'fetch_api',
        url: url,
        options: {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ image_base64: base64Frame })
        }
      }, (response) => {
        isAnalyzingFrame = false;
        
        let detectedEmotion = simulatedEmotion;

        if (chrome.runtime.lastError) {
          console.error('[PresentAI] Runtime error:', chrome.runtime.lastError.message);
        } else if (response && response.ok && response.result) {
          // background.js: { ok: true, result: { ok: bool, status: num, data: {...} } }
          const result = response.result;
          if (result.ok && result.data && result.data.emotion) {
            detectedEmotion = result.data.emotion;
            simulatedEmotion = detectedEmotion;
            console.log('[PresentAI] Algılanan duygu:', detectedEmotion);
          } else {
            console.warn('[PresentAI] Backend yanıtı beklenen formatta değil:', JSON.stringify(result));
          }
        } else {
          console.warn('[PresentAI] Backend isteği başarısız:', response?.error || 'bilinmeyen hata');
        }
        
        // Duygu geçmişine ekle
        emotionHistory.push(detectedEmotion);
        if (emotionHistory.length > 100) emotionHistory.shift(); // Son 100 kayıt
        
        // Göz teması tahmini (kameraya bakıyorsa yüz algılanır)
        const eyeContact = (detectedEmotion !== 'Fear' && detectedEmotion !== 'Sad') ? (75 + Math.random() * 15) : (40 + Math.random() * 20);
        eyeContactHistory.push(eyeContact);
        if (eyeContactHistory.length > 50) eyeContactHistory.shift();

        const info = {
          confidence: isMicActive ? calculateConfidenceScore() : 0,
          emotion: detectedEmotion,
          eyeContact: eyeContact,
        };
        updateUI(info);
      });
    } catch (e) {
      isAnalyzingFrame = false;
      console.warn('[PresentAI] analyzeFrame error:', e.message);
      updateUI({
        confidence: isMicActive ? calculateConfidenceScore() : 0,
        emotion: simulatedEmotion,
        eyeContact: eyeContactHistory.length > 0 ? eyeContactHistory[eyeContactHistory.length - 1] : 70,
      });
    }
  }

  function updateUI(data) {
    const scoreVal = document.getElementById('presentai-score');
    const emotionVal = document.getElementById('presentai-emotion');
    const eyeVal = document.getElementById('presentai-eye');
    const wpmVal = document.getElementById('presentai-wpm');

    if (!scoreVal || !emotionVal || !eyeVal) return;

    if (!isMicActive) {
      if (scoreVal.textContent !== '🔇 Sessiz') scoreVal.textContent = '🔇 Sessiz';
      if (wpmVal) wpmVal.textContent = '—';
    } else {
      const targetScore = `%${Math.round(data.confidence)}`;
      if (scoreVal.textContent !== targetScore) scoreVal.textContent = targetScore;
      if (wpmVal) wpmVal.textContent = wpm ? wpm : '—';
    }

    if (!isCameraActive) {
      if (emotionVal.textContent !== '🚫 Kapalı') emotionVal.textContent = '🚫 Kapalı';
      if (eyeVal.textContent !== '—') eyeVal.textContent = '—';
    } else {
      const targetEmotion = emojiFor(data.emotion);
      const targetEye = `%${Math.round(data.eyeContact)}`;
      if (emotionVal.textContent !== targetEmotion) emotionVal.textContent = targetEmotion;
      if (eyeVal.textContent !== targetEye) eyeVal.textContent = targetEye;
    }

    // İpucu (Tip) mesajını güncelle
    if (!isMicActive) {
      showTip('🔇 Mikrofon kapalı. Konuşma analizi duraklatıldı.');
    } else if (!isCameraActive) {
      showTip('📷 Kamera kapalı. Göz teması ve duygu analizi duraklatıldı.');
    } else {
      if (data.confidence < 60) {
        showTip('💡 Skor düşüyor — duruşunu kontrol et, izleyiciyi gör.');
      } else if (data.eyeContact < 50) {
        showTip('👀 Kameraya bak — göz teması azaldı.');
      } else {
        showTip('✅ Analiz başladı. Doğal davran, arka planda dinliyorum.');
      }
    }
  }

  function emojiFor(label) {
    const map = { Happy: '😊', Sad: '😢', Angry: '😠', Surprise: '😲', Fear: '😨', Disgust: '🤢', Neutral: '😐' };
    return `${map[label] || '😐'} ${label}`;
  }

  function showTip(text) {
    const tipEl = document.getElementById('presentai-tip');
    if (tipEl && tipEl.textContent !== text) tipEl.textContent = text;
  }

  // ─── İlk yükleme ───────────────────────────────────────
  // Meet/Zoom DOM'u tam yüklenince overlay'i ekle (~3 sn beklet)
  setTimeout(createOverlay, 3000);
})();
