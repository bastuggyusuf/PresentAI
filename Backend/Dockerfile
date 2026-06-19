FROM python:3.11-slim

WORKDIR /app

# Sistem bağımlılıkları
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python bağımlılıkları
COPY Backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Uygulama dosyalarını kopyala
COPY Backend/ /app/

# Web frontend dosyalarını kopyala
COPY web/ /app/web/

# Gerekli dizinleri oluştur
RUN mkdir -p data/datasets vector_db

# Port
EXPOSE 8000

# UTF-8 desteği
ENV PYTHONIOENCODING=utf-8
ENV LANG=C.UTF-8

# Başlatma komutu
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
