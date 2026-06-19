// PresentAI — Merkezi Backend Konfigürasyonu
// Bu dosya tüm sayfalarda diğer JS'lerden ÖNCE yüklenir.
(function() {
    'use strict';
    
    function getBackendUrl() {
        try {
            const settings = JSON.parse(localStorage.getItem('presentai_settings') || '{}');
            if (settings.backendUrl) return settings.backendUrl;
            
            // Eğer sayfa bir web sunucusundan (http/https) yüklenmişse kendi origin'ini kullan
            if (window.location.protocol.startsWith('http')) {
                return window.location.origin;
            }
            return 'http://localhost:8000';
        } catch {
            return 'http://localhost:8000';
        }
    }
    
    // XSS koruması — innerHTML kullanılan yerlerde bu fonksiyonu çağırın
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    // API Key ve Content-Type header'larını içeren nesne üretir
    function getHeaders(contentType = 'application/json') {
        const headers = {};
        if (contentType) {
            headers['Content-Type'] = contentType;
        }
        try {
            const settings = JSON.parse(localStorage.getItem('presentai_settings') || '{}');
            if (settings.apiKey) {
                headers['X-API-Key'] = settings.apiKey;
            }
        } catch {}
        return headers;
    }
    
    window.BACKEND_URL = getBackendUrl();
    window.escapeHtml = escapeHtml;
    window.getHeaders = getHeaders;
})();
