// PresentAI — Web Practice Logic

const video = document.getElementById('webcam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const transcriptEl = document.getElementById('transcriptEl');
const statusText = document.getElementById('statusText');
const emotionEmoji = document.getElementById('emotionEmoji');
const emotionText = document.getElementById('emotionText');
const aiCoachCard = document.getElementById('aiCoachCard');
const aiMessageEl = document.getElementById('aiMessageEl');
const timerEl = document.getElementById('timerEl');
const wpmEl = document.getElementById('wpmEl');
const fillerEl = document.getElementById('fillerEl');
const endBtn = document.getElementById('endBtn');
const startBtn = document.getElementById('startBtn');
const startOverlay = document.getElementById('startOverlay');

let startTime = null;
let timerInterval = null;
let frameInterval = null;
let aiInterval = null;

let fullTranscript = "";
let currentDisplayTranscript = "";
let totalFillerCount = 0;
let wordCount = 0;
const fillerWords = ["ee", "şey", "yani", "ıı", "hmm", "falan", "filan", "eee", "ııı"];

let emotionHistory = []; // To determine dominant emotion at the end

const EMOTION_MAP = {
  "Happy": "😊",
  "Sad": "😢",
  "Angry": "😠",
  "Fear": "😨",
  "Surprise": "😲",
  "Disgust": "🤢",
  "Neutral": "😐"
};

let audioContext = null;
let analyser = null;
let microphone = null;

// 1. INIT CAMERA
async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    video.srcObject = stream;
    statusText.innerText = "Sistem aktif. Konuşmaya başlayabilirsiniz.";
    
    // Set up audio analyzer for visual feedback
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(stream);
    microphone.connect(analyser);
    analyser.fftSize = 256;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    function drawVolume() {
      requestAnimationFrame(drawVolume);
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for(let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      let average = sum / bufferLength;
      // Map average (0-128 roughly) to width percentage
      let width = Math.min(100, (average / 128) * 100);
      const volumeBar = document.getElementById('volumeBar');
      if(volumeBar) volumeBar.style.width = width + '%';
    }
    drawVolume();
    
    // START FALLBACK RECORDING
    startFallbackRecording(stream);
    
  } catch (err) {
    statusText.innerText = "Kamera/Mikrofon izni alınamadı!";
    console.error(err);
  }
}

// 2. EMOTION ANALYSIS (Every 2 seconds)
async function sendFrameForAnalysis() {
  if (video.videoWidth === 0) return;
  
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  // Convert to base64
  const base64Data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
  
  try {
    const res = await fetch(window.BACKEND_URL + '/analyze_frame', {
      method: 'POST',
      headers: window.getHeaders(),
      body: JSON.stringify({ image_base64: base64Data })
    });
    
    if (res.ok) {
      const data = await res.json();
      const emotion = data.emotion || "Neutral";
      emotionHistory.push(emotion);
      
      emotionText.innerText = emotion;
      emotionEmoji.innerText = EMOTION_MAP[emotion] || "😐";
    }
  } catch (err) {
    console.error("Emotion API error:", err);
  }
}

let mediaRecorder = null;
let chunkInterval = null;

