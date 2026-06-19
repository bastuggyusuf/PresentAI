# PresentAI Chrome Extension

Google Meet, Zoom ve Microsoft Teams çağrılarında sunum analizi.

## 🚧 Mevcut Durum (v0.1.0)

- ✅ Manifest V3 iskeleti
- ✅ Meet/Zoom/Teams content script injection
- ✅ Sürüklenebilir overlay (Confidence + Duygu + Göz Teması göstergesi)
- ✅ Backend URL + API Key ayarları (popup)
- ✅ Mock veriyle UI test edilebilir
- ⚠️ **Face/Emotion detection henüz inject edilmedi** — şu an random demo verisi
- ⚠️ Backend bağlantısı opsiyonel — şu an sadece UI

**Tamamlanması gereken (v0.2 — ~2-3 günlük iş):**
- MediaPipe Face Detection (face landmarks, head pose)
- TensorFlow.js + TFLite model (emotion classification, mevcut v5 model'i web'e port et)
- Backend WebSocket bağlantısı (mevcut Android `AudioWebSocketClient` ile aynı endpoint)
- Oturum sonu raporu (web dashboard'a redirect)

## 📥 Geliştirme Modunda Yükleme

1. Chrome'da **chrome://extensions** aç
2. Sağ üstte **"Geliştirici modu"** aç
3. **"Paketlenmemiş öğe yükle"** butonuna bas
4. Bu `chrome-extension/` klasörünü seç
5. Toolbar'da 🎤 ikonu görünecek

## 🧪 Test

1. https://meet.google.com aç (yeni veya mevcut bir meeting)
2. Kamerayı aktif et
3. Sağ üstte beliren **PresentAI** paneline bak
4. **"Başlat"** butonuna bas
5. Her 3 saniyede bir random Confidence/Duygu/Göz Teması güncellenir (demo)

## 🎨 Icons

`icons/` klasörü boş — placeholder gerekli. Üretim için:
- `icon16.png` (16×16)
- `icon48.png` (48×48)
- `icon128.png` (128×128)

Şimdilik icon eksikliği yüklemeyi engellemez ama toolbar'da default ikon görünür.

## 🔌 Backend Entegrasyonu

`background.js` ve `content.js` içinde `BACKEND_BASE` değişkeni var:
```js
const BACKEND_BASE = 'http://localhost:8000';  // veya https://api.presentai.app
```

Popup üzerinden kullanıcı kendi backend URL'sini girebilir → `chrome.storage.local`'a kaydedilir.

## ⚠️ Web Store Yayınlama Gereksinimleri

- $5 (tek seferlik) developer ücreti
- Privacy policy URL (legal/PRIVACY_POLICY_en.md → web sitesine koy)
- Detaylı açıklama + 1280×800 promosyon görseli + screenshot'lar
- İlk inceleme: ~2-3 gün
