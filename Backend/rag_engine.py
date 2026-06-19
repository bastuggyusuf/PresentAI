import os
import re
import logging
from dotenv import load_dotenv
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_chroma import Chroma
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from openai import OpenAI

load_dotenv(override=True)
logger = logging.getLogger("presentai.rag")

def _extract_entities_regex(text: str) -> set:
    """
    Hafif regex tabanlı entity çıkarıcı.
    spaCy Python 3.14 ile uyumsuz olduğu için bu yöntem kullanılıyor.
    Para birimi, organizasyon anahtar kelimeleri ve çok kelimeli özel isimleri yakalar.
    """
    entities = set()
    # Para birimi tespiti (MONEY)
    money_patterns = re.findall(
        r'[\$€₺]\s*[\d.,]+|[\d.,]+\s*(?:TL|USD|EUR|dolar|euro|lira)', text, re.IGNORECASE
    )
    for m in money_patterns:
        entities.add(f"{m.strip()} (MONEY)")
    # Organizasyon anahtar kelimeleri (ORG)
    org_patterns = re.findall(
        r'(?:(?:Inc|Corp|Ltd|LLC|A\.Ş\.|Şti|GmbH|üniversite|fakülte|enstitü|vakf|dernek)\b[.]?)',
        text, re.IGNORECASE
    )
    for o in org_patterns:
        entities.add(f"{o.strip()} (ORG)")
    # Büyük harfle başlayan çok kelimeli isimler (2-4 kelime, potansiyel PRODUCT/ORG)
    proper_nouns = re.findall(r'\b([A-ZÇĞİÖŞÜ][a-zçğıöşü]+(?:\s+[A-ZÇĞİÖŞÜ][a-zçğıöşü]+){1,3})\b', text)
    for pn in proper_nouns:
        entities.add(f"{pn} (PRODUCT)")
    return entities

