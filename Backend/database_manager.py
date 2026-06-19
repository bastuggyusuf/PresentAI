import os
from dotenv import load_dotenv
from langchain_community.document_loaders import PyMuPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_chroma import Chroma
from rag_engine import _extract_entities_regex

load_dotenv()

def ingest_docs(pdf_path: str):
    try:
        # 1. Yükle (PyMuPDF ile)
        loader = PyMuPDFLoader(pdf_path)
        docs = loader.load()
        
        # 2. Ön işleme ve Entity Çıkarımı (regex tabanlı — Python 3.14 uyumlu)
        for doc in docs:
            entities = _extract_entities_regex(doc.page_content)
            doc.metadata["entities"] = ", ".join(entities) if entities else "None"
        
        # 3. Parçala
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=512, 
            chunk_overlap=50,
        )
        splits = text_splitter.split_documents(docs)
        
        # 4. Vektörleştir ve Kaydet (Gemini Embeddings kullanarak)
        embeddings = GoogleGenerativeAIEmbeddings(
            model="models/gemini-embedding-001",
            google_api_key=os.getenv("GEMINI_API_KEY")
        )
        persist_dir = "./vector_db"
        os.makedirs(persist_dir, exist_ok=True)
        vector_db = Chroma.from_documents(
            documents=splits, 
            embedding=embeddings,
            persist_directory=persist_dir
        )
        # Yeni ChromaDB sürümlerinde persist() kaldırıldı (otomatik persist)
        try:
            if hasattr(vector_db, "persist"):
                vector_db.persist()
        except Exception:
            pass
        return f"{len(splits)} parça başarıyla veritabanına eklendi."
    except Exception as e:
        return f"Hata: {str(e)}"

if __name__ == "__main__":
    pass