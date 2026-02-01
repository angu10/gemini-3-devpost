
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Clip, AppState, AnalysisResponse, VirtualEdit, ChatMessage, PlayerMode, TranscriptSegment, ClipEdit, AppMode } from './types';
import { MAX_FILE_SIZE_MB, MODELS, DEFAULT_MODEL } from './constants';
import { analyzeVideo, processUserCommand, uploadVideo, generateStoryFromImages, generateTTS } from './services/geminiService';
import { getCachedAnalysis, saveAnalysisToCache } from './services/dbService';
import { Button } from './components/Button';
import { db } from './firebase';

// --- Helper: Decode Raw PCM from Gemini ---
const decodePCM = (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000 // Gemini TTS standard
): AudioBuffer => {
  const pcm16 = new Int16Array(data.buffer);
  const buffer = ctx.createBuffer(1, pcm16.length, sampleRate);
  const channelData = buffer.getChannelData(0);
  
  for (let i = 0; i < pcm16.length; i++) {
    channelData[i] = pcm16[i] / 32768.0;
  }
  return buffer;
};

export const App: React.FC = () => {
  // --- STATE ---
  const [appMode, setAppMode] = useState<AppMode>('LANDING');
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]); 
  const [hasPerformedFullAnalysis, setHasPerformedFullAnalysis] = useState(false);
  const [loadedFromCache, setLoadedFromCache] = useState(false); 
  
  // Image Story State
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [storyLoadingStep, setStoryLoadingStep] = useState<string>('');
  const [storyContext, setStoryContext] = useState('');

  // Model Selection
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);

  // Copilot / Chat State
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isProcessingChat, setIsProcessingChat] = useState(false);
  const [longProcessWarning, setLongProcessWarning] = useState(false);

  // Timeline / Reel State
  const [reel, setReel] = useState<Clip[]>([]);
  const [playerMode, setPlayerMode] = useState<PlayerMode>('FULL');
  const [reelCurrentIndex, setReelCurrentIndex] = useState(0);

  // Editor State
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false);
  const [isExportingSmart, setIsExportingSmart] = useState<boolean>(false);
  
  // Virtual Edits (Global & Clip Specific)
  const [virtualEdit, setVirtualEdit] = useState<VirtualEdit | null>(null);
  const [clipEdits, setClipEdits] = useState<Record<string, ClipEdit>>({}); 
  
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("Processing...");
  const [videoDuration, setVideoDuration] = useState<number>(0);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // --- EFFECTS ---

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory, longProcessWarning]);

  // --- HANDLERS ---

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (!selectedFile) return;

    if (selectedFile.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setErrorMsg(`File too large. Please upload a video smaller than ${MAX_FILE_SIZE_MB}MB.`);
      return;
    }

    if (!selectedFile.type.startsWith('video/')) {
      setErrorMsg("Please upload a valid video file.");
      return;
    }

    setFile(selectedFile);
    setVideoUrl(URL.createObjectURL(selectedFile));
    setFileUri(null);
    setAppState(AppState.CHECKING_DB);
    setErrorMsg(null);
    setAnalysisData(null);
    setTranscript([]);
    setHasPerformedFullAnalysis(false);
    setLoadedFromCache(false);
    resetChat();
    setReel([]);
    setVirtualEdit(null);
    setClipEdits({});

    try {
        const cached = await getCachedAnalysis(selectedFile);
        if (cached) {
            setAnalysisData(cached.analysis);
            setTranscript(cached.transcript || []);
            setHasPerformedFullAnalysis(true);
            setLoadedFromCache(true);
            setAppState(AppState.READY);
            setChatHistory(prev => [...prev, {
                id: `cache-welcome-${Date.now()}`,
                role: 'assistant',
                content: `Welcome back! I found previous analysis for "${selectedFile.name}". Clips and transcript are loaded instantly.`,
                timestamp: Date.now()
            }]);
        } else {
            setAppState(AppState.READY);
        }
    } catch (e) {
        console.warn("DB Check failed", e);
        setAppState(AppState.READY);
    }
  };

  const handleImageFilesChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      if (event.target.files && event.target.files.length > 0) {
          setImageFiles(Array.from(event.target.files));
      }
  };

  // --- STORY MODE LOGIC ---
  const handleCreateStory = async () => {
    if (imageFiles.length < 2) {
        alert("Please upload at least 2 images.");
        return;
    }
    setAppState(AppState.CREATING_STORY);
    setErrorMsg(null);

    try {
        // 1. Generate Script & Order
        setStoryLoadingStep("AI is directing the story...");
        const storyData = await generateStoryFromImages(imageFiles, storyContext);
        
        // 2. Generate Voiceover
        setStoryLoadingStep("AI is recording voiceover...");
        const audioBase64 = await generateTTS(storyData.script);

        // 3. Render Video
        setStoryLoadingStep("Rendering video...");
        await renderStoryToVideo(storyData, audioBase64);
        
    } catch (e: any) {
        console.error(e);
        setErrorMsg(e.message || "Failed to create story.");
    } finally {
        setAppState(AppState.IDLE);
        setStoryLoadingStep('');
    }
  };

  const renderStoryToVideo = async (story: any, audioBase64: string) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Canvas context failed");
      
      canvas.width = 1080; // Shorts/Reels Resolution
      canvas.height = 1920; 

      // Decode Audio (Raw PCM to Buffer)
      const audioCtx = new AudioContext();
      const binaryString = atob(audioBase64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); }
      
      const audioBuffer = decodePCM(bytes, audioCtx, 24000);

      // Setup Images
      const orderedImages: HTMLImageElement[] = [];
      const loadPromises = story.imageOrder.map((idx: number) => {
          return new Promise<void>((resolve) => {
              const img = new Image();
              img.onload = () => resolve();
              img.src = URL.createObjectURL(imageFiles[idx]);
              orderedImages.push(img);
          });
      });
      await Promise.all(loadPromises);

      // Render Setup
      const stream = canvas.captureStream(30);
      const dest = audioCtx.createMediaStreamDestination();
      const sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(dest);
      sourceNode.start();

      const audioTrack = dest.stream.getAudioTracks()[0];
      if (audioTrack) stream.addTrack(audioTrack);

      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
      const chunks: BlobPart[] = [];
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      
      const totalDuration = audioBuffer.duration;
      const slideDuration = totalDuration / orderedImages.length;
      const startTime = performance.now();

      mediaRecorder.start();

      return new Promise<void>((resolve) => {
          const draw = () => {
              const now = performance.now();
              const elapsed = (now - startTime) / 1000;
              
              if (elapsed >= totalDuration) {
                  mediaRecorder.stop();
                  return;
              }

              // Determine current slide
              const slideIndex = Math.min(Math.floor(elapsed / slideDuration), orderedImages.length - 1);
              const img = orderedImages[slideIndex];
              const slideProgress = (elapsed % slideDuration) / slideDuration; // 0 to 1

              // Ken Burns Effect (Simple Zoom/Pan)
              const scale = 1.0 + (slideProgress * 0.15); // Zoom in 15%
              
              ctx.fillStyle = 'black';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              
              // Draw Image Cover logic
              const imgRatio = img.width / img.height;
              const canvasRatio = canvas.width / canvas.height;
              let renderW, renderH, offsetX, offsetY;

              if (imgRatio > canvasRatio) {
                  renderH = canvas.height;
                  renderW = img.width * (canvas.height / img.height);
                  offsetX = (canvas.width - renderW) / 2;
                  offsetY = 0;
              } else {
                  renderW = canvas.width;
                  renderH = img.height * (canvas.width / img.width);
                  offsetX = 0;
                  offsetY = (canvas.height - renderH) / 2;
              }

              ctx.save();
              ctx.translate(canvas.width/2, canvas.height/2);
              ctx.scale(scale, scale);
              ctx.translate(-canvas.width/2, -canvas.height/2);
              ctx.drawImage(img, offsetX, offsetY, renderW, renderH);
              ctx.restore();
              
              requestAnimationFrame(draw);
          };

          mediaRecorder.onstop = () => {
              audioCtx.close();
              const blob = new Blob(chunks, { type: 'video/webm' });
              const url = URL.createObjectURL(blob);
              
              // Trigger Download
              const a = document.createElement('a');
              a.href = url;
              a.download = `story_${story.title.replace(/\s/g, '_')}.webm`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              resolve();
          };

          draw();
      });
  };

  const resetChat = () => {
    setChatHistory([{
      id: 'welcome',
      role: 'assistant',
      content: "Hi! I'm your Highlight Copilot. Upload your video, and I'll help you find the best moments. Try saying 'Find the funny parts' or 'Create a summary reel'.",
      timestamp: Date.now()
    }]);
    setChatInput('');
  };

  const ensureFileUploaded = async (currentFile: File): Promise<string> => {
    if (fileUri) return fileUri;
    setAppState(AppState.UPLOADING);
    const uri = await uploadVideo(currentFile, (msg) => setStatusMessage(msg));
    setFileUri(uri);
    return uri;
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setErrorMsg(null);
    setChatHistory(prev => [...prev, { id: `user-auto-${Date.now()}`, role: 'user', content: "Auto-find best moments", timestamp: Date.now() }]);

    if (loadedFromCache) {
        setChatHistory(prev => [...prev, { id: `cache-msg-${Date.now()}`, role: 'assistant', content: "I already have the data! Check the sidebar.", timestamp: Date.now() }]);
        return;
    }

    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.ANALYZING);
      setStatusMessage("Analzying: Transcript (Pass 1) & Visuals (Pass 2)...");
      
      const { analysis, transcript: newTranscript } = await analyzeVideo(uri, file.type, selectedModel);
      
      setAnalysisData(prev => {
        const existingClips = prev?.clips || [];
        const newClips = analysis.clips.filter(nc => 
            !existingClips.some(ec => ec.id === nc.id || Math.abs(ec.startTime - nc.startTime) < 1)
        );
        return { overallSummary: analysis.overallSummary || prev?.overallSummary || '', clips: [...existingClips, ...newClips] };
      });

      setTranscript(newTranscript);
      setHasPerformedFullAnalysis(true);
      setAppState(AppState.READY);
      saveAnalysisToCache(file, analysis, newTranscript, selectedModel);
      setChatHistory(prev => [...prev, { id: `analysis-${Date.now()}`, role: 'assistant', content: `Analysis complete! Found ${analysis.clips.length} clips.`, timestamp: Date.now() }]);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to analyze video.");
      setAppState(AppState.ERROR);
    }
  };
  
  const triggerQuickAction = (msg: string) => {
      if (msg === "Auto-find best moments" && !hasPerformedFullAnalysis && !loadedFromCache) {
          handleAnalyze();
          return;
      }
      handleSendMessage(null, msg);
  };

  const handleSendMessage = async (e: React.FormEvent | null, textOverride?: string) => {
    if (e) e.preventDefault();
    const text = textOverride || chatInput;
    if (!file || !text.trim() || isProcessingChat) return;

    const userMsg: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content: text, timestamp: Date.now() };
    setChatHistory(prev => [...prev, userMsg]);
    setChatInput('');
    setIsProcessingChat(true);
    setLongProcessWarning(false);

    const timer = setTimeout(() => { setLongProcessWarning(true); }, 8000);

    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.READY); 
      const activeClip = activeClipId && analysisData ? analysisData.clips.find(c => c.id === activeClipId) : null;
      const result = await processUserCommand(uri, file.type, userMsg.content, analysisData?.clips || [], selectedModel, transcript, activeClip);

      const aiMsg: ChatMessage = { id: `ai-${Date.now()}`, role: 'assistant', content: result.message, timestamp: Date.now() };
      setChatHistory(prev => [...prev, aiMsg]);

      // --- HANDLE ACTIONS ---

      if (result.intent === 'CLIP_EDIT' && result.data && activeClipId) {
         // 1. Handle Visual/Text Edits
         setClipEdits(prev => ({ 
             ...prev, 
             [activeClipId]: { 
                 id: activeClipId, 
                 filterStyle: result.data.filterStyle || prev[activeClipId]?.filterStyle, 
                 subtitles: result.data.subtitles || prev[activeClipId]?.subtitles, 
                 overlay: result.data.overlay || prev[activeClipId]?.overlay 
             } 
         }));

         // 2. Handle Timestamp Edits (Trimming/Extending)
         if (result.data.startTime !== undefined || result.data.endTime !== undefined) {
             setAnalysisData(prev => {
                 if (!prev) return null;
                 const updatedClips = prev.clips.map(c => {
                     if (c.id === activeClipId) {
                         return {
                             ...c,
                             startTime: result.data.startTime !== undefined ? result.data.startTime : c.startTime,
                             endTime: result.data.endTime !== undefined ? result.data.endTime : c.endTime
                         };
                     }
                     return c;
                 });
                 return { ...prev, clips: updatedClips };
             });
             
             // Seek to new start time immediately to show user the change
             if (result.data.startTime !== undefined && videoRef.current) {
                 videoRef.current.currentTime = result.data.startTime;
                 videoRef.current.play();
             }
         }
      }
      else if (result.intent === 'REEL_ADD' && result.data) {
        let clipsToAdd: Clip[] = [];
        if (result.data.all) clipsToAdd = analysisData?.clips || [];
        else if (result.data.clips && Array.isArray(result.data.clips)) clipsToAdd = result.data.clips.map((c: any) => ({ ...c, id: c.id || `gen-${Date.now()}`, startTime: c.startTime || 0, endTime: c.endTime || 0, category: c.category || 'Custom' }));
        else if (result.data.startTime !== undefined) clipsToAdd = [{ ...result.data, startTime: result.data.startTime || 0, endTime: result.data.endTime || 0 } as Clip];

        if (clipsToAdd.length > 0) {
            setReel(prev => [...prev, ...clipsToAdd]);
            if (!result.data.all) {
                setAnalysisData(prev => {
                   const currentClips = prev?.clips || [];
                   const newUnique = clipsToAdd.filter(nc => !currentClips.some(oc => oc.id === nc.id));
                   return newUnique.length === 0 ? prev : { overallSummary: prev?.overallSummary || '', clips: [...newUnique, ...currentClips] };
                });
            }
            playClip(clipsToAdd[0]);
        }
      } else if (result.intent === 'REEL_REMOVE') {
        const idx = result.data.index;
        setReel(prev => {
           if (idx === -1) return prev.slice(0, -1); 
           if (idx !== undefined && idx >= 0 && idx < prev.length) { const n = [...prev]; n.splice(idx, 1); return n; }
           return prev;
        });
      } else if (result.intent === 'REEL_CLEAR') setReel([]);
      else if (result.intent === 'EDIT' && result.data) {
        setVirtualEdit({ isActive: true, description: result.data.description, keepSegments: result.data.keepSegments || [{ start: 0, end: 100 }], filterStyle: result.data.filterStyle, transitionEffect: result.data.transitionEffect });
      } else if (result.intent === 'SEARCH' && result.data) {
         const clip = result.data as Clip;
         if (clip.startTime === -1) {
            setChatHistory(prev => [...prev, { id: `warn-${Date.now()}`, role: 'assistant', content: "Found topic but couldn't timestamp it.", timestamp: Date.now() }]);
            return;
         }
         if (!clip.id) clip.id = `search-${Date.now()}`;
         setAnalysisData(prev => ({ overallSummary: prev?.overallSummary || 'Search Results', clips: [clip, ...(prev?.clips || [])] }));
         playClip(clip);
      }
    } catch (err) {
      console.error(err);
      setChatHistory(prev => [...prev, { id: `err-${Date.now()}`, role: 'assistant', content: "Sorry, I had trouble processing that request.", timestamp: Date.now() }]);
    } finally {
      clearTimeout(timer);
      setIsProcessingChat(false);
      setLongProcessWarning(false);
      if (appState === AppState.UPLOADING) setAppState(AppState.READY);
    }
  };

  const playClip = (clip: Clip) => {
    if (!videoRef.current) return;
    setPlayerMode('SINGLE');
    setActiveClipId(clip.id);
    let start = clip.startTime || 0;
    videoRef.current.currentTime = start;
    videoRef.current.play();
  };

  const playReel = () => {
    if (reel.length === 0 || !videoRef.current) return;
    setPlayerMode('REEL');
    setReelCurrentIndex(0);
    videoRef.current.currentTime = reel[0].startTime || 0;
    videoRef.current.play();
    setVirtualEdit(null);
  };

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    const currentTime = videoRef.current.currentTime;

    if (playerMode === 'REEL' && reel.length > 0) {
      const currentClip = reel[reelCurrentIndex];
      const end = currentClip.endTime || 0;
      const start = currentClip.startTime || 0;
      
      if (currentTime >= (end > start ? end : start + 5)) {
        const nextIndex = reelCurrentIndex + 1;
        if (nextIndex < reel.length) {
           triggerTransition();
           setReelCurrentIndex(nextIndex);
           videoRef.current.currentTime = reel[nextIndex].startTime || 0;
           videoRef.current.play();
        } else {
           videoRef.current.pause();
           setPlayerMode('FULL');
        }
      }
      return;
    }

    if (playerMode === 'SINGLE' && activeClipId && analysisData) {
      const currentClip = analysisData.clips.find(c => c.id === activeClipId);
      if (currentClip) {
         const start = currentClip.startTime || 0;
         const end = currentClip.endTime || 0;
         if (currentTime >= (end > start ? end : start + 10)) {
            videoRef.current.currentTime = start;
            videoRef.current.play();
         }
      }
    }

    if (playerMode === 'FULL' && virtualEdit?.isActive && virtualEdit.keepSegments.length > 0) {
      const inValid = virtualEdit.keepSegments.some(s => currentTime >= s.start && currentTime < s.end);
      if (!inValid) {
        const next = virtualEdit.keepSegments.find(s => s.start > currentTime);
        if (next) videoRef.current.currentTime = next.start;
        else if (currentTime < videoRef.current.duration - 0.5) videoRef.current.pause();
      }
    }
  }, [playerMode, reel, reelCurrentIndex, activeClipId, analysisData, virtualEdit]);

  const triggerTransition = () => { setIsTransitioning(true); setTimeout(() => setIsTransitioning(false), 500); };

  const handleDownloadClip = async (e: React.MouseEvent, clip: Clip) => {
    e.stopPropagation();
    if (!videoUrl || isExportingSmart || downloadingClipId) return;
    setDownloadingClipId(clip.id);
    try { await processAndDownload([clip], `clip_${clip.title.replace(/\s+/g, '_')}.webm`); } 
    catch (error) { console.error("Download failed:", error); alert("Download failed."); } 
    finally { setDownloadingClipId(null); }
  };
  
  const handleDownloadAllClips = async () => {
      if(!analysisData?.clips || isExportingSmart || !videoUrl) return;
      setIsExportingSmart(true);
      try {
          let count = 0;
          for (const clip of analysisData.clips) {
              setDownloadingClipId(clip.id); 
              try { await processAndDownload([clip], `clip_${clip.title.replace(/\s+/g, '_')}.webm`); count++; await new Promise(r => setTimeout(r, 800)); } 
              catch (e) { console.error(e); }
          }
          alert(`Downloaded ${count} clips.`);
      } catch (e) { console.error(e); } finally { setIsExportingSmart(false); setDownloadingClipId(null); }
  };

  const handleExportReel = async (clipsOverride?: Clip[]) => {
    const clipsToExport = clipsOverride || reel;
    if (clipsToExport.length === 0 || !videoUrl || isExportingSmart) return;
    setIsExportingSmart(true);
    try { await processAndDownload(clipsToExport, `compilation_${Date.now()}.webm`); } 
    catch (error) { console.error(error); alert("Export failed."); } finally { setIsExportingSmart(false); }
  };

  const processAndDownload = async (clipsToProcess: Clip[], filename: string) => {
    const workerVideo = document.createElement('video');
    workerVideo.style.display = 'none';
    workerVideo.crossOrigin = 'anonymous';
    workerVideo.src = videoUrl || '';
    workerVideo.muted = false; 
    document.body.appendChild(workerVideo);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) { document.body.removeChild(workerVideo); throw new Error("Canvas failed"); }

    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject("Timeout"), 5000);
        workerVideo.onloadedmetadata = () => { clearTimeout(t); resolve(); };
        workerVideo.onerror = () => { clearTimeout(t); reject("Load error"); };
    });

    canvas.width = workerVideo.videoWidth;
    canvas.height = workerVideo.videoHeight;
    const stream = canvas.captureStream(30); 
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(workerVideo);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    if (dest.stream.getAudioTracks().length > 0) stream.addTrack(dest.stream.getAudioTracks()[0]);

    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
    const chunks: BlobPart[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    let animationFrameId: number;
    const draw = () => {
      const currentTime = workerVideo.currentTime;
      const activeClip = clipsToProcess.find(c => currentTime >= c.startTime && currentTime <= (c.endTime + 0.5));
      let filter = 'none';
      if (activeClip && clipEdits[activeClip.id]?.filterStyle) filter = clipEdits[activeClip.id].filterStyle!;
      else if (virtualEdit?.filterStyle) filter = virtualEdit.filterStyle;
      ctx.filter = filter;
      ctx.drawImage(workerVideo, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none'; 

      if (activeClip && clipEdits[activeClip.id]) {
          const edit = clipEdits[activeClip.id];
          if (edit.subtitles) {
              const fontSize = Math.max(24, Math.floor(canvas.height * 0.04));
              ctx.font = `bold ${fontSize}px Inter, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              const text = edit.subtitles;
              const maxWidth = canvas.width * 0.8;
              const x = canvas.width / 2;
              const y = canvas.height - (canvas.height * 0.1);
              const words = text.split(' ');
              let line = ''; const lines = [];
              for (let n = 0; n < words.length; n++) {
                  const testLine = line + words[n] + ' ';
                  if (ctx.measureText(testLine).width > maxWidth && n > 0) { lines.push(line); line = words[n] + ' '; } else { line = testLine; }
              }
              lines.push(line);
              const lineHeight = fontSize * 1.4;
              const totalHeight = lines.length * lineHeight;
              const startY = y - totalHeight + lineHeight; 
              let maxLineWidth = 0;
              lines.forEach(l => maxLineWidth = Math.max(maxLineWidth, ctx.measureText(l).width));
              ctx.fillStyle = 'rgba(0,0,0,0.6)';
              const padding = fontSize * 0.5;
              ctx.fillRect(x - maxLineWidth/2 - padding, startY - lineHeight, maxLineWidth + padding*2, totalHeight + padding/2);
              ctx.fillStyle = 'white';
              lines.forEach((l, i) => { ctx.fillText(l, x, startY + (i * lineHeight) - lineHeight/3); });
          }
          if (edit.overlay) {
             const { content, type, position } = edit.overlay;
             let x = canvas.width / 2; let y = canvas.height / 2;
             if (position === 'TOP') y = canvas.height * 0.15;
             if (position === 'BOTTOM') y = canvas.height * 0.85;
             ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
             if (type === 'EMOJI') { ctx.font = `${Math.floor(canvas.height * 0.2)}px serif`; ctx.fillText(content, x, y); } 
             else if (type === 'TEXT') {
                 ctx.save(); ctx.translate(x, y); ctx.rotate(-6 * Math.PI / 180);
                 const fontSize = Math.floor(canvas.height * 0.08);
                 ctx.font = `900 ${fontSize}px Inter, sans-serif`;
                 const w = ctx.measureText(content).width; const p = fontSize * 0.4;
                 ctx.fillStyle = '#dc2626'; ctx.fillRect(-w/2 - p, -fontSize/2 - p, w + p*2, fontSize + p*1.5);
                 ctx.fillStyle = 'white'; ctx.fillText(content, 0, 0); ctx.restore();
             }
          }
      }
      animationFrameId = requestAnimationFrame(draw);
    };

    return new Promise<void>(async (resolve) => {
      mediaRecorder.onstop = () => {
        cancelAnimationFrame(animationFrameId);
        audioCtx.close();
        if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        }
        if (document.body.contains(workerVideo)) document.body.removeChild(workerVideo);
        resolve();
      };
      mediaRecorder.start();
      draw();
      try {
        for (const clip of clipsToProcess) {
          let start = clip.startTime || 0; let end = clip.endTime || 0;
          if (end <= start) end = start + 5;
          workerVideo.currentTime = start;
          await new Promise<void>(r => { 
             const t = setTimeout(() => r(), 2000); 
             const fn = () => { clearTimeout(t); workerVideo.removeEventListener('seeked', fn); r(); }; 
             workerVideo.addEventListener('seeked', fn); 
          });
          await workerVideo.play();
          await new Promise<void>(r => {
            const check = () => {
              if (workerVideo.currentTime >= end || workerVideo.paused || workerVideo.ended) { workerVideo.pause(); r(); } 
              else { requestAnimationFrame(check); }
            };
            check();
          });
        }
        mediaRecorder.stop();
      } catch (e) { mediaRecorder.stop(); if (document.body.contains(workerVideo)) document.body.removeChild(workerVideo); resolve(); }
    });
  };

  const reset = () => {
    setFile(null); setVideoUrl(null); setFileUri(null); setAnalysisData(null); setTranscript([]);
    setHasPerformedFullAnalysis(false); setLoadedFromCache(false); setAppState(AppState.IDLE);
    setActiveClipId(null); setChatHistory([]); setReel([]); setPlayerMode('FULL'); setVirtualEdit(null); setClipEdits({});
    if (fileInputRef.current) fileInputRef.current.value = '';
    setImageFiles([]); // Reset images
    setStoryContext('');
  };

  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => setVideoDuration(e.currentTarget.duration);
  const currentClipEdit = playerMode === 'SINGLE' && activeClipId ? clipEdits[activeClipId] : null;
  const currentFilter = currentClipEdit?.filterStyle || virtualEdit?.filterStyle || 'none';

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-slate-50 flex flex-col relative overflow-hidden">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-950/40 via-purple-950/40 to-pink-950/40" />
        <div className="absolute top-20 right-20 w-96 h-96 bg-blue-500/20 rounded-full blur-[100px] animate-pulse" />
      </div>

      <div className="relative z-10 flex flex-col flex-1 w-full h-screen">
        <video ref={processingVideoRef} className="fixed top-0 left-0 w-1 h-1 pointer-events-none opacity-0" muted crossOrigin="anonymous"/>

        <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 h-16 flex-none z-50">
          <div className="max-w-full mx-auto px-6 h-full flex items-center justify-between">
            <div className="flex items-center gap-4">
               <h1 onClick={() => setAppMode('LANDING')} className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400 cursor-pointer hover:opacity-80 transition-opacity">SmartClip.ai</h1>
            </div>
            
            {appMode !== 'LANDING' && (
                <div className="flex items-center gap-4">
                    <div className="flex bg-slate-800 rounded-lg p-1 border border-slate-700">
                        <button 
                        onClick={() => setAppMode('VIDEO_ANALYSIS')} 
                        className={`px-3 py-1 text-xs rounded-md transition-all ${appMode === 'VIDEO_ANALYSIS' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                        Video Copilot
                        </button>
                        <button 
                        onClick={() => setAppMode('IMAGE_STORY')} 
                        className={`px-3 py-1 text-xs rounded-md transition-all ${appMode === 'IMAGE_STORY' ? 'bg-pink-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                        >
                        AI Slideshow
                        </button>
                    </div>
                    {db ? (
                        <span className="text-xs text-green-400 flex items-center gap-1 border border-green-900/50 bg-green-900/10 px-2 py-0.5 rounded">
                            <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse shadow-green-500/50 shadow-sm"></span>
                            Cloud Sync
                        </span>
                    ) : (
                         <span className="text-xs text-slate-500 flex items-center gap-1 border border-slate-800 bg-slate-900/50 px-2 py-0.5 rounded" title="Configure firebase.ts to enable persistence">
                            <span className="w-1.5 h-1.5 bg-slate-600 rounded-full"></span>
                            Local Mode
                        </span>
                    )}
                    {loadedFromCache && <span className="text-xs text-blue-400 bg-blue-900/30 px-2 py-1 rounded border border-blue-800">⚡ Cached</span>}
                    {(file || imageFiles.length > 0) && <Button variant="secondary" onClick={reset} className="text-sm py-1">New Project</Button>}
                </div>
            )}
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          
          {appMode === 'LANDING' ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 w-full max-w-7xl mx-auto animate-in fade-in zoom-in duration-500">
                  <div className="text-center mb-16">
                      <h2 className="text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-300 via-indigo-300 to-purple-300 mb-6 tracking-tight">Creative AI Studio</h2>
                      <p className="text-xl text-slate-400">Choose your workflow to start creating.</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full max-w-4xl">
                      {/* OPTION 1: VIDEO */}
                      <div onClick={() => setAppMode('VIDEO_ANALYSIS')} className="group relative bg-slate-900/50 hover:bg-slate-800/80 border border-slate-700 hover:border-blue-500/50 rounded-3xl p-8 cursor-pointer transition-all duration-300 hover:transform hover:scale-[1.02] hover:shadow-2xl hover:shadow-blue-900/20">
                           <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                               <svg className="w-32 h-32 text-blue-500" fill="currentColor" viewBox="0 0 24 24"><path d="M4 4h10l6 6v10H4V4zm2 2v14h12v-9h-5V6H6z"/></svg>
                           </div>
                           <div className="w-16 h-16 bg-blue-600/20 rounded-2xl flex items-center justify-center mb-6 text-3xl shadow-inner ring-1 ring-blue-500/30 group-hover:bg-blue-600 group-hover:text-white transition-all">🎬</div>
                           <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-blue-300 transition-colors">Video Copilot</h3>
                           <p className="text-slate-400 mb-8 leading-relaxed">Turn long-form videos into viral shorts. Includes automatic transcript analysis, clip extraction, and smart editing.</p>
                           <span className="inline-flex items-center text-blue-400 font-semibold group-hover:translate-x-2 transition-transform">Start Editing <svg className="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></span>
                      </div>

                      {/* OPTION 2: IMAGE */}
                      <div onClick={() => setAppMode('IMAGE_STORY')} className="group relative bg-slate-900/50 hover:bg-slate-800/80 border border-slate-700 hover:border-pink-500/50 rounded-3xl p-8 cursor-pointer transition-all duration-300 hover:transform hover:scale-[1.02] hover:shadow-2xl hover:shadow-pink-900/20">
                           <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                               <svg className="w-32 h-32 text-pink-500" fill="currentColor" viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
                           </div>
                           <div className="w-16 h-16 bg-pink-600/20 rounded-2xl flex items-center justify-center mb-6 text-3xl shadow-inner ring-1 ring-pink-500/30 group-hover:bg-pink-600 group-hover:text-white transition-all">📸</div>
                           <h3 className="text-2xl font-bold text-white mb-3 group-hover:text-pink-300 transition-colors">AI Slideshow</h3>
                           <p className="text-slate-400 mb-8 leading-relaxed">Transform photo collections into narrated, documentary-style stories. AI writes the script and generates the voiceover.</p>
                           <span className="inline-flex items-center text-pink-400 font-semibold group-hover:translate-x-2 transition-transform">Create Story <svg className="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" /></svg></span>
                      </div>
                  </div>
              </div>
          ) : (
            <div className={`flex-1 flex flex-col p-6 overflow-y-auto ${(appMode === 'VIDEO_ANALYSIS' && !file) || (appMode === 'IMAGE_STORY' && imageFiles.length === 0) ? 'items-center justify-center' : ''}`}>
             
             {/* MODE: IMAGE STORY */}
             {appMode === 'IMAGE_STORY' && (
                 imageFiles.length === 0 ? (
                     <div className="text-center animate-in fade-in zoom-in duration-500">
                        <h2 className="text-4xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-pink-400 to-purple-400">Turn Photos into Viral Stories</h2>
                        <p className="text-slate-400 mb-8 max-w-lg mx-auto">Upload 3-10 photos. AI will analyze them, write a script, generate a voiceover, and edit a video for you.</p>
                        <div className="p-12 border-2 border-dashed border-slate-700 rounded-2xl bg-slate-900/50 hover:bg-slate-800/50 transition-all cursor-pointer" onClick={() => imageInputRef.current?.click()}>
                           <div className="text-6xl mb-4">📸</div>
                           <Button className="mx-auto">Select Photos</Button>
                           <input type="file" multiple accept="image/*" ref={imageInputRef} className="hidden" onChange={handleImageFilesChange} />
                        </div>
                     </div>
                 ) : (
                     <div className="w-full max-w-4xl mx-auto flex flex-col h-full">
                         {appState === AppState.CREATING_STORY ? (
                             <div className="flex-1 flex flex-col items-center justify-center text-center">
                                 <div className="w-24 h-24 border-4 border-pink-500 border-t-transparent rounded-full animate-spin mb-8"></div>
                                 <h2 className="text-2xl font-bold text-white mb-2">{storyLoadingStep}</h2>
                                 <p className="text-slate-400">This usually takes about 20-30 seconds.</p>
                             </div>
                         ) : (
                             <div className="flex flex-col h-full">
                                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                                     {imageFiles.map((f, i) => (
                                         <div key={i} className="relative aspect-[9/16] bg-slate-800 rounded-lg overflow-hidden border border-slate-700">
                                             <img src={URL.createObjectURL(f)} className="w-full h-full object-cover" alt="" />
                                             <span className="absolute top-2 left-2 bg-black/60 text-white px-2 py-1 rounded text-xs">{i + 1}</span>
                                         </div>
                                     ))}
                                     <div className="aspect-[9/16] flex items-center justify-center bg-slate-800/50 rounded-lg border border-dashed border-slate-600 cursor-pointer hover:bg-slate-700/50" onClick={() => imageInputRef.current?.click()}>
                                         <span className="text-2xl">+</span>
                                     </div>
                                 </div>
                                 
                                 {/* NEW CONTEXT INPUT */}
                                 <div className="mb-8 max-w-2xl mx-auto w-full">
                                     <label className="block text-sm font-medium text-slate-400 mb-2">
                                         Story Context (Optional)
                                     </label>
                                     <textarea
                                         value={storyContext}
                                         onChange={(e) => setStoryContext(e.target.value)}
                                         placeholder="e.g., This was our trip to Japan in 2023. We got lost in Tokyo but found amazing sushi. The tone should be nostalgic and fun."
                                         className="w-full bg-slate-800 border border-slate-700 rounded-xl p-4 text-slate-200 focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-all placeholder:text-slate-600 h-24 resize-none"
                                     />
                                 </div>

                                 <div className="flex justify-center">
                                    <Button onClick={handleCreateStory} className="px-8 py-4 text-lg bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 shadow-lg shadow-pink-500/30">
                                        🎬 Create AI Story Video
                                    </Button>
                                 </div>
                             </div>
                         )}
                     </div>
                 )
             )}

             {/* MODE: VIDEO ANALYSIS (Existing Logic) */}
             {appMode === 'VIDEO_ANALYSIS' && (
                 !file ? (
                   /* ... Upload UI ... */
                   <div className="w-full max-w-6xl mx-auto flex flex-col items-center justify-center py-8">
                     <div className="text-center mb-12 animate-in fade-in slide-in-from-bottom-8 duration-700">
                       <h1 className="text-5xl md:text-7xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-400 mb-6 tracking-tight">
                         Talk to your video.
                       </h1>
                       <p className="text-xl text-slate-400 max-w-2xl mx-auto leading-relaxed">
                         Upload any long-form video. Chat with Copilot to finding viral moments instantly.
                       </p>
                     </div>
                     <div className="w-full max-w-3xl mb-16 relative group animate-in fade-in zoom-in duration-700 delay-150">
                        <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl blur opacity-25 group-hover:opacity-50 transition duration-1000"></div>
                        <div className="relative w-full flex flex-col items-center justify-center border-2 border-dashed border-slate-700 rounded-2xl bg-slate-900/90 hover:bg-slate-800/90 transition-colors p-12">
                          <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mb-6 shadow-inner ring-1 ring-slate-700">
                            <svg className="w-10 h-10 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                            </svg>
                          </div>
                          <h2 className="text-2xl font-semibold mb-2 text-white">Upload your video</h2>
                          <p className="text-slate-400 mb-8 max-w-md text-center">Drag & drop or select a video (max {MAX_FILE_SIZE_MB}MB).</p>
                          <input type="file" accept="video/*" className="hidden" ref={fileInputRef} onChange={handleFileChange}/>
                          <Button onClick={() => fileInputRef.current?.click()} className="px-8 py-3 text-lg shadow-blue-500/20 w-48">Select Video</Button>
                        </div>
                     </div>
                   </div>
                 ) : (
                   /* ... Video Player UI ... */
                   <div className="w-full max-w-5xl mx-auto flex flex-col h-full">
                     <div className="relative bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-slate-800 flex-1 min-h-[400px]">
                        <video 
                          ref={videoRef} 
                          src={videoUrl || ''} 
                          className="w-full h-full object-contain" 
                          style={{ filter: currentFilter }}
                          controls 
                          onLoadedMetadata={onLoadedMetadata}
                          onTimeUpdate={handleTimeUpdate}
                        />
                        {/* Overlays/Subtitles Rendering (Same as before) */}
                        <div className="absolute inset-0 pointer-events-none overflow-hidden">
                           {currentClipEdit?.subtitles && (
                             <div className="absolute bottom-16 left-0 right-0 flex justify-center">
                                <div className="bg-black/60 text-white px-4 py-2 rounded-lg text-lg font-bold backdrop-blur-sm max-w-[80%] text-center">{currentClipEdit.subtitles}</div>
                             </div>
                           )}
                           {currentClipEdit?.overlay && (
                              <div className={`absolute p-4 animate-in zoom-in duration-300 ${currentClipEdit.overlay.position === 'CENTER' ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2' : ''} ${currentClipEdit.overlay.position === 'TOP' ? 'top-8 left-1/2 -translate-x-1/2' : ''}`}>
                                 {currentClipEdit.overlay.type === 'EMOJI' && <span className="text-8xl drop-shadow-lg">{currentClipEdit.overlay.content}</span>}
                                 {currentClipEdit.overlay.type === 'TEXT' && <span className="text-4xl font-black text-white bg-red-600 px-4 py-2 uppercase -rotate-6 shadow-xl border-4 border-white">{currentClipEdit.overlay.content}</span>}
                              </div>
                           )}
                        </div>
                        {/* Loading States */}
                        {(appState === AppState.ANALYZING || appState === AppState.UPLOADING || appState === AppState.CHECKING_DB) && (
                          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-10 flex-col">
                            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                            <p className="font-semibold">{statusMessage}</p>
                          </div>
                        )}
                     </div>

                     {/* Available Clips / Quick Actions */}
                     {analysisData ? (
                       <div className="mt-4 p-4 bg-slate-900/50 rounded-xl border border-slate-800">
                          <div className="flex items-center justify-between mb-2">
                             <div className="flex items-center gap-3">
                                <h3 className="text-xs font-bold uppercase text-slate-500 tracking-wider">Discovered Moments</h3>
                                <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">{analysisData.clips.length} found</span>
                             </div>
                             <div className="flex gap-2">
                               <button onClick={handleDownloadAllClips} disabled={isExportingSmart} className="text-xs font-bold bg-slate-800 text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded hover:bg-slate-700 flex items-center gap-2">
                                  {isExportingSmart ? "Processing..." : "Download All"}
                               </button>
                               <button onClick={() => handleExportReel(analysisData.clips)} disabled={isExportingSmart} className="text-xs font-bold bg-purple-900/40 text-purple-300 border border-purple-500/30 px-3 py-1.5 rounded hover:bg-purple-800/60 flex items-center gap-2">
                                  {isExportingSmart ? "Processing..." : "Compilation Reel"}
                               </button>
                             </div>
                          </div>
                          <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                             {analysisData.clips.map(clip => (
                               <div key={clip.id} onClick={() => playClip(clip)} className={`group relative flex-none w-48 p-2 rounded-lg cursor-pointer transition-all border ${activeClipId === clip.id ? 'bg-blue-900/20 border-blue-500 shadow-md ring-1 ring-blue-500/30' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}>
                                  <p className={`text-sm font-medium truncate ${activeClipId === clip.id ? 'text-blue-200' : ''}`}>{clip.title}</p>
                                  <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                                    <span>{Math.round(clip.endTime - clip.startTime)}s</span>
                                    {clipEdits[clip.id] && <span className="text-purple-400 font-bold">✨ EDITED</span>}
                                  </div>
                                  <button onClick={(e) => handleDownloadClip(e, clip)} disabled={downloadingClipId === clip.id} className={`absolute top-2 right-2 p-1.5 rounded-full bg-slate-900/80 hover:bg-blue-600 text-white shadow-md transition-all ${downloadingClipId === clip.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                    {downloadingClipId === clip.id ? <div className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin"></div> : <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>}
                                  </button>
                               </div>
                             ))}
                          </div>
                       </div>
                     ) : (
                        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4 animate-in fade-in slide-in-from-bottom-4">
                          <button onClick={handleAnalyze} disabled={appState === AppState.ANALYZING} className="bg-gradient-to-br from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 p-4 rounded-xl text-left transition-all shadow-lg shadow-blue-900/20 group border border-blue-500/20">
                             <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">✨</div>
                             <div className="font-bold text-white text-sm">Auto-Find Clips</div>
                             <div className="text-blue-200 text-xs mt-1">Extract best moments</div>
                          </button>
                          <button onClick={() => triggerQuickAction("Find the funniest parts")} className="bg-slate-800 hover:bg-slate-750 border border-slate-700 p-4 rounded-xl text-left transition-all group">
                             <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">😂</div>
                             <div className="font-bold text-slate-200 text-sm">Find Humor</div>
                          </button>
                          <button onClick={() => triggerQuickAction("Create a summary of the main points")} className="bg-slate-800 hover:bg-slate-750 border border-slate-700 p-4 rounded-xl text-left transition-all group">
                             <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">📝</div>
                             <div className="font-bold text-slate-200 text-sm">Summarize</div>
                          </button>
                          <button onClick={() => triggerQuickAction("Find actionable advice")} className="bg-slate-800 hover:bg-slate-750 border border-slate-700 p-4 rounded-xl text-left transition-all group">
                             <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">💡</div>
                             <div className="font-bold text-slate-200 text-sm">Find Insights</div>
                          </button>
                       </div>
                     )}
                   </div>
                 )
             )}
          </div>
          )}

          {/* Chat Interface (Visible in Video Mode Only) */}
          {appMode === 'VIDEO_ANALYSIS' && file && (
            <div className="w-96 bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl z-20">
              <div className="p-4 border-b border-slate-800 bg-slate-900/95 backdrop-blur z-10 flex items-center justify-between">
                <div><h2 className="font-bold text-slate-200">Highlight Copilot</h2><p className="text-xs text-slate-500">{transcript.length > 0 ? "Transcript Aware" : "Analyzing..."}</p></div>
                <button onClick={resetChat} className="p-2 hover:bg-slate-800 rounded-lg text-slate-500"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {chatHistory.map(msg => (<div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'}`}>{msg.content}</div></div>))}
                {isProcessingChat && (<div className="flex justify-start"><div className="bg-slate-800 rounded-2xl px-4 py-3 rounded-bl-none border border-slate-700"><div className="flex gap-1.5 items-center"><div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce"></div><div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div><div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div></div></div></div>)}
                <div ref={chatEndRef} />
              </div>
              <div className="p-4 border-t border-slate-800 bg-slate-900">
                <form onSubmit={(e) => handleSendMessage(e)} className="relative">
                  <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Type a command..." className="w-full bg-slate-950 border border-slate-700 rounded-full pl-4 pr-12 py-3 text-sm focus:outline-none focus:border-blue-500 transition-colors focus:bg-slate-900"/>
                  <button type="submit" disabled={!chatInput.trim() || isProcessingChat} className="absolute right-2 top-2 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-500 disabled:opacity-50"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg></button>
                </form>
                <div className="flex gap-2 mt-3 overflow-x-auto pb-1 custom-scrollbar">
                  {activeClipId ? (
                    <>
                      <button onClick={() => handleSendMessage(null, "Add English subtitles")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">📝 Subtitles</button>
                      <button onClick={() => handleSendMessage(null, "Make it look vintage")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">🎞️ Vintage Filter</button>
                      <button onClick={() => handleSendMessage(null, "Add a 🔥 emoji in the corner")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">🔥 Add Emoji</button>
                      <button onClick={() => handleSendMessage(null, "Translate to Spanish")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">🇪🇸 Translate</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => handleSendMessage(null, "Find funny moments")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">😂 Funny</button>
                      <button onClick={() => handleSendMessage(null, "Create a 30s summary reel")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">🎬 Summary Reel</button>
                      <button onClick={() => handleSendMessage(null, "Find actionable advice")} className="whitespace-nowrap px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full text-xs text-slate-300 transition-colors">💡 Insights</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        
        {/* Timeline Reel (Video Mode Only) */}
        {appMode === 'VIDEO_ANALYSIS' && file && reel.length > 0 && (
          <div className="h-48 bg-slate-950 border-t border-slate-800 flex flex-col shadow-[0_-5px_20px_rgba(0,0,0,0.5)] z-40 animate-in slide-in-from-bottom duration-500">
             <div className="h-10 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between">
                <div className="flex items-center gap-2"><span className="text-xs font-bold uppercase tracking-wider text-blue-400">Timeline Reel</span><span className="bg-slate-800 text-slate-400 text-[10px] px-2 py-0.5 rounded-full">{reel.length} clips</span></div>
                <div className="flex items-center gap-3"><button onClick={playReel} className="flex items-center gap-2 text-xs font-bold bg-white text-slate-900 px-3 py-1.5 rounded hover:bg-blue-50 transition-colors">Play Reel</button><button onClick={() => handleExportReel()} disabled={isExportingSmart} className="flex items-center gap-2 text-xs font-bold bg-slate-800 text-slate-300 px-3 py-1.5 rounded hover:bg-slate-700 border border-slate-700">{isExportingSmart ? "Wait..." : "Export"}</button><button onClick={() => setReel([])} className="text-slate-500 hover:text-red-400 p-1">Clear</button></div>
             </div>
             <div className="flex-1 p-4 overflow-x-auto custom-scrollbar">
                <div className="flex gap-1 h-full items-center">
                   {reel.map((clip, idx) => (
                      <div key={`${clip.id}-${idx}`} className="relative group flex-none h-24 bg-slate-800 rounded-md border border-slate-600 hover:border-blue-400 cursor-pointer overflow-hidden" style={{width: `${Math.max(80, (clip.endTime - clip.startTime) * 10)}px`}} onClick={() => playClip(clip)}>
                         <div className="absolute top-1 left-2 text-[10px] font-bold truncate w-full pr-4 z-10 text-white shadow-black drop-shadow-md">{clip.title}</div>
                      </div>
                   ))}
                </div>
             </div>
          </div>
        )}

      </div>
    </div>
  );
};
