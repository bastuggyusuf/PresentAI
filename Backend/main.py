import sys
import os
import shutil
import wave
import asyncio
import uuid
import logging
from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect, Request, Header, Depends, Form
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
import sqlite3

# Geçerli dizini sys.path'e ekle
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rag_engine import PresentAIRAG

# ───────────────────────────────────────────────────────────
# Loglama yapılandırması
# ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("presentai")

# ───────────────────────────────────────────────────────────
# Güvenlik / kota yapılandırması
# ───────────────────────────────────────────────────────────
PRESENTAI_API_KEY = os.getenv("PRESENTAI_API_KEY", "")  # .env'de boş bırakılırsa auth devre dışı (dev mode)
MAX_PDF_BYTES = 20 * 1024 * 1024   # 20MB
MAX_AUDIO_BYTES = 10 * 1024 * 1024 # 10MB

from fastapi.middleware.cors import CORSMiddleware

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="PresentAI Backend API")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS ayarları — production'da ALLOWED_ORIGINS env ile kısıtlanır
_allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _allowed_origins],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Güvenlik header'ları
from starlette.middleware.base import BaseHTTPMiddleware

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

app.add_middleware(SecurityHeadersMiddleware)

from fastapi.staticfiles import StaticFiles
_current_dir = os.path.dirname(os.path.abspath(__file__))
_web_dir = os.path.join(_current_dir, "web")
if not os.path.exists(_web_dir):
    _web_dir = os.path.join(_current_dir, "..", "web")
app.mount("/web", StaticFiles(directory=_web_dir), name="web")

rag = PresentAIRAG()

DB_PATH = os.getenv("DB_PATH", "web_presentations.sqlite3")

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS presentations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT,
                startTime TEXT,
                endTime TEXT,
                score INTEGER,
                durationSec INTEGER,
                wpm INTEGER,
                fillerCount INTEGER,
                dominantEmotion TEXT,
                tone TEXT,
                transcript TEXT DEFAULT '',
                summary TEXT DEFAULT '',
                suggestions TEXT DEFAULT ''
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS corporate_datasets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                upload_date TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                is_active INTEGER DEFAULT 1,
                file_path TEXT NOT NULL
            )
        ''')
        # Sütunları eski veritabanlarına güvenlice ekle
        try: cursor.execute("ALTER TABLE presentations ADD COLUMN transcript TEXT DEFAULT ''")
        except Exception: pass
        try: cursor.execute("ALTER TABLE presentations ADD COLUMN summary TEXT DEFAULT ''")
        except Exception: pass
        try: cursor.execute("ALTER TABLE presentations ADD COLUMN suggestions TEXT DEFAULT ''")
        except Exception: pass
        
        # Seed data — sadece SEED_DATA=true ise ve tablo boşsa eklenir
        if os.getenv("SEED_DATA", "true").lower() == "true":
            cursor.execute('SELECT COUNT(*) FROM presentations')
            count = cursor.fetchone()[0]
            if count == 0:
                seed_data = [
                    ('2026-05-26', '2026-05-26T14:30:00', '2026-05-26T14:34:23', 94, 263, 142, 8, 'Happy', 'Profesyonel'),
                    ('2026-05-24', '2026-05-24T10:15:00', '2026-05-24T10:18:18', 87, 198, 138, 12, 'Happy', 'Samimi'),
                    ('2026-05-22', '2026-05-22T16:00:00', '2026-05-22T16:05:12', 76, 312, 125, 18, 'Neutral', 'Akademik'),
                    ('2026-05-20', '2026-05-20T09:45:00', '2026-05-20T09:49:05', 82, 245, 145, 10, 'Happy', 'Profesyonel'),
                    ('2026-05-18', '2026-05-18T11:20:00', '2026-05-18T11:23:04', 68, 184, 118, 22, 'Neutral', 'Belirsiz'),
                    ('2026-05-15', '2026-05-15T15:10:00', '2026-05-15T15:13:40', 73, 220, 130, 15, 'Happy', 'Samimi'),
                    ('2026-05-13', '2026-05-13T13:30:00', '2026-05-13T13:32:58', 65, 178, 115, 25, 'Neutral', 'Akademik')
                ]
                cursor.executemany('''
                    INSERT INTO presentations (date, startTime, endTime, score, durationSec, wpm, fillerCount, dominantEmotion, tone)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', seed_data)
        conn.commit()

