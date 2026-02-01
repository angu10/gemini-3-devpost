
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Clip, AppState, AnalysisResponse, VirtualEdit, ChatMessage, PlayerMode, TranscriptSegment, ClipEdit } from './types';
import { MAX_FILE_SIZE_MB, MODELS, DEFAULT_MODEL } from './constants';
import { analyzeVideo, processUserCommand, uploadVideo } from './services/geminiService';
import { getCachedAnalysis, saveAnalysisToCache } from './services/dbService';
import { Button } from './components/Button';

export const App: React.FC = () => {
  // --- STATE ---
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]); 
  const [hasPerformedFullAnalysis, setHasPerformedFullAnalysis] = useState(false);
  const [loadedFromCache, setLoadedFromCache] = useState(false); 
  
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
  const [clipEdits, setClipEdits] = useState<Record<string, ClipEdit>>({}); // New: Store edits per clip ID
  
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("Processing...");
  const [videoDuration, setVideoDuration] = useState<number>(0);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

    // Check Cache immediately
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
    
    // Add a user-like message
    setChatHistory(prev => [...prev, {
        id: `user-auto-${Date.now()}`,
        role: 'user',
        content: "Auto-find best moments",
        timestamp: Date.now()
    }]);

    if (loadedFromCache) {
        setChatHistory(prev => [...prev, {
            id: `cache-msg-${Date.now()}`,
            role: 'assistant',
            content: "I already have the data! Check the sidebar for the clips.",
            timestamp: Date.now()
        }]);
        return;
    }

    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.ANALYZING);
      setStatusMessage("Analzying: Transcript (Pass 1) & Visuals (Pass 2)...");
      
      const { analysis, transcript: newTranscript } = await analyzeVideo(uri, file.type, selectedModel);
      
      setAnalysisData(prev => {
        const existingClips = prev?.clips || [];
        // Deduplicate based on ID or approximate timestamp to avoid duplicates if analysis runs twice
        // We prioritize existing clips (which might be user-customized) over new ones if they are identical
        const newClips = analysis.clips.filter(nc => 
            !existingClips.some(ec => ec.id === nc.id || Math.abs(ec.startTime - nc.startTime) < 1)
        );
        
        return {
             overallSummary: analysis.overallSummary || prev?.overallSummary || '',
             clips: [...existingClips, ...newClips]
        };
      });

      setTranscript(newTranscript);
      setHasPerformedFullAnalysis(true);
      setAppState(AppState.READY);
      
      saveAnalysisToCache(file, analysis, newTranscript, selectedModel);

      setChatHistory(prev => [...prev, {
        id: `analysis-${Date.now()}`,
        role: 'assistant',
        content: `Analysis complete! I extracted a ${newTranscript.length}-line transcript and found ${analysis.clips.length} viral clips.`,
        timestamp: Date.now()
      }]);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to analyze video.");
      setAppState(AppState.ERROR);
      setChatHistory(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: "I ran into an error analyzing the video.",
        timestamp: Date.now()
      }]);
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

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    };

    setChatHistory(prev => [...prev, userMsg]);
    setChatInput('');
    setIsProcessingChat(true);
    setLongProcessWarning(false);

    const timer = setTimeout(() => {
        setLongProcessWarning(true);
    }, 8000);

    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.READY); 
      
      // Determine Active Clip for Context
      const activeClip = activeClipId && analysisData 
         ? analysisData.clips.find(c => c.id === activeClipId) 
         : null;

      const result = await processUserCommand(
        uri, 
        file.type, 
        userMsg.content, 
        analysisData?.clips || [],
        selectedModel,
        transcript,
        activeClip // Pass currently selected clip
      );

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: result.message,
        timestamp: Date.now()
      };
      setChatHistory(prev => [...prev, aiMsg]);

      // --- HANDLE INTENTS ---

      if (result.intent === 'CLIP_EDIT' && result.data && activeClipId) {
         // Apply edits to specific clip
         setClipEdits(prev => ({
             ...prev,
             [activeClipId]: {
                 id: activeClipId,
                 filterStyle: result.data.filterStyle || prev[activeClipId]?.filterStyle,
                 subtitles: result.data.subtitles || prev[activeClipId]?.subtitles,
                 overlay: result.data.overlay || prev[activeClipId]?.overlay
             }
         }));
      }
      else if (result.intent === 'REEL_ADD' && result.data) {
        let clipsToAdd: Clip[] = [];
        if (result.data.all) {
            clipsToAdd = analysisData?.clips || [];
        } else if (result.data.clips && Array.isArray(result.data.clips) && result.data.clips.length > 0) {
            clipsToAdd = result.data.clips.map((c: any) => ({
                ...c,
                id: c.id || `gen-${Date.now()}-${Math.random()}`,
                startTime: typeof c.startTime === 'number' && Number.isFinite(c.startTime) ? c.startTime : 0,
                endTime: typeof c.endTime === 'number' && Number.isFinite(c.endTime) ? c.endTime : 0,
                category: c.category || 'Custom'
            }));
        } else if (result.data.startTime !== undefined) {
             const c = result.data;
             clipsToAdd = [{
               ...c,
               startTime: typeof c.startTime === 'number' && Number.isFinite(c.startTime) ? c.startTime : 0,
               endTime: typeof c.endTime === 'number' && Number.isFinite(c.endTime) ? c.endTime : 0
             } as Clip];
        }

        if (clipsToAdd.length > 0) {
            setReel(prev => [...prev, ...clipsToAdd]);
            if (!result.data.all) {
                setAnalysisData(prev => {
                   const currentClips = prev?.clips || [];
                   const newUniqueClips = clipsToAdd.filter(
                       nc => !currentClips.some(oc => oc.id === nc.id)
                   );
                   if (newUniqueClips.length === 0) return prev;
                   return { overallSummary: prev?.overallSummary || '', clips: [...newUniqueClips, ...currentClips] };
                });
            }
            playClip(clipsToAdd[0]);
        }
      } else if (result.intent === 'REEL_REMOVE') {
        const idx = result.data.index;
        setReel(prev => {
           if (idx === -1) return prev.slice(0, -1); 
           if (idx !== undefined && idx >= 0 && idx < prev.length) {
              const newReel = [...prev];
              newReel.splice(idx, 1);
              return newReel;
           }
           return prev;
        });
      } else if (result.intent === 'REEL_CLEAR') {
        setReel([]);
      } else if (result.intent === 'EDIT' && result.data) {
        // Global Edit
        const duration = videoRef.current?.duration || 100;
        const keeps = result.data.keepSegments || [{ start: 0, end: duration }];
        setVirtualEdit({
          isActive: true,
          description: result.data.description,
          keepSegments: keeps,
          filterStyle: result.data.filterStyle,
          transitionEffect: result.data.transitionEffect
        });
      } else if (result.intent === 'SEARCH' && result.data) {
         const clip = result.data as Clip;
         if (clip.startTime === -1) {
            setChatHistory(prev => [...prev, {
              id: `warn-${Date.now()}`,
              role: 'assistant',
              content: "I found the topic, but couldn't timestamp it accurately.",
              timestamp: Date.now()
            }]);
            return;
         }
         if (!clip.id) clip.id = `search-${Date.now()}`;
         if (!clip.title) clip.title = "Found Clip";
         if (!clip.tags) clip.tags = ["Search Result"];
         if (!clip.category) clip.category = "Custom";
         if (typeof clip.startTime !== 'number') clip.startTime = 0;
         if (typeof clip.endTime !== 'number') clip.endTime = 0;
         if (clip.endTime <= clip.startTime) clip.endTime = clip.startTime + 10;

         setAnalysisData(prev => {
             if (prev?.clips.some(c => c.id === clip.id)) return prev;
             return { 
                 overallSummary: prev?.overallSummary || 'Search Results', 
                 clips: [clip, ...(prev?.clips || [])] 
             };
         });
         playClip(clip);
      }

    } catch (err) {
      console.error(err);
      setChatHistory(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: "Sorry, I had trouble processing that request.",
        timestamp: Date.now()
      }]);
    } finally {
      clearTimeout(timer);
      setIsProcessingChat(false);
      setLongProcessWarning(false);
      if (appState === AppState.UPLOADING) setAppState(AppState.READY);
    }
  };

  // --- PLAYBACK LOGIC ---

  const playClip = (clip: Clip) => {
    if (!videoRef.current) return;
    setPlayerMode('SINGLE');
    setActiveClipId(clip.id);
    
    let start = clip.startTime;
    let end = clip.endTime;

    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end)) end = 0;
    if (end <= start) end = start + 10; 
    
    videoRef.current.currentTime = start;
    videoRef.current.play();
  };

  const playReel = () => {
    if (reel.length === 0 || !videoRef.current) return;
    setPlayerMode('REEL');
    setReelCurrentIndex(0);
    
    let start = reel[0].startTime;
    if (!Number.isFinite(start) || start < 0) start = 0;
    
    videoRef.current.currentTime = start;
    videoRef.current.play();
    setVirtualEdit(null);
  };

  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    const currentTime = videoRef.current.currentTime;

    if (playerMode === 'REEL' && reel.length > 0) {
      const currentClip = reel[reelCurrentIndex];
      let start = currentClip.startTime;
      let end = currentClip.endTime;
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end)) end = 0;
      
      const safeEndTime = end > start ? end : start + 5;
      
      if (currentTime >= safeEndTime) {
        const nextIndex = reelCurrentIndex + 1;
        if (nextIndex < reel.length) {
           triggerTransition();
           setReelCurrentIndex(nextIndex);
           let nextStart = reel[nextIndex].startTime;
           if (!Number.isFinite(nextStart) || nextStart < 0) nextStart = 0;
           
           videoRef.current.currentTime = nextStart;
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
         let start = currentClip.startTime;
         let end = currentClip.endTime;
         if (!Number.isFinite(start)) start = 0;
         if (!Number.isFinite(end)) end = 0;

         const safeEndTime = end > start ? end : start + 10;
         if (currentTime >= safeEndTime) {
            videoRef.current.currentTime = start;
            videoRef.current.play();
         }
      }
    }

    if (playerMode === 'FULL' && virtualEdit?.isActive && virtualEdit.keepSegments.length > 0) {
      const inValidSegment = virtualEdit.keepSegments.some(
        seg => currentTime >= seg.start && currentTime < seg.end
      );

      if (!inValidSegment) {
        const nextSegment = virtualEdit.keepSegments.find(seg => seg.start > currentTime);
        if (nextSegment) {
          const safeNextStart = Number.isFinite(nextSegment.start) ? nextSegment.start : currentTime;
          videoRef.current.currentTime = safeNextStart;
        } else {
          if (currentTime < videoRef.current.duration - 0.5) { 
             videoRef.current.pause();
             const dur = videoRef.current.duration;
             videoRef.current.currentTime = Number.isFinite(dur) ? dur : 0;
          }
        }
      }
    }
  }, [playerMode, reel, reelCurrentIndex, activeClipId, analysisData, virtualEdit]);

  const triggerTransition = () => {
    setIsTransitioning(true);
    setTimeout(() => setIsTransitioning(false), 500); 
  };

  // --- EXPORT / DOWNLOAD LOGIC ---
  const handleDownloadClip = async (e: React.MouseEvent, clip: Clip) => {
    e.stopPropagation();
    if (!videoUrl || isExportingSmart || downloadingClipId) return;
    setDownloadingClipId(clip.id);
    try {
      await processAndDownload([clip], `clip_${clip.title.replace(/\s+/g, '_')}.webm`);
    } catch (error) {
      console.error("Download failed:", error);
      alert("Download failed. Please try again.");
    } finally {
      setDownloadingClipId(null);
    }
  };
  
  const handleDownloadAllClips = async () => {
      if(!analysisData?.clips || isExportingSmart || !videoUrl) return;
      if(analysisData.clips.length === 0) return;
      
      setIsExportingSmart(true);
      try {
          let count = 0;
          for (const clip of analysisData.clips) {
              setDownloadingClipId(clip.id); 
              try {
                  await processAndDownload([clip], `clip_${clip.title.replace(/\s+/g, '_')}.webm`);
                  count++;
                  await new Promise(r => setTimeout(r, 800));
              } catch (e) {
                  console.error(`Failed to download clip ${clip.title}`, e);
              }
          }
          alert(`Downloaded ${count} clips successfully.`);
      } catch (e) {
          console.error("Batch download error", e);
      } finally {
          setIsExportingSmart(false);
          setDownloadingClipId(null);
      }
  };

  const handleExportReel = async (clipsOverride?: Clip[]) => {
    const clipsToExport = clipsOverride || reel;
    if (clipsToExport.length === 0 || !videoUrl || isExportingSmart) return;
    
    setIsExportingSmart(true);
    try {
      await processAndDownload(clipsToExport, `smartclip_compilation_${Date.now()}.webm`);
    } catch (error) {
      console.error("Export failed:", error);
      alert("Export failed. Please try again.");
    } finally {
      setIsExportingSmart(false);
    }
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
    
    if (!ctx) {
        if (document.body.contains(workerVideo)) document.body.removeChild(workerVideo);
        throw new Error("Could not create canvas context");
    }

    await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject("Video metadata load timeout"), 5000);
        workerVideo.onloadedmetadata = () => { clearTimeout(t); resolve(); };
        workerVideo.onerror = () => { clearTimeout(t); reject("Video load error"); };
    }).catch(e => {
        console.error(e);
        if (document.body.contains(workerVideo)) document.body.removeChild(workerVideo);
        throw new Error("Failed to load video");
    });

    canvas.width = workerVideo.videoWidth;
    canvas.height = workerVideo.videoHeight;

    const stream = canvas.captureStream(30); 
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(workerVideo);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    
    if (dest.stream.getAudioTracks().length > 0) {
        stream.addTrack(dest.stream.getAudioTracks()[0]);
    }

    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
    const chunks: BlobPart[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    let animationFrameId: number;
    const draw = () => {
      // Find active clip to render edits
      const currentTime = workerVideo.currentTime;
      const activeClip = clipsToProcess.find(c => currentTime >= c.startTime && currentTime <= (c.endTime + 0.5));

      // 1. Draw Video Frame with Filters
      let filter = 'none';
      if (activeClip && clipEdits[activeClip.id]?.filterStyle) {
          filter = clipEdits[activeClip.id].filterStyle!;
      } else if (virtualEdit?.filterStyle) {
          filter = virtualEdit.filterStyle;
      }
      ctx.filter = filter;
      ctx.drawImage(workerVideo, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none'; // Reset filter for text drawing

      // 2. Draw Subtitles & Overlays
      if (activeClip && clipEdits[activeClip.id]) {
          const edit = clipEdits[activeClip.id];
          
          // -- SUBTITLES --
          if (edit.subtitles) {
              const fontSize = Math.max(24, Math.floor(canvas.height * 0.04));
              ctx.font = `bold ${fontSize}px Inter, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'bottom';
              
              const text = edit.subtitles;
              const maxWidth = canvas.width * 0.8;
              const x = canvas.width / 2;
              const y = canvas.height - (canvas.height * 0.1);
              
              // Text Wrapping
              const words = text.split(' ');
              let line = '';
              const lines = [];
              
              for (let n = 0; n < words.length; n++) {
                  const testLine = line + words[n] + ' ';
                  const metrics = ctx.measureText(testLine);
                  if (metrics.width > maxWidth && n > 0) {
                      lines.push(line);
                      line = words[n] + ' ';
                  } else {
                      line = testLine;
                  }
              }
              lines.push(line);

              const lineHeight = fontSize * 1.4;
              const totalHeight = lines.length * lineHeight;
              const startY = y - totalHeight + lineHeight; 

              // Background Box
              let maxLineWidth = 0;
              lines.forEach(l => maxLineWidth = Math.max(maxLineWidth, ctx.measureText(l).width));
              
              ctx.fillStyle = 'rgba(0,0,0,0.6)';
              const padding = fontSize * 0.5;
              ctx.fillRect(x - maxLineWidth/2 - padding, startY - lineHeight, maxLineWidth + padding*2, totalHeight + padding/2);

              // Text
              ctx.fillStyle = 'white';
              lines.forEach((l, i) => {
                  ctx.fillText(l, x, startY + (i * lineHeight) - lineHeight/3); 
              });
          }

          // -- STICKERS / OVERLAYS --
          if (edit.overlay) {
             const { content, type, position } = edit.overlay;
             let x = canvas.width / 2;
             let y = canvas.height / 2;
             
             if (position === 'TOP') y = canvas.height * 0.15;
             if (position === 'BOTTOM') y = canvas.height * 0.85;
             if (position.includes('LEFT')) x = canvas.width * 0.15;
             if (position.includes('RIGHT')) x = canvas.width * 0.85;
             if (position.includes('TOP') && position !== 'TOP') y = canvas.height * 0.15;
             if (position.includes('BOTTOM') && position !== 'BOTTOM') y = canvas.height * 0.85;

             ctx.textAlign = 'center';
             ctx.textBaseline = 'middle';

             if (type === 'EMOJI') {
                 const fontSize = Math.floor(canvas.height * 0.2);
                 ctx.font = `${fontSize}px serif`;
                 ctx.fillText(content, x, y);
             } else if (type === 'TEXT') {
                 ctx.save();
                 ctx.translate(x, y);
                 ctx.rotate(-6 * Math.PI / 180);
                 
                 const fontSize = Math.floor(canvas.height * 0.08);
                 ctx.font = `900 ${fontSize}px Inter, sans-serif`;
                 const textMetrics = ctx.measureText(content);
                 const width = textMetrics.width;
                 const p = fontSize * 0.4;
                 
                 ctx.fillStyle = '#dc2626';
                 ctx.shadowColor = 'rgba(0,0,0,0.5)';
                 ctx.shadowBlur = 20;
                 ctx.fillRect(-width/2 - p, -fontSize/2 - p, width + p*2, fontSize + p*1.5);
                 
                 ctx.fillStyle = 'white';
                 ctx.shadowBlur = 0;
                 ctx.fillText(content, 0, 0);
                 
                 ctx.restore();
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
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        if (document.body.contains(workerVideo)) {
            document.body.removeChild(workerVideo);
        }
        resolve();
      };

      mediaRecorder.start();
      draw();

      try {
        for (const clip of clipsToProcess) {
          let start = clip.startTime;
          let end = clip.endTime;
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end)) end = 0;
          if (end <= start) end = start + 5;

          workerVideo.currentTime = start;
          await new Promise<void>(r => { 
             const timeout = setTimeout(() => r(), 2000); 
             const fn = () => { clearTimeout(timeout); workerVideo.removeEventListener('seeked', fn); r(); }; 
             workerVideo.addEventListener('seeked', fn); 
          });
          
          await workerVideo.play();
          
          await new Promise<void>(r => {
            const check = () => {
              if (workerVideo.currentTime >= end || workerVideo.paused || workerVideo.ended) { 
                  workerVideo.pause(); 
                  r(); 
              } else { 
                  requestAnimationFrame(check);
              }
            };
            check();
          });
        }
        mediaRecorder.stop();
      } catch (e) {
        mediaRecorder.stop();
        if (document.body.contains(workerVideo)) document.body.removeChild(workerVideo);
        resolve();
      }
    });
  };

  const reset = () => {
    setFile(null);
    setVideoUrl(null);
    setFileUri(null);
    setAnalysisData(null);
    setTranscript([]);
    setHasPerformedFullAnalysis(false);
    setLoadedFromCache(false);
    setAppState(AppState.IDLE);
    setActiveClipId(null);
    setChatHistory([]);
    setReel([]);
    setPlayerMode('FULL');
    setVirtualEdit(null);
    setClipEdits({});
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setVideoDuration(e.currentTarget.duration);
  };
  
  // -- RENDER HELPERS --
  const getActiveClipEdit = () => {
      if (playerMode === 'SINGLE' && activeClipId && clipEdits[activeClipId]) {
          return clipEdits[activeClipId];
      }
      return null;
  };

  const currentClipEdit = getActiveClipEdit();
  // Combine global filter with specific clip filter
  const currentFilter = currentClipEdit?.filterStyle || virtualEdit?.filterStyle || 'none';

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-slate-50 flex flex-col relative overflow-hidden">
      {/* Background & Header Omitted for brevity, logic identical to previous version */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-950/40 via-purple-950/40 to-pink-950/40" />
        <div className="absolute top-20 right-20 w-96 h-96 bg-blue-500/20 rounded-full blur-[100px] animate-pulse" />
        <div className="absolute bottom-40 left-40 w-80 h-80 bg-purple-500/20 rounded-full blur-[100px] animate-pulse" style={{animationDelay: '1.5s'}} />
      </div>

      <div className="relative z-10 flex flex-col flex-1 w-full h-screen">
        <video ref={processingVideoRef} className="fixed top-0 left-0 w-1 h-1 pointer-events-none opacity-0" muted crossOrigin="anonymous"/>

        <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 h-16 flex-none z-50">
          <div className="max-w-full mx-auto px-6 h-full flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-400">
                  SmartClip.ai
                </h1>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
                {loadedFromCache && <span className="text-xs text-green-400 bg-green-900/30 px-2 py-1 rounded border border-green-800">⚡ Loaded from Cloud</span>}
                {file && (
                    <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="bg-slate-800 text-slate-300 border border-slate-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                        <option value={MODELS.FLASH}>⚡ Gemini 3 Flash</option>
                        <option value={MODELS.PRO}>🧠 Gemini 3 Pro</option>
                    </select>
                )}
                {file && <Button variant="secondary" onClick={reset} className="text-sm py-1">New Project</Button>}
            </div>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          
          <div className={`flex-1 flex flex-col p-6 overflow-y-auto ${!file ? 'items-center justify-center' : ''}`}>
             {!file ? (
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

                 <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full px-4 animate-in fade-in slide-in-from-bottom-12 duration-700 delay-300">
                   <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 backdrop-blur-sm hover:border-blue-500/30 transition-colors">
                     <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center mb-4 text-blue-400">
                       <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                     </div>
                     <h3 className="text-lg font-semibold text-white mb-2">Viral Clip Discovery</h3>
                     <p className="text-slate-400 text-sm leading-relaxed">AI analyzes energy, laughter, and keywords to find 5-15 perfect shorts for TikTok.</p>
                   </div>
                   <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 backdrop-blur-sm hover:border-purple-500/30 transition-colors">
                     <div className="w-10 h-10 bg-purple-500/10 rounded-xl flex items-center justify-center mb-4 text-purple-400">
                       <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                     </div>
                     <h3 className="text-lg font-semibold text-white mb-2">Transcript Search</h3>
                     <p className="text-slate-400 text-sm leading-relaxed">Search for specific topics like "Bitcoin" or "Jokes" and jump to that second instantly.</p>
                   </div>
                   <div className="bg-slate-900/50 p-6 rounded-2xl border border-slate-800 backdrop-blur-sm hover:border-pink-500/30 transition-colors">
                     <div className="w-10 h-10 bg-pink-500/10 rounded-xl flex items-center justify-center mb-4 text-pink-400">
                       <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                     </div>
                     <h3 className="text-lg font-semibold text-white mb-2">Director Copilot</h3>
                     <p className="text-slate-400 text-sm leading-relaxed">Chat with your video editor. Ask it to "Find funny parts" or "Remove silence".</p>
                   </div>
                 </div>
               </div>
             ) : (
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
                    
                    {/* OVERLAYS & SUBTITLES */}
                    <div className="absolute inset-0 pointer-events-none overflow-hidden">
                       {/* Subtitles */}
                       {currentClipEdit?.subtitles && (
                         <div className="absolute bottom-16 left-0 right-0 flex justify-center">
                            <div className="bg-black/60 text-white px-4 py-2 rounded-lg text-lg font-bold backdrop-blur-sm max-w-[80%] text-center">
                               {currentClipEdit.subtitles}
                            </div>
                         </div>
                       )}
                       
                       {/* Sticker/Overlay */}
                       {currentClipEdit?.overlay && (
                          <div className={`absolute p-4 animate-in zoom-in duration-300 
                            ${currentClipEdit.overlay.position === 'CENTER' ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2' : ''}
                            ${currentClipEdit.overlay.position === 'TOP' ? 'top-8 left-1/2 -translate-x-1/2' : ''}
                            ${currentClipEdit.overlay.position === 'BOTTOM' ? 'bottom-20 left-1/2 -translate-x-1/2' : ''}
                            ${currentClipEdit.overlay.position === 'TOP_RIGHT' ? 'top-8 right-8' : ''}
                            ${currentClipEdit.overlay.position === 'TOP_LEFT' ? 'top-8 left-8' : ''}
                          `}>
                             {currentClipEdit.overlay.type === 'EMOJI' && (
                                <span className="text-8xl drop-shadow-lg">{currentClipEdit.overlay.content}</span>
                             )}
                             {currentClipEdit.overlay.type === 'TEXT' && (
                                <span className="text-4xl font-black text-white bg-red-600 px-4 py-2 uppercase -rotate-6 shadow-xl border-4 border-white">{currentClipEdit.overlay.content}</span>
                             )}
                          </div>
                       )}
                    </div>
                    
                    {virtualEdit?.isActive && (
                      <div className="absolute top-4 right-4 bg-purple-600/90 text-white px-3 py-1 rounded-full text-xs font-bold border border-purple-400/50 animate-pulse shadow-lg backdrop-blur-md">
                        {virtualEdit.keepSegments.length < 2 && virtualEdit.keepSegments[0]?.end === videoRef.current?.duration ? "FILTER ACTIVE" : "✂️ AUTO-EDIT ACTIVE"}
                      </div>
                    )}

                    <div className={`absolute inset-0 bg-black pointer-events-none transition-opacity duration-300 ${isTransitioning ? 'opacity-100' : 'opacity-0'}`} />

                    <div className="absolute top-4 left-4 flex gap-2">
                       {playerMode === 'REEL' && <span className="bg-red-600 text-white px-2 py-1 rounded text-xs font-bold animate-pulse">PLAYING REEL</span>}
                    </div>

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
                           {/* Download All (Zip/Batch style) */}
                           <button 
                              onClick={handleDownloadAllClips}
                              disabled={isExportingSmart}
                              className="text-xs font-bold bg-slate-800 text-blue-300 border border-blue-500/30 px-3 py-1.5 rounded hover:bg-slate-700 flex items-center gap-2"
                           >
                              {isExportingSmart ? (
                                  <><div className="w-3 h-3 border-2 border-blue-300 border-t-transparent rounded-full animate-spin"/> Processing...</>
                              ) : (
                                  <><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg> Download All</>
                              )}
                           </button>

                           {/* Export Compilation (One Video) */}
                           <button 
                              onClick={() => handleExportReel(analysisData.clips)}
                              disabled={isExportingSmart}
                              className="text-xs font-bold bg-purple-900/40 text-purple-300 border border-purple-500/30 px-3 py-1.5 rounded hover:bg-purple-800/60 flex items-center gap-2"
                           >
                              {isExportingSmart ? (
                                  <><div className="w-3 h-3 border-2 border-purple-300 border-t-transparent rounded-full animate-spin"/> Processing...</>
                              ) : (
                                  <><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg> Compilation Reel</>
                              )}
                           </button>
                         </div>
                      </div>
                      <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                         {analysisData.clips.map(clip => (
                           <div key={clip.id} 
                                onClick={() => playClip(clip)} 
                                className={`group relative flex-none w-48 p-2 rounded-lg cursor-pointer transition-all border
                                   ${activeClipId === clip.id ? 'bg-blue-900/20 border-blue-500 shadow-md ring-1 ring-blue-500/30' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}
                                `}>
                              <p className={`text-sm font-medium truncate ${activeClipId === clip.id ? 'text-blue-200' : ''}`}>{clip.title}</p>
                              <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                                <span>{Math.round(clip.endTime - clip.startTime)}s</span>
                                {clipEdits[clip.id] && <span className="text-purple-400 font-bold">✨ EDITED</span>}
                              </div>
                              <button 
                                onClick={(e) => handleDownloadClip(e, clip)}
                                disabled={downloadingClipId === clip.id}
                                className={`absolute top-2 right-2 p-1.5 rounded-full bg-slate-900/80 hover:bg-blue-600 text-white shadow-md transition-all ${downloadingClipId === clip.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                              >
                                {downloadingClipId === clip.id ? (
                                   <div className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin"></div>
                                ) : (
                                   <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                )}
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
                         <div className="text-slate-500 text-xs mt-1">Detect laughter & jokes</div>
                      </button>

                      <button onClick={() => triggerQuickAction("Create a summary of the main points")} className="bg-slate-800 hover:bg-slate-750 border border-slate-700 p-4 rounded-xl text-left transition-all group">
                         <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">📝</div>
                         <div className="font-bold text-slate-200 text-sm">Summarize</div>
                         <div className="text-slate-500 text-xs mt-1">Short recap of video</div>
                      </button>

                      <button onClick={() => triggerQuickAction("Find actionable advice")} className="bg-slate-800 hover:bg-slate-750 border border-slate-700 p-4 rounded-xl text-left transition-all group">
                         <div className="text-2xl mb-2 group-hover:scale-110 transition-transform origin-left">💡</div>
                         <div className="font-bold text-slate-200 text-sm">Find Insights</div>
                         <div className="text-slate-500 text-xs mt-1">Extract key lessons</div>
                      </button>
                   </div>
                 )}
               </div>
             )}
          </div>

          {/* Chat Interface */}
          {file && (
            <div className="w-96 bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl z-20">
              <div className="p-4 border-b border-slate-800 bg-slate-900/95 backdrop-blur z-10 flex items-center justify-between">
                <div>
                   <h2 className="font-bold text-slate-200">Highlight Copilot</h2>
                   <p className="text-xs text-slate-500">
                     {transcript.length > 0 ? "Transcript Aware" : "Analyzing..."}
                     {activeClipId && <span className="text-blue-400 font-bold ml-1"> • Editing Clip</span>}
                   </p>
                </div>
                <button onClick={resetChat} className="p-2 hover:bg-slate-800 rounded-lg text-slate-500">
                   <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                   </svg>
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {chatHistory.map(msg => (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-none' : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))}
                {isProcessingChat && (
                  <div className="flex justify-start">
                    <div className="bg-slate-800 rounded-2xl px-4 py-3 rounded-bl-none border border-slate-700">
                      <div className="flex gap-1.5 items-center">
                           <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce"></div>
                           <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                           <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
                           <span className="ml-2 text-xs text-slate-500">Thinking...</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="p-4 border-t border-slate-800 bg-slate-900">
                <form onSubmit={(e) => handleSendMessage(e)} className="relative">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder={activeClipId ? "Edit this clip (e.g. 'Add subtitles')..." : "Type a command..."}
                    className="w-full bg-slate-950 border border-slate-700 rounded-full pl-4 pr-12 py-3 text-sm focus:outline-none focus:border-blue-500 transition-colors focus:bg-slate-900"
                  />
                  <button type="submit" disabled={!chatInput.trim() || isProcessingChat} className="absolute right-2 top-2 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-500 disabled:opacity-50">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </button>
                </form>
                {/* Persistent Quick Action Chips */}
                <div className="flex gap-2 mt-3 overflow-x-auto pb-1 no-scrollbar mask-gradient-right">
                   <button onClick={() => triggerQuickAction("Auto-find best moments")} disabled={hasPerformedFullAnalysis || appState === AppState.ANALYZING || loadedFromCache} className="whitespace-nowrap text-xs bg-blue-900/40 border border-blue-500/40 text-blue-300 px-3 py-1.5 rounded-full hover:bg-blue-800/60 transition-colors flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed">
                      <span>✨ Auto-Find</span>
                   </button>
                   {activeClipId ? (
                       <>
                        <button onClick={() => triggerQuickAction("Make this clip cinematic")} className="whitespace-nowrap text-xs bg-purple-900/40 border border-purple-500/40 text-purple-300 px-3 py-1.5 rounded-full hover:bg-purple-800/60 transition-colors">
                            🎨 Cinematic
                        </button>
                        <button onClick={() => triggerQuickAction("Translate this to Spanish subtitles")} className="whitespace-nowrap text-xs bg-purple-900/40 border border-purple-500/40 text-purple-300 px-3 py-1.5 rounded-full hover:bg-purple-800/60 transition-colors">
                            🇪🇸 Translate
                        </button>
                        <button onClick={() => triggerQuickAction("Add a laughing emoji")} className="whitespace-nowrap text-xs bg-purple-900/40 border border-purple-500/40 text-purple-300 px-3 py-1.5 rounded-full hover:bg-purple-800/60 transition-colors">
                            😂 Add Sticker
                        </button>
                       </>
                   ) : (
                       <>
                        <button onClick={() => triggerQuickAction("Find the funniest parts")} className="whitespace-nowrap text-xs bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-full hover:bg-slate-700 transition-colors">
                            😂 Find Funny
                        </button>
                        <button onClick={() => triggerQuickAction("Remove silence and filler words from the video")} className="whitespace-nowrap text-xs bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-full hover:bg-slate-700 transition-colors">
                            ✂️ Remove Silence
                        </button>
                        <button onClick={() => triggerQuickAction("Create a summary")} className="whitespace-nowrap text-xs bg-slate-800 border border-slate-700 text-slate-300 px-3 py-1.5 rounded-full hover:bg-slate-700 transition-colors">
                            📝 Summarize
                        </button>
                       </>
                   )}
                </div>
              </div>
            </div>
          )}
        </div>
        
        {/* Timeline Reel (Same as before) */}
        {file && reel.length > 0 && (
          <div className="h-48 bg-slate-950 border-t border-slate-800 flex flex-col shadow-[0_-5px_20px_rgba(0,0,0,0.5)] z-40 animate-in slide-in-from-bottom duration-500">
             <div className="h-10 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                   <span className="text-xs font-bold uppercase tracking-wider text-blue-400">Timeline Reel</span>
                   <span className="bg-slate-800 text-slate-400 text-[10px] px-2 py-0.5 rounded-full">{reel.length} clips</span>
                </div>
                <div className="flex items-center gap-3">
                   <button onClick={playReel} className="flex items-center gap-2 text-xs font-bold bg-white text-slate-900 px-3 py-1.5 rounded hover:bg-blue-50 transition-colors">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      Play Reel
                   </button>
                   <button onClick={() => handleExportReel()} disabled={isExportingSmart} className="flex items-center gap-2 text-xs font-bold bg-slate-800 text-slate-300 px-3 py-1.5 rounded hover:bg-slate-700 border border-slate-700">
                      {isExportingSmart ? <span className="animate-spin">⌛</span> : <span>Export</span>}
                   </button>
                   <button onClick={() => setReel([])} className="text-slate-500 hover:text-red-400 p-1">Clear</button>
                </div>
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