class PresentAIRAG:
    def __init__(self):
        # 1. Gemini Embeddings (yalnızca PDF vektör araması için)
        self.embeddings = GoogleGenerativeAIEmbeddings(
            model="models/gemini-embedding-001",
            google_api_key=os.getenv("GEMINI_API_KEY")
        )
        persist_dir = os.getenv("VECTOR_DB_PATH", "./vector_db")
        os.makedirs(persist_dir, exist_ok=True)
        self.vector_db = Chroma(
            persist_directory=persist_dir, 
            embedding_function=self.embeddings
        )
        
        # 2. OpenRouter LLM (Qwen 3 4B — Ücretsiz ve Limitsiz!)
        api_key = os.getenv("OPENROUTER_API_KEY")
        if not api_key:
            logger.warning("OPENROUTER_API_KEY bulunamadi! .env dosyasini kontrol edin.")
        
        self.openrouter_client = OpenAI(
            api_key=api_key or "missing",
            base_url="https://openrouter.ai/api/v1",
        )
        self.active_model = os.getenv("OPENROUTER_MODEL", "qwen/qwen3-4b:free")
        logger.info("LLM hazir: %s (OpenRouter)", self.active_model)

    def _llm_invoke(self, prompt: str) -> str:
        """OpenRouter üzerinden LLM çağrısı yapar."""
        response = self.openrouter_client.chat.completions.create(
            model=self.active_model,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content or ""

    def _reset_vector_db(self):
        """
        Tüm vektörleri sil.
        """
        try:
            collection = self.vector_db._collection
            existing_ids = collection.get().get("ids", [])
            if existing_ids:
                collection.delete(ids=existing_ids)
        except Exception as e:
            logger.warning("vector_db reset uyarisi: %s", e)

    def delete_dataset_from_vector_db(self, dataset_id: str):
        """Belirtilen dataset_id değerine ait tüm chunkları ChromaDB'den siler."""
        try:
            collection = self.vector_db._collection
            collection.delete(where={"dataset_id": str(dataset_id)})
            logger.info("Dataset %s chunklari Chroma'dan silindi.", dataset_id)
        except Exception as e:
            logger.error("Dataset %s chunk silme hatasi: %s", dataset_id, e)

    def _get_active_dataset_ids(self) -> list[str]:
        """SQLite veritabanından aktif olan (is_active = 1) veri seti ID'lerini çeker."""
        import sqlite3
        try:
            db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.getenv("DB_PATH", "web_presentations.sqlite3"))
            if not os.path.exists(db_path):
                db_path = "web_presentations.sqlite3"
            with sqlite3.connect(db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='corporate_datasets'")
                if not cursor.fetchone():
                    return []
                cursor.execute("SELECT id FROM corporate_datasets WHERE is_active = 1")
                return [str(row[0]) for row in cursor.fetchall()]
        except Exception as e:
            logger.error("Aktif dataset ID'leri alinamadi: %s", e)
            return []

    def ingest_pdf(self, file_path: str, dataset_id: str = "default"):
        try:
            # Önce bu veri setine ait eski chunkları temizle (tekrar yükleme durumunda çakışma önle)
            self.delete_dataset_from_vector_db(dataset_id)

            # 1. Block-based reading for stability
            loader = PyMuPDFLoader(file_path)
            docs = loader.load()

            # 2. Heading-Aware & Entity extraction Logic
            for doc in docs:
                lines = doc.page_content.split("\n")
                current_heading = "Unknown"
                for line in lines:
                    if len(line) < 60 and line.isupper():
                        current_heading = line
                        break
                doc.metadata["current_heading"] = current_heading

                # Hafif regex tabanlı NER (spaCy yerine — Python 3.14 uyumlu)
                entities = _extract_entities_regex(doc.page_content)
                doc.metadata["entities"] = ", ".join(entities) if entities else "None"
                # Her chunk'ı dataset_id ile etiketle
                doc.metadata["dataset_id"] = str(dataset_id)

            # 3. Semantic friendly chunk sizes
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=512, chunk_overlap=50)
            splits = text_splitter.split_documents(docs)
            self.vector_db.add_documents(splits)
            
            # Yeni ChromaDB sürümlerinde persist() kaldırıldı (otomatik persist)
            try:
                if hasattr(self.vector_db, "persist"):
                    self.vector_db.persist()
            except Exception:
                pass  # Otomatik persist aktif, hata yoksayılır
        except Exception as e:
            raise Exception(f"PDF eklenirken hata: {str(e)}")

    def get_response(self, query: str):
        try:
            active_ids = self._get_active_dataset_ids()
            if not active_ids:
                # Aktif veri seti yoksa doğrudan LLM genel bilgisiyle cevap verelim
                prompt = f"""Soru: {query}

Cevap:"""
                return self._llm_invoke(prompt)

            # Retrieve relevant documents
            if len(active_ids) == 1:
                search_filter = {"dataset_id": active_ids[0]}
            else:
                search_filter = {"dataset_id": {"$in": active_ids}}

            docs = self.vector_db.similarity_search(query, k=3, filter=search_filter)
            
            # Incorporating the extracted context with heading data
            context_list = []
            for doc in docs:
                heading_info = f"[Başlık: {doc.metadata.get('current_heading', 'Bilinmiyor')}] "
                context_list.append(heading_info + doc.page_content)
            
            context = "\n".join(context_list)
            
            prompt = f"""Aşağıdaki bağlama dayanarak soruyu cevaplayınız:

Bağlam:
{context}

Soru: {query}

Cevap:"""
            
            raw = self._llm_invoke(prompt)
            return raw
        except Exception as e:
            return f"Yanıt alınamadı: {str(e)}"

    def analyze_audio(self, audio_file_path: str):
        try:
            import speech_recognition as sr

            recognizer = sr.Recognizer()
            with sr.AudioFile(audio_file_path) as source:
                audio_data = recognizer.record(source)

            try:
                # Tamamen Ücretsiz Google Web Speech API kullanımı
                text = recognizer.recognize_google(audio_data, language="tr-TR")
            except Exception:
                # Sesi anlayamazsa boş metin döndürür
                text = ""

            words = re.findall(r'\b\w+\b', text.lower())

            filler_words_list = {"ee", "şey", "yani", "ıı", "hmm", "falan", "filan", "eee", "ııı"}
            # Filler kelimeleri tek tek say (hangisi kaç kez)
            filler_breakdown: dict[str, int] = {}
            for w in words:
                if w in filler_words_list:
                    filler_breakdown[w] = filler_breakdown.get(w, 0) + 1
            filler_count = sum(filler_breakdown.values())
            actual_word_count = sum(1 for word in words if word not in filler_words_list)

            # Cümle ayrımı (nokta/soru/ünlem)
            sentences = [s.strip() for s in re.split(r'[.!?]+', text) if s.strip()]
            sentence_count = len(sentences)
            avg_sentence_length = (actual_word_count / sentence_count) if sentence_count > 0 else 0.0

            return {
                "text": text,
                "filler_count": filler_count,
                "word_count": actual_word_count,
                "sentence_count": sentence_count,
                "avg_sentence_length": round(avg_sentence_length, 2),
                # "ee: 3, yani: 2" tarzı kelime:sayı eşleştirmesi
                "filler_breakdown": filler_breakdown,
            }
        except Exception as e:
            raise Exception(f"Ses analizi hatası: {str(e)}")

    def analyze_speech_quality(self, transcript: str):
        """
        Sunum sonunda toplam transkripti alır ve Gemini ile
        ton + içerik netliği analizi yapar.
        Timeout + 1 retry ile dayanıklı hale getirildi.
        Returns: {tone, clarity_score, summary, suggestions}
        """
        if not transcript or len(transcript.strip()) < 10:
            return {
                "tone": "Belirsiz",
                "clarity_score": 0,
                "summary": "Konuşma metni çok kısa — analiz yapılamadı.",
                "suggestions": "Daha uzun ve net konuşmayı deneyin.",
            }
        prompt = f"""Aşağıdaki sunum transkriptini analiz et. Yalnızca JSON döndür, başka metin yok.

Transkript:
\"\"\"{transcript[:4000]}\"\"\"

İstenen JSON formatı (alanları MUTLAKA doldur):
{{
  "tone": "Profesyonel|Samimi|Akademik|Heyecanlı|Belirsiz",
  "clarity_score": <0-100 arası tam sayı, içerik netliği>,
  "summary": "Konuşmanın 1-2 cümlelik özeti (TR)",
  "suggestions": "Konuşmacıya 1-2 cümlelik somut öneri (TR)"
}}"""
        import json
        import time

        def call_once():
            raw = self._llm_invoke(prompt)
            match = re.search(r'\{[\s\S]*\}', raw)
            if not match:
                return {
                    "tone": "Belirsiz",
                    "clarity_score": 50,
                    "summary": raw[:200],
                    "suggestions": "—",
                }
            data = json.loads(match.group(0))
            return {
                "tone": str(data.get("tone", "Belirsiz"))[:32],
                "clarity_score": int(max(0, min(100, data.get("clarity_score", 50)))),
                "summary": str(data.get("summary", ""))[:300],
                "suggestions": str(data.get("suggestions", ""))[:300],
            }

        last_err = None
        for attempt in range(2):  # 1 ana çağrı + 1 retry
            try:
                return call_once()
            except Exception as e:
                last_err = e
                if attempt == 0:
                    time.sleep(1.5)  # rate-limit / transient hata için kısa bekle
                    continue
        # 2 deneme de başarısız
        return {
            "tone": "Hata",
            "clarity_score": 0,
            "summary": f"Analiz hatası (2 deneme): {str(last_err)[:120]}",
            "suggestions": "İnternet bağlantınızı kontrol edin veya tekrar deneyin.",
        }

    @staticmethod
    def _detect_question(text: str) -> str | None:
        """
        Türkçe soru tespiti.
        - 'mi/mı/mu/mü' eki: kelime sonunda veya başında ayrı kelime olarak
        - Soru sözcükleri: ne, nedir, nasıl, neden, niçin, kim, ne zaman, kaç, hangi, nerede, kimden, hangisi, hangisini
        - '?' işareti
        Bulursa soru cümlesini döndürür, yoksa None.
        """
        if not text:
            return None
        if "?" in text:
            # En son '?' cümlesini al
            parts = re.split(r'[.!]', text)
            for p in reversed(parts):
                if "?" in p:
                    return p.strip().rstrip('?') + "?"
        lower = text.lower()
        # Türkçe soru sözcükleri (kelime sınırında)
        q_words = [
            r"\bne\b", r"\bnedir\b", r"\bnasıl\b", r"\bneden\b", r"\bniçin\b",
            r"\bkim\b", r"\bkimdir\b", r"\bne zaman\b", r"\bkaç\b", r"\bhangi\b",
            r"\bhangisi\b", r"\bnerede\b", r"\bnereye\b", r"\bnereden\b",
            r"\bkimin\b", r"\bkime\b", r"\bkimi\b",
        ]
        for pat in q_words:
            if re.search(pat, lower):
                # Soru sözcüğünü içeren cümleyi geri döndür (son ~120 karakter)
                sentences = re.split(r'(?<=[.!])\s+', text.strip())
                for s in reversed(sentences):
                    if re.search(pat, s.lower()):
                        return s.strip()[:200]
                return text.strip()[-200:]
        # 'mi/mı/mu/mü' soru eki — kelime sonunda
        if re.search(r"\b\w+(mi|mı|mu|mü)\b\s*\??\s*$", lower):
            return text.strip()[-200:]
            
        # Asistana özel seslenişler (Wake Words)
        wake_words = [r"\bceylan\b", r"\bpresentai\b", r"\byapay zeka\b", r"\basistan\b", r"\bbana söyle\b", r"\bne dersin\b"]
        for pat in wake_words:
            if re.search(pat, lower):
                return text.strip()[-200:]
                
        return None

    def _answer_question(self, question: str) -> dict:
        """Soru tespit edildiğinde aktif veri setleri ile kısa cevap üretir."""
        active_ids = self._get_active_dataset_ids()
        has_pdf = len(active_ids) > 0
        pdf_context = ""
        source = "LLM"
        
        if has_pdf:
            try:
                if len(active_ids) == 1:
                    search_filter = {"dataset_id": active_ids[0]}
                else:
                    search_filter = {"dataset_id": {"$in": active_ids}}
                
                docs = self.vector_db.similarity_search(question, k=4, filter=search_filter)
                if docs:
                    pdf_context = "\n---\n".join(
                        f"[{d.metadata.get('current_heading','?')}] {d.page_content[:350]}"
                        for d in docs
                    )
                    source = "PDF"
                else:
                    has_pdf = False
            except Exception as e:
                logger.error("Soru cevaplama similarity search hatasi: %s", e)
                has_pdf = False

        if has_pdf and pdf_context:
            prompt = f"""Sunum sırasında karşı taraftan bir soru geldi.
PDF'teki bilgileri kullan, kısa ve net (MAKSİMUM 180 karakter) bir cevap üret.
Yalnızca JSON döndür.

PDF Bağlamı:
\"\"\"{pdf_context[:2000]}\"\"\"

Soru: \"\"\"{question}\"\"\"

JSON: {{ "message": "Türkçe kısa cevap, ≤180 karakter" }}"""
        else:
            prompt = f"""Sunum sırasında bir soru geldi. Aktif bir kurumsal veri seti seçilmediği veya bağlam bulunamadığı için genel bilginle
kısa ve net (MAKSİMUM 180 karakter) bir cevap üret. Yalnızca JSON döndür.
Bilmediğinde \"Bu konuda şirket veri seti yükleyin\" de.

Soru: \"\"\"{question}\"\"\"

JSON: {{ "message": "Türkçe kısa cevap, ≤180 karakter" }}"""
            source = "LLM"

        import json
        try:
            raw = self._llm_invoke(prompt)
            match = re.search(r'\{[\s\S]*\}', raw)
            msg = ""
            if match:
                try:
                    data = json.loads(match.group(0))
                    msg = str(data.get("message", "")).strip()[:220]
                except Exception:
                    msg = raw[:220].strip()
            else:
                msg = raw[:220].strip()
            return {"kind": "ANSWER", "message": msg, "source": source}
        except Exception as e:
            err_str = str(e)
            if '429' in err_str:
                return {"kind": "ERROR", "message": "429 Kota doldu. 1dk bekleyin.", "source": source}
            return {"kind": "ERROR", "message": f"Cevap üretilemedi: {err_str[:80]}", "source": source}

    def realtime_assist(self, recent_text: str):
        """
        Konuşma akıyorken her ~10-15 saniyede çağrılır.
        Öncelik sırası:
          1. Soru tespit edildiyse → PDF/Gemini ile cevap üret (kind=ANSWER)
          2. PDF yüklüyse → doğrula/düzelt (VALIDATE/CORRECT)
          3. PDF yoksa → kısa öneri (SUGGEST)
        Yanıt KISA olmalı — bir overlay altyazıda görünecek.

        Returns: {kind, message, source}
        """
        if not recent_text or len(recent_text.strip()) < 8:
            return {"kind": "QUIET", "message": "", "source": "—"}

        # 1. SORU TESPİTİ — en yüksek öncelik
        question = self._detect_question(recent_text)
        if question:
            return self._answer_question(question)

        # PDF var mı? Varsa context al
        active_ids = self._get_active_dataset_ids()
        has_pdf = len(active_ids) > 0
        pdf_context = ""
        source = "LLM"
        
        if has_pdf:
            try:
                if len(active_ids) == 1:
                    search_filter = {"dataset_id": active_ids[0]}
                else:
                    search_filter = {"dataset_id": {"$in": active_ids}}
                
                docs = self.vector_db.similarity_search(recent_text, k=3, filter=search_filter)
                if docs:
                    pdf_context = "\n---\n".join(
                        f"[{d.metadata.get('current_heading','?')}] {d.page_content[:300]}"
                        for d in docs
                    )
                    source = "PDF"
                else:
                    has_pdf = False
            except Exception as e:
                logger.error("Realtime assist similarity search hatasi: %s", e)
                has_pdf = False

        if has_pdf:
            prompt = f"""Sen arka planda sunumu dinleyen yapıcı ve motive edici bir katılımcı/koçsun. Konuşmacının son söylediğini, PDF içeriğine göre değerlendir.
Yalnızca JSON döndür, başka metin yok. Mesaj MAKSİMUM 140 karakter olsun.

PDF Bağlamı:
\"\"\"{pdf_context[:1800]}\"\"\"

Konuşmacının son söylediği:
\"\"\"{recent_text[-600:]}\"\"\"

Eğer söylenen PDF ile uyumlu/doğru ise ve onu tebrik edip desteklemek istiyorsan kind=SUPPORT (örn. 'Çok iyi açıkladın, slayttaki hedefleri net aktardın!'),
Eğer PDF'e göre bilgi doğrulamak istiyorsan kind=VALIDATE,
PDF ile çelişiyor veya eksik ise kind=CORRECT,
PDF kapsamı dışında bir konu ise kind=SUGGEST,
yorum yapacak bir şey yoksa kind=QUIET kullan.

JSON: {{ "kind": "SUPPORT|VALIDATE|CORRECT|SUGGEST|QUIET",
         "message": "Türkçe kısa cümle, ≤140 karakter" }}"""
            source = "PDF"
        else:
            prompt = f"""Sen arka planda konuşmayı dinleyen destekleyici bir katılımcısın. Konuşmacının son söylediğini değerlendir.
PDF yok, genel bilgi/öneri ver veya onu motive edecek destekleyici yorumlar yap. Yalnızca JSON döndür, mesaj MAKSİMUM 140 karakter olsun.

Son söylenen:
\"\"\"{recent_text[-600:]}\"\"\"

Konuşmacıyı motive edecek, destekleyecek destek yorumları için kind=SUPPORT (örn. 'Çok akıcı gidiyorsun, tebrikler!', 'Güzel bir noktaya değindin, harika açıklama!'),
Genel sunum önerisi için kind=SUGGEST,
Sessiz kalacaksan kind=QUIET kullan.

JSON: {{ "kind": "SUPPORT|SUGGEST|QUIET",
         "message": "Türkçe kısa öneri/destek cümlesi, ≤140 karakter" }}"""
            source = "LLM"

        import json
        try:
            raw = self._llm_invoke(prompt)
            match = re.search(r'\{[\s\S]*\}', raw)
            if not match:
                return {"kind": "QUIET", "message": "", "source": source}
            data = json.loads(match.group(0))
            kind = str(data.get("kind", "QUIET")).upper()
            if kind not in {"VALIDATE", "CORRECT", "SUGGEST", "QUIET", "SUPPORT"}:
                kind = "QUIET"
            msg = str(data.get("message", "")).strip()[:160]
            return {"kind": kind, "message": msg, "source": source}
        except Exception as e:
            err_str = str(e)
            if '429' in err_str:
                return {"kind": "ERROR", "message": "429 Kota doldu. 1dk bekleyin.", "source": source}
            return {"kind": "ERROR", "message": f"Hata: {err_str[:80]}", "source": source}