// 3. SPEECH RECOGNITION (Web Speech API) & FALLBACK
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function handleNewText(text) {
  if (!text || text.length < 2) return;
  
  fullTranscript += text + ' ';
  currentDisplayTranscript += text + ' ';
  
  // Update filler and word count
  const words = text.toLowerCase().match(/\b\w+\b/g) || [];
  words.forEach(w => {
    if (fillerWords.includes(w)) totalFillerCount++;
    else wordCount++;
  });
  fillerEl.innerText = totalFillerCount;
  
  // Pagination (250 chars)
  if (currentDisplayTranscript.length > 250) {
    currentDisplayTranscript = text + ' '; // Reset and keep current
  }
  
  transcriptEl.innerText = currentDisplayTranscript;
}

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'tr-TR';
  
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

    let displayText = currentDisplayTranscript + interimTranscript;
    if (displayText.length > 250) {
      displayText = interimTranscript;
    }
    if (interimTranscript) transcriptEl.innerText = displayText;
  };
  
  recognition.onstart = () => {
    statusText.innerText = "Mikrofon dinleniyor... (Web Speech API)";
    statusText.classList.remove('text-slate-400');
    statusText.classList.add('text-green-400');
  };
  
  let isFatalError = false;
  
  recognition.onerror = (event) => {
    console.error("Speech recognition error", event.error);
    statusText.innerText = "Yedek Dinleme Motoru Devrede...";
    statusText.classList.replace('text-red-400', 'text-green-400');
    statusText.classList.replace('text-slate-400', 'text-green-400');
    
    if (event.error === 'not-allowed' || event.error === 'audio-capture') {
       isFatalError = true;
    }
  };
  
  recognition.onend = () => {
    if (startTime && !isFatalError) {
       try { recognition.start(); } catch(e) {}
    }
  };
}

// FALLBACK: MediaRecorder -> Backend Gemini Transcribe
function startFallbackRecording(stream) {
  let initialWordCount = wordCount;
  
  let options = { mimeType: 'audio/webm' };
  if (!MediaRecorder.isTypeSupported('audio/webm')) {
    options = {}; // let the browser choose the default (usually audio/ogg in Firefox/Opera fallback)
  }
  
  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    console.error("MediaRecorder init failed", err);
    statusText.innerText = "Yedek Motor Başlatılamadı: " + err.message;
    return;
  }
  
  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) {
      if (wordCount > initialWordCount) {
        initialWordCount = wordCount;
        return; 
      }
      
      const formData = new FormData();
      formData.append("file", e.data, "chunk.webm");
      
      try {
        const res = await fetch(window.BACKEND_URL + '/api/transcribe_chunk', {
          method: 'POST',
          headers: window.getHeaders(null),
          body: formData
        });
        if (res.ok) {
          const data = await res.json();
          if (data.text) {
             statusText.innerText = "Yedek Motor: Deşifre başarılı.";
             statusText.classList.remove('text-slate-400', 'text-red-400');
             statusText.classList.add('text-green-400');
             handleNewText(data.text);
          } else {
             console.log("Transcribe empty text returned.");
          }
        } else {
          statusText.innerText = "Yedek Motor Hatası: API Yanıt Vermedi";
          statusText.classList.replace('text-green-400', 'text-red-400');
        }
      } catch(err) { 
        console.error("Transcribe API err", err); 
        statusText.innerText = "Yedek Motor Ağ Hatası";
      }
    }
  };
  
  // 4 saniyede bir otomatik olarak ondataavailable tetikler
  mediaRecorder.start(4000);
}

// 4. REALTIME AI ASSIST (Every 10 seconds)
async function checkAiAssist() {
  if (fullTranscript.length < 10) return;
  
  try {
    const res = await fetch(window.BACKEND_URL + '/realtime_assist', {
      method: 'POST',
      headers: window.getHeaders(),
      body: JSON.stringify({ recent_text: fullTranscript })
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data.kind !== "QUIET" && data.message) {
        aiMessageEl.innerText = data.message;
        aiCoachCard.classList.remove('translate-y-10', 'opacity-0');
        
        // Hide after 6 seconds
        setTimeout(() => {
          aiCoachCard.classList.add('translate-y-10', 'opacity-0');
        }, 6000);
      }
    }
  } catch (err) {
    console.error("AI Assist API error:", err);
  }
}

// 5. TIMER & WPM
function updateTimer() {
  const now = new Date();
  const diffSec = Math.floor((now - startTime) / 1000);
  const m = String(Math.floor(diffSec / 60)).padStart(2, '0');
  const s = String(diffSec % 60).padStart(2, '0');
  timerEl.innerText = `${m}:${s}`;
  
  // WPM calculation
  if (diffSec > 0) {
    const wpm = Math.floor((wordCount / diffSec) * 60);
    wpmEl.innerText = wpm;
  }
}