init_db()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def require_api_key(x_api_key: str | None = Header(default=None)):
    """
    Production'da PRESENTAI_API_KEY .env'de set edilmeli — istemci her isteğe
    `X-API-Key` header'ı koymalı. Dev'de boş bırakılırsa auth atlanır.
    """
    if not PRESENTAI_API_KEY:
        return  # dev mode — kapı açık
    if not x_api_key or x_api_key != PRESENTAI_API_KEY:
        raise HTTPException(status_code=401, detail="Geçersiz veya eksik API anahtarı")


class QuestionRequest(BaseModel):
    prompt: str

class HintRequest(BaseModel):
    context: str

class SpeechQualityRequest(BaseModel):
    transcript: str

class RealtimeAssistRequest(BaseModel):
    recent_text: str

class PresentationCreate(BaseModel):
    date: str
    startTime: str
    endTime: str
    score: int
    durationSec: int
    wpm: int
    fillerCount: int
    dominantEmotion: str
    tone: str
    transcript: str = ""
    summary: str = ""
    suggestions: str = ""

@app.get("/api/presentations")
def get_presentations(_auth=Depends(require_api_key)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM presentations ORDER BY id DESC')
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

@app.post("/api/presentations")
def create_presentation(pres: PresentationCreate, _auth=Depends(require_api_key)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO presentations (date, startTime, endTime, score, durationSec, wpm, fillerCount, dominantEmotion, tone, transcript, summary, suggestions)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (pres.date, pres.startTime, pres.endTime, pres.score, pres.durationSec, pres.wpm, pres.fillerCount, pres.dominantEmotion, pres.tone, pres.transcript, pres.summary, pres.suggestions))
        conn.commit()
        return {"status": "success", "id": cursor.lastrowid}

# Gemini yapılandırması — startup'ta bir kez yap
import google.generativeai as genai
_gemini_key = os.getenv("GEMINI_API_KEY")
if _gemini_key:
    genai.configure(api_key=_gemini_key)
_gemini_model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

@app.post("/api/transcribe_chunk")
async def transcribe_chunk(file: UploadFile = File(...), _auth=Depends(require_api_key)):
    model = genai.GenerativeModel(_gemini_model_name)
    audio_bytes = await file.read()
    try:
        response = model.generate_content([
            "Bu ses kaydını Türkçeye deşifre et (transcribe). YALNIZCA konuşulan metni ver, başka hiçbir yorum veya açıklama ekleme. Seste konuşma yoksa veya anlaşılamıyorsa boş dön.",
            {"mime_type": file.content_type or "audio/webm", "data": audio_bytes}
        ])
        return {"text": response.text.strip()}
    except Exception as e:
        logger.error("Transcribe Chunk hatası: %s", e)
        return {"text": ""}

class TranscribeBase64Request(BaseModel):
    audio_base64: str
    mime_type: str = "audio/webm"

@app.post("/api/transcribe_base64")
async def transcribe_base64(req: TranscribeBase64Request, _auth=Depends(require_api_key)):
    import base64
    model = genai.GenerativeModel(_gemini_model_name)
    
    try:
        # Decode base64 to raw bytes
        # Format might come as "data:audio/webm;base64,GkXf..." or raw Base64.
        b64_str = req.audio_base64
        if "base64," in b64_str:
            b64_str = b64_str.split("base64,")[1]
            
        audio_bytes = base64.b64decode(b64_str)
        
        response = model.generate_content([
            "Bu ses kaydını Türkçeye deşifre et (transcribe). YALNIZCA konuşulan metni ver, başka hiçbir yorum veya açıklama ekleme. Seste konuşma yoksa veya anlaşılamıyorsa boş dön.",
            {"mime_type": req.mime_type, "data": audio_bytes}
        ])
        return {"text": response.text.strip()}
    except Exception as e:
        logger.error("Transcribe Base64 hatası: %s", e)
        return {"text": ""}

@app.get("/")
def home():
    return {"status": "PresentAI API is running!"}

@app.get("/health")
def health_check():
    """Sistem sağlık durumu — Settings sayfası bağlantı testi için."""
    model = os.getenv("OPENROUTER_MODEL", "bilinmiyor")
    return {"status": "ok", "model": model}

@app.delete("/api/presentations/clear")
def clear_presentations(_auth=Depends(require_api_key)):
    """Tüm sunum verilerini sil — Settings sayfası veritabanı yönetimi."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM presentations')
        conn.commit()
        return {"status": "success", "message": "Tüm veriler silindi"}


@app.post("/ask")
@limiter.limit("20/minute")
def ask_question(request: Request, body: QuestionRequest, _auth=Depends(require_api_key)):
    try:
        answer = rag.get_response(body.prompt)
        return {"answer": answer}
    except Exception as e:
        logger.error("RAG hatası: %s", e)
        raise HTTPException(status_code=500, detail="İşlem sırasında bir hata oluştu.")

@app.post("/upload_pdf")
@limiter.limit("5/minute")
async def upload_pdf(request: Request, file: UploadFile = File(...), _auth=Depends(require_api_key)):
    contents = await file.read()
    if len(contents) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail=f"PDF çok büyük (max {MAX_PDF_BYTES // (1024*1024)}MB)")

    os.makedirs("data/datasets", exist_ok=True)
    file_id = uuid.uuid4().hex
    safe_filename = f"{file_id}_{file.filename}"
    file_path = os.path.join("data", "datasets", safe_filename)
    
    try:
        with open(file_path, "wb") as buffer:
            buffer.write(contents)
            
        import datetime
        upload_date = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        file_size = len(contents)
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO corporate_datasets (filename, name, category, upload_date, file_size, is_active, file_path)
                VALUES (?, ?, ?, ?, ?, 1, ?)
            ''', (file.filename, "Otomatik Yüklenen Doküman", "Şirket Verisi", upload_date, file_size, file_path))
            conn.commit()
            dataset_id = cursor.lastrowid
            
        rag.ingest_pdf(file_path, dataset_id=str(dataset_id))
        return {"status": "success", "message": f"{file.filename} başarıyla yüklendi ve işlendi."}
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        logger.error("PDF yükleme hatası: %s", e)
        raise HTTPException(status_code=500, detail="PDF yükleme sırasında bir hata oluştu.")

@app.get("/api/datasets")
def get_datasets(_auth=Depends(require_api_key)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM corporate_datasets ORDER BY id DESC')
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

@app.post("/api/datasets")
@limiter.limit("5/minute")
async def create_dataset(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(...),
    category: str = Form(...),
    _auth=Depends(require_api_key)
):
    contents = await file.read()
    if len(contents) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail=f"PDF çok büyük (max {MAX_PDF_BYTES // (1024*1024)}MB)")

    os.makedirs("data/datasets", exist_ok=True)
    file_id = uuid.uuid4().hex
    safe_filename = f"{file_id}_{file.filename}"
    file_path = os.path.join("data", "datasets", safe_filename)
    
    try:
        with open(file_path, "wb") as buffer:
            buffer.write(contents)
            
        import datetime
        upload_date = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        file_size = len(contents)
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO corporate_datasets (filename, name, category, upload_date, file_size, is_active, file_path)
                VALUES (?, ?, ?, ?, ?, 1, ?)
            ''', (file.filename, name, category, upload_date, file_size, file_path))
            conn.commit()
            dataset_id = cursor.lastrowid
            
        rag.ingest_pdf(file_path, dataset_id=str(dataset_id))
        return {"status": "success", "id": dataset_id, "message": f"{file.filename} başarıyla yüklendi ve indekslendi."}
    except Exception as e:
        if os.path.exists(file_path):
            os.remove(file_path)
        logger.error("Veri seti yükleme hatası: %s", e)
        raise HTTPException(status_code=500, detail="Veri seti yükleme sırasında bir hata oluştu.")

@app.put("/api/datasets/{id}/toggle")
def toggle_dataset(id: int, _auth=Depends(require_api_key)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT is_active FROM corporate_datasets WHERE id = ?', (id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Veri seti bulunamadı")
        
        new_status = 0 if row['is_active'] == 1 else 1
        cursor.execute('UPDATE corporate_datasets SET is_active = ? WHERE id = ?', (new_status, id))
        conn.commit()
        return {"status": "success", "is_active": new_status}

@app.delete("/api/datasets/{id}")
def delete_dataset(id: int, _auth=Depends(require_api_key)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT file_path FROM corporate_datasets WHERE id = ?', (id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Veri seti bulunamadı")
        
        file_path = row['file_path']
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception as e:
                logger.warning("Dosya silinemedi %s: %s", file_path, e)
                
        rag.delete_dataset_from_vector_db(str(id))
        
        cursor.execute('DELETE FROM corporate_datasets WHERE id = ?', (id,))
        conn.commit()
        return {"status": "success", "message": "Veri seti silindi"}

@app.post("/hint")
@limiter.limit("30/minute")
def generate_hint(request: Request, body: HintRequest, _auth=Depends(require_api_key)):
    try:
        prompt = f"Şu anki durum: {body.context}. Bana izleyiciyi canlandıracak kısa bir ipucu ver. Sadece ipucunu döndür."
        answer = rag.get_response(prompt)
        return {"hint": answer}
    except Exception as e:
        logger.error("Hint hatası: %s", e)
        raise HTTPException(status_code=500, detail="İpucu oluşturulurken bir hata oluştu.")

@app.post("/analyze_speech_quality")
@limiter.limit("10/minute")
def analyze_speech_quality(request: Request, body: SpeechQualityRequest, _auth=Depends(require_api_key)):
    try:
        result = rag.analyze_speech_quality(body.transcript)
        return result
    except Exception as e:
        logger.error("Speech quality hatası: %s", e)
        raise HTTPException(status_code=500, detail="Konuşma analizi sırasında bir hata oluştu.")

@app.post("/realtime_assist")
@limiter.limit("60/minute")
def realtime_assist(request: Request, body: RealtimeAssistRequest, _auth=Depends(require_api_key)):
    try:
        return rag.realtime_assist(body.recent_text)
    except Exception as e:
        logger.error("Realtime assist hatası: %s", e)
        raise HTTPException(status_code=500, detail="Gerçek zamanlı destek hatası oluştu.")


class EmotionUpdate(BaseModel):
    emotion: str

current_device_emotion = "Neutral"

@app.post("/update_device_emotion")
def update_device_emotion(body: EmotionUpdate, _auth=Depends(require_api_key)):
    global current_device_emotion
    current_device_emotion = body.emotion
    return {"status": "ok"}

@app.get("/get_device_emotion")
def get_device_emotion(_auth=Depends(require_api_key)):
    global current_device_emotion
    return {"emotion": current_device_emotion}


class FrameAnalysisRequest(BaseModel):
    image_base64: str

@app.post("/analyze_frame")
def analyze_frame(body: FrameAnalysisRequest, _auth=Depends(require_api_key)):
    import base64
    try:
        b64_str = body.image_base64
        if "," in b64_str:
            b64_str = b64_str.split(",")[1]
        
        image_data = base64.b64decode(b64_str)
        model = genai.GenerativeModel(_gemini_model_name)
        
        prompt = (
            "Analyze the face in this image. Classify the dominant facial emotion. "
            "Choose exactly one from: 'Happy', 'Neutral', 'Surprise', 'Sad', 'Disgust', 'Angry', 'Fear'. "
            "Respond with only the emotion name, no other text, no formatting, no punctuation."
        )
        
        response = model.generate_content([
            prompt,
            {
                "mime_type": "image/jpeg",
                "data": image_data
            }
        ])
        
        emotion = response.text.strip()
        emotion = emotion.replace("'", "").replace('"', "").replace("`", "").replace(".", "").strip()
        
        valid_emotions = {'Happy', 'Neutral', 'Surprise', 'Sad', 'Disgust', 'Angry', 'Fear'}
        if emotion not in valid_emotions:
            matched = False
            for ve in valid_emotions:
                if ve.lower() in emotion.lower():
                    emotion = ve
                    matched = True
                    break
            if not matched:
                emotion = "Neutral"
                
        return {"emotion": emotion}
    except Exception as e:
        logger.error("Frame analiz hatası: %s", e)
        return {"emotion": "Neutral", "error": str(e)}



@app.post("/analyze_audio")
@limiter.limit("30/minute")
async def analyze_audio(request: Request, file: UploadFile = File(...), _auth=Depends(require_api_key)):
    contents = await file.read()
    if len(contents) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"Ses dosyası çok büyük (max {MAX_AUDIO_BYTES // (1024*1024)}MB)")

    import tempfile
    temp_file = os.path.join(tempfile.gettempdir(), f"presentai_{uuid.uuid4().hex}.wav")
    try:
        with open(temp_file, "wb") as buffer:
            buffer.write(contents)
        result = rag.analyze_audio(temp_file)
        return result
    except Exception as e:
        logger.error("Ses analizi hatası: %s", e)
        raise HTTPException(status_code=500, detail="Ses analizi sırasında bir hata oluştu.")
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

# Çalıştırmak için terminale: uvicorn main:app --reload

def pcm_to_wav(pcm_data: bytes, output_filename: str, sample_rate=16000, num_channels=1, sampwidth=2):
    with wave.open(output_filename, 'wb') as wav_file:
        wav_file.setnchannels(num_channels)
        wav_file.setsampwidth(sampwidth)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_data)

@app.websocket("/ws/audio")
async def websocket_audio_endpoint(websocket: WebSocket):
    # WebSocket auth — header destek sınırlı, query param ile API key kontrolü
    if PRESENTAI_API_KEY:
        client_key = websocket.query_params.get("api_key", "")
        if client_key != PRESENTAI_API_KEY:
            await websocket.close(code=1008)  # Policy Violation
            return

    await websocket.accept()
    client_id = uuid.uuid4().hex  # id(websocket) yerine UUID — paralel istemciler arası çakışmayı önler
    buffer = bytearray()

    # 16000 Hz * 2 bytes/sample * 1 channel = 32000 bytes/sec
    # Her 3 saniyede bir analiz yapmak için biriktiriyoruz (96000 bytes)
    CHUNK_PROCESS_SIZE = 16000 * 2 * 3

    def process_chunk(filename):
        try:
            return rag.analyze_audio(filename)
        except Exception as e:
            return {"error": str(e)}
        finally:
            if os.path.exists(filename):
                os.remove(filename)

    try:
        while True:
            data = await websocket.receive_bytes()
            buffer.extend(data)

            if len(buffer) >= CHUNK_PROCESS_SIZE:
                import tempfile
                temp_filename = os.path.join(tempfile.gettempdir(), f"temp_ws_{client_id}.wav")
                pcm_to_wav(bytes(buffer), temp_filename)
                buffer.clear()

                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, process_chunk, temp_filename)

                if "error" not in result:
                    await websocket.send_json(result)
                else:
                    logger.error("WebSocket chunk analiz hatası: %s", result['error'])
                    await websocket.send_json({"text": f"HATA: {result['error']}", "filler_count": 0, "word_count": 0})

    except WebSocketDisconnect:
        logger.info("Client %s bağlantısı kesildi", client_id)
        import tempfile
        leftover = os.path.join(tempfile.gettempdir(), f"temp_ws_{client_id}.wav")
        if os.path.exists(leftover):
            os.remove(leftover)