// 6. END PRESENTATION
async function endPresentation() {
  // Stop everything
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
  }
  clearInterval(timerInterval);
  clearInterval(frameInterval);
  clearInterval(aiInterval);
  
  endBtn.innerText = "Kaydediliyor...";
  endBtn.disabled = true;
  
  const now = new Date();
  const durationSec = Math.floor((now - startTime) / 1000);
  
  // Determine dominant emotion
  const emotionCounts = {};
  let dominant = "Neutral";
  let maxCount = 0;
  emotionHistory.forEach(e => {
    emotionCounts[e] = (emotionCounts[e] || 0) + 1;
    if (emotionCounts[e] > maxCount) {
      maxCount = emotionCounts[e];
      dominant = e;
    }
  });
  
  // Mock Score (based on fillers & wpm ideally, simplified here)
  let score = 100;
  score -= (totalFillerCount * 2);
  const finalWpm = durationSec > 0 ? Math.floor((wordCount / durationSec) * 60) : 0;
  if (finalWpm < 100 || finalWpm > 160) score -= 10;
  score = Math.max(40, Math.min(100, score)); // clamp 40-100
  
  const tzOffset = (new Date()).getTimezoneOffset() * 60000;
  const isoStart = (new Date(startTime - tzOffset)).toISOString().slice(0, 19).replace('T', ' ');
  const isoEnd = (new Date(now - tzOffset)).toISOString().slice(0, 19).replace('T', ' ');

  let summary = "";
  let suggestions = "";
  let finalTone = "Otomatik";

  const base = window.BACKEND_URL;

  if (fullTranscript.length > 20) {
    try {
      const anaRes = await fetch(`${base}/analyze_speech_quality`, {
        method: 'POST',
        headers: window.getHeaders(),
        body: JSON.stringify({ transcript: fullTranscript })
      });
      if (anaRes.ok) {
        const anaData = await anaRes.json();
        summary = anaData.summary || "";
        suggestions = anaData.suggestions || "";
        finalTone = anaData.tone || "Otomatik";
      }
    } catch(e) { console.error("Speech quality analyze failed", e); }
  }

  const postData = {
    date: new Date().toISOString().split('T')[0],
    startTime: isoStart,
    endTime: isoEnd,
    score: score,
    durationSec: durationSec,
    wpm: finalWpm,
    fillerCount: totalFillerCount,
    dominantEmotion: dominant,
    tone: finalTone,
    transcript: fullTranscript,
    summary: summary,
    suggestions: suggestions
  };

  try {
    await fetch(`${base}/api/presentations`, {
      method: 'POST',
      headers: window.getHeaders(),
      body: JSON.stringify(postData)
    });
  } catch (err) {
    console.error("Save error", err);
  }
  
  // Stop camera
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(track => track.stop());
  }
  
  window.location.href = "dashboard.html";
}

// Start sequence
endBtn.addEventListener('click', endPresentation);

startBtn.addEventListener('click', () => {
  startOverlay.classList.add('hidden'); // Hide the overlay
  
  initCamera().then(() => {
    startTime = new Date();
    timerInterval = setInterval(updateTimer, 1000);
    frameInterval = setInterval(sendFrameForAnalysis, 10000); // requested: every 10 seconds to save Gemini Quota
    aiInterval = setInterval(checkAiAssist, 15000); // 15 seconds
    
    if (recognition) {
      try {
        recognition.start();
      } catch (e) {
        console.error("Recognition start failed", e);
        statusText.innerText = "Mikrofon başlatılamadı. Lütfen izni kontrol edin.";
        statusText.classList.replace('text-slate-400', 'text-red-400');
      }
    }
  });
});
