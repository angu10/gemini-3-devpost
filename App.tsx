
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Clip, AppState, AnalysisResponse, SearchState, VirtualEdit, ChatMessage, PlayerMode } from './types';
import { MAX_FILE_SIZE_MB, MODELS, DEFAULT_MODEL } from './constants';
import { analyzeVideo, processUserCommand, uploadVideo } from './services/geminiService';
import { Button } from './components/Button';
import { ClipCard, SkeletonClipCard } from './components/ClipCard';

const App: React.FC = () => {
  // --- STATE ---
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  const [hasPerformedFullAnalysis, setHasPerformedFullAnalysis] = useState(false);
  
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

  // Legacy/Compatibility State
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false);
  const [isExportingSmart, setIsExportingSmart] = useState<boolean>(false);
  const [virtualEdit, setVirtualEdit] = useState<VirtualEdit | null>(null);
  
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

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
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
    setAppState(AppState.READY);
    setErrorMsg(null);
    setAnalysisData(null);
    setHasPerformedFullAnalysis(false);
    resetChat();
    setReel([]);
    setVirtualEdit(null);
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
    
    // Add a user-like message to chat to show action was taken
    setChatHistory(prev => [...prev, {
        id: `user-auto-${Date.now()}`,
        role: 'user',
        content: "Auto-find best moments",
        timestamp: Date.now()
    }]);

    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.ANALYZING);
      setStatusMessage("Finding best moments...");
      
      const data = await analyzeVideo(uri, file.type, selectedModel, (partialClips) => {
        setAnalysisData(prev => {
           // Preserve custom clips during streaming updates
           const customClips = prev?.clips.filter(c => c.category === 'Custom') || [];
           return {
             overallSummary: prev?.overallSummary || '',
             clips: [...customClips, ...partialClips]
           };
        });
      });
      
      setAnalysisData(prev => {
         const customClips = prev?.clips.filter(c => c.category === 'Custom') || [];
         return {
            ...data,
            clips: [...customClips, ...data.clips]
         };
      });
      
      setHasPerformedFullAnalysis(true);
      setAppState(AppState.READY);
      setChatHistory(prev => [...prev, {
        id: `analysis-${Date.now()}`,
        role: 'assistant',
        content: `I found ${data.clips.length} interesting clips! Click one to play, or click the download icon to save it.`,
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

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !chatInput.trim() || isProcessingChat) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: chatInput,
      timestamp: Date.now()
    };

    setChatHistory(prev => [...prev, userMsg]);
    setChatInput('');
    setIsProcessingChat(true);
    setLongProcessWarning(false);

    // Warning Timer
    const timer = setTimeout(() => {
        setLongProcessWarning(true);
    }, 8000);

    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.READY); 
      
      const result = await processUserCommand(
        uri, 
        file.type, 
        userMsg.content, 
        analysisData?.clips || [],
        selectedModel
      );

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: result.message,
        timestamp: Date.now()
      };
      setChatHistory(prev => [...prev, aiMsg]);

      // EXECUTE INTENT
      if (result.intent === 'REEL_ADD' && result.data) {
        
        let clipsToAdd: Clip[] = [];

        // Check for "ALL" intent
        if (result.data.all) {
            clipsToAdd = analysisData?.clips || [];
        } else if (result.data.clips && Array.isArray(result.data.clips) && result.data.clips.length > 0) {
            // Handle explicit clip list
            clipsToAdd = result.data.clips.map((c: any) => ({
                ...c,
                id: c.id || `gen-${Date.now()}-${Math.random()}`,
                startTime: typeof c.startTime === 'number' && Number.isFinite(c.startTime) ? c.startTime : 0,
                endTime: typeof c.endTime === 'number' && Number.isFinite(c.endTime) ? c.endTime : 0,
                category: c.category || 'Custom'
            }));
        } else if (result.data.startTime !== undefined) {
             // Handle single clip
             const c = result.data;
             clipsToAdd = [{
               ...c,
               startTime: typeof c.startTime === 'number' && Number.isFinite(c.startTime) ? c.startTime : 0,
               endTime: typeof c.endTime === 'number' && Number.isFinite(c.endTime) ? c.endTime : 0
             } as Clip];
        }

        if (clipsToAdd.length > 0) {
            setReel(prev => [...prev, ...clipsToAdd]);
            
            // Only update analysis data if we generated *new* clips, not if we just moved existing ones
            if (!result.data.all) {
                setAnalysisData(prev => {
                   const currentClips = prev?.clips || [];
                   const newUniqueClips = clipsToAdd.filter(
                       nc => !currentClips.some(oc => oc.id === nc.id || (Math.abs(oc.startTime - nc.startTime) < 0.5 && Math.abs(oc.endTime - nc.endTime) < 0.5))
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
            // AI signaled that it found the topic but couldn't timestamp it
            setChatHistory(prev => [...prev, {
              id: `warn-${Date.now()}`,
              role: 'assistant',
              content: "I found the topic you mentioned, but I couldn't identify the exact timestamp in the video file.",
              timestamp: Date.now()
            }]);
            return;
         }

         // Ensure clip has necessary fields if freshly generated
         if (!clip.id) clip.id = `search-${Date.now()}`;
         if (!clip.title) clip.title = "Found Clip";
         if (!clip.tags) clip.tags = ["Search Result"];
         if (!clip.category) clip.category = "Custom"; // Changed from "Other" to "Custom" so it persists
         if (clip.viralityScore === undefined || clip.viralityScore === null) clip.viralityScore = 5;

         // Sanitize timestamps
         if (typeof clip.startTime !== 'number' || !Number.isFinite(clip.startTime)) clip.startTime = 0;
         if (typeof clip.endTime !== 'number' || !Number.isFinite(clip.endTime)) clip.endTime = 0;

         // Safety check for empty or 0-duration clips
         if (clip.endTime === 0 || clip.endTime <= clip.startTime) {
             if (clip.startTime === 0 && clip.endTime === 0) {
                // If it's literally 0-0, it's likely a hallucination or failure to find.
                // We'll trust it if description is detailed, but update end time to 10s to ensure it's playable.
                clip.endTime = 10;
             }
         }

         // Add to analysisData so it appears in the drawer and loop playback works
         setAnalysisData(prev => {
             // If this clip ID already exists, don't duplicate
             if (prev?.clips.some(c => c.id === clip.id)) return prev;
             
             // Check for duplicate timestamps (approximate)
             const isDuplicateTime = prev?.clips.some(c => 
                 Math.abs(c.startTime - clip.startTime) < 1.0 && 
                 Math.abs(c.endTime - clip.endTime) < 1.0
             );
             
             if (isDuplicateTime) {
                 return prev;
             }

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
        content: "Sorry, I had trouble processing that request. Please try again.",
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
    
    // Safety check for timestamps
    let start = clip.startTime;
    let end = clip.endTime;

    // Strict validation
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end)) end = 0;
    
    // If end is 0 or less than start, force a reasonable duration
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

    // 1. REEL MODE
    if (playerMode === 'REEL' && reel.length > 0) {
      const currentClip = reel[reelCurrentIndex];
      // Safety: Use clip end time, or start + 5s if invalid
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

    // 2. SINGLE CLIP LOOP MODE
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

    // 3. VIRTUAL EDIT SKIP LOGIC (Remove Ums)
    if (playerMode === 'FULL' && virtualEdit?.isActive && virtualEdit.keepSegments.length > 0) {
      // Find if we are currently in a valid segment
      const inValidSegment = virtualEdit.keepSegments.some(
        seg => currentTime >= seg.start && currentTime < seg.end
      );

      if (!inValidSegment) {
        // If not in valid segment, find the NEXT valid segment start
        const nextSegment = virtualEdit.keepSegments.find(seg => seg.start > currentTime);
        if (nextSegment) {
          const safeNextStart = Number.isFinite(nextSegment.start) ? nextSegment.start : currentTime;
          videoRef.current.currentTime = safeNextStart;
        } else {
          // No more segments, stop
          if (currentTime < videoRef.current.duration - 0.5) { // Prevent infinite loop at very end
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
    await processAndDownload([clip], `clip_${clip.title.replace(/\s+/g, '_')}.webm`);
    setDownloadingClipId(null);
  };

  const handleExportReel = async () => {
    if (reel.length === 0 || !videoUrl || isExportingSmart) return;
    setIsExportingSmart(true);
    try {
      await processAndDownload(reel, `highlight_reel_${Date.now()}.webm`);
    } catch (error) {
      console.error("Export failed:", error);
      alert("Export failed. Please try again.");
    } finally {
      setIsExportingSmart(false);
    }
  };

  const processAndDownload = async (clipsToProcess: Clip[], filename: string) => {
    // Create a totally new video element to avoid AudioContext already-connected errors.
    const workerVideo = document.createElement('video');
    workerVideo.style.display = 'none';
    workerVideo.crossOrigin = 'anonymous';
    workerVideo.src = videoUrl || '';
    workerVideo.muted = false; // Must be false to capture audio
    
    document.body.appendChild(workerVideo);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
        if (document.body.contains(workerVideo)) document.body.removeChild(workerVideo);
        throw new Error("Could not create canvas context");
    }

    // Wait for metadata to load so we have dimensions
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
    } else {
        console.warn("No audio track detected in source video.");
    }

    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
    const chunks: BlobPart[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    let animationFrameId: number;
    const draw = () => {
      if (virtualEdit?.filterStyle) ctx.filter = virtualEdit.filterStyle;
      ctx.drawImage(workerVideo, 0, 0, canvas.width, canvas.height);
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
        } else {
            console.error("Export failed: No data recorded");
        }
        
        // Clean up worker video
        if (document.body.contains(workerVideo)) {
            document.body.removeChild(workerVideo);
        }
        
        resolve();
      };

      mediaRecorder.start();
      draw();

      try {
        for (const clip of clipsToProcess) {
          // Safety fallback for bad timestamps
          let start = clip.startTime;
          let end = clip.endTime;
          
          if (!Number.isFinite(start) || start < 0) start = 0;
          if (!Number.isFinite(end)) end = 0;
          if (end <= start) end = start + 5;

          workerVideo.currentTime = start;
          
          // Robust Seek Wait
          await new Promise<void>(r => { 
             const timeout = setTimeout(() => {
                 console.warn(`Seek timeout for clip ${clip.id}, attempting to play anyway.`);
                 r();
             }, 2000); // 2s timeout for seek
             
             const fn = () => { 
                 clearTimeout(timeout);
                 workerVideo.removeEventListener('seeked', fn); 
                 r(); 
             }; 
             workerVideo.addEventListener('seeked', fn); 
          });
          
          await workerVideo.play();
          
          // Robust Play Loop
          await new Promise<void>(r => {
            const check = () => {
              // Stop condition: Reached end, paused (error/stall), or ended
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
        console.error("Export process error:", e);
        mediaRecorder.stop();
        if (document.body.contains(workerVideo)) {
            document.body.removeChild(workerVideo);
        }
        resolve();
      }
    });
  };

  const reset = () => {
    setFile(null);
    setVideoUrl(null);
    setFileUri(null);
    setAnalysisData(null);
    setHasPerformedFullAnalysis(false);
    setAppState(AppState.IDLE);
    setActiveClipId(null);
    setChatHistory([]);
    setReel([]);
    setPlayerMode('FULL');
    setVirtualEdit(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    setVideoDuration(e.currentTarget.duration);
  };

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-slate-50 flex flex-col relative overflow-hidden">
      {/* Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-950/40 via-purple-950/40 to-pink-950/40" />
        <div className="absolute top-20 right-20 w-96 h-96 bg-blue-500/20 rounded-full blur-[100px] animate-pulse" />
        <div className="absolute bottom-40 left-40 w-80 h-80 bg-purple-500/20 rounded-full blur-[100px] animate-pulse" style={{animationDelay: '1.5s'}} />
        <div className="absolute inset-0" style={{backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.08) 1px, transparent 0)', backgroundSize: '40px 40px'}} />
      </div>

      <div className="relative z-10 flex flex-col flex-1 w-full h-screen">
        <video ref={processingVideoRef} className="fixed top-0 left-0 w-1 h-1 pointer-events-none opacity-0" muted crossOrigin="anonymous"/>

        {/* HEADER */}
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
              <p className="hidden md:block text-sm text-slate-400 font-medium italic border-l border-slate-700 pl-4">Talk to your video. Watch it transform.</p>
            </div>
            
            <div className="flex items-center gap-4">
                {/* Model Selector Dropdown */}
                {file && (
                    <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="bg-slate-800 text-slate-300 border border-slate-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer hover:bg-slate-750 transition-colors"
                        title="Select AI Model"
                    >
                        <option value={MODELS.FLASH}>⚡ Gemini 3 Flash (Fast)</option>
                        <option value={MODELS.PRO}>🧠 Gemini 3 Pro (Smart)</option>
                    </select>
                )}
                {file && <Button variant="secondary" onClick={reset} className="text-sm py-1">New Project</Button>}
            </div>
          </div>
        </header>

        {/* MAIN CONTENT AREA */}
        <div className="flex flex-1 overflow-hidden">
          
          {/* LEFT: Video Player & Upload */}
          <div className={`flex-1 flex flex-col p-6 overflow-y-auto ${!file ? 'items-center justify-center' : ''}`}>
             {!file ? (
               // UPLOAD SCREEN
               <div className="w-full max-w-6xl mx-auto flex flex-col items-center justify-center py-8">
                 
                 {/* Hero Text */}
                 <div className="text-center mb-12 animate-in fade-in slide-in-from-bottom-8 duration-700">
                   <h1 className="text-5xl md:text-7xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-400 mb-6 tracking-tight">
                     Talk to your video.
                     <br />
                     Watch it transform.
                   </h1>
                   <p className="text-xl text-slate-400 max-w-2xl mx-auto leading-relaxed">
                     Upload any long-form video. Chat with our AI Copilot to find the best moments, 
                     apply styles, and build highlight reels instantly. No editing skills required.
                   </p>
                 </div>

                 {/* Upload Box */}
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
                      <p className="mt-4 text-xs text-slate-500">Powered by Gemini 3 Pro • 2M+ Context Window</p>
                    </div>
                 </div>

                 {/* Feature Showcase Grid */}
                 <div className="grid md:grid-cols-3 gap-8 w-full max-w-5xl animate-in fade-in slide-in-from-bottom-8 duration-700 delay-300">
                    <div className="bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm">
                       <div className="w-12 h-12 bg-blue-500/10 rounded-lg flex items-center justify-center mb-4 text-blue-400">
                          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                       </div>
                       <h3 className="text-lg font-bold text-white mb-2">Auto-Discovery</h3>
                       <p className="text-slate-400 text-sm leading-relaxed">Instantly identifies best moments, providing titles, scores, and reasoning.</p>
                    </div>
                    <div className="bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm">
                       <div className="w-12 h-12 bg-purple-500/10 rounded-lg flex items-center justify-center mb-4 text-purple-400">
                          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
                       </div>
                       <h3 className="text-lg font-bold text-white mb-2">Chat Copilot</h3>
                       <p className="text-slate-400 text-sm leading-relaxed">Just ask. "Find the funny part," "Make a summary," or "Add the intro." No timeline dragging required.</p>
                    </div>
                    <div className="bg-slate-800/40 p-6 rounded-2xl border border-slate-700/50 backdrop-blur-sm">
                       <div className="w-12 h-12 bg-green-500/10 rounded-lg flex items-center justify-center mb-4 text-green-400">
                          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" /></svg>
                       </div>
                       <h3 className="text-lg font-bold text-white mb-2">Instant Reels</h3>
                       <p className="text-slate-400 text-sm leading-relaxed">Copilot stitches clips together automatically. Watch your montage evolve in real-time as you chat.</p>
                    </div>
                 </div>

               </div>
             ) : (
               // VIDEO PLAYER SCREEN
               <div className="w-full max-w-5xl mx-auto flex flex-col h-full">
                 <div className="relative bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-slate-800 flex-1 min-h-[400px]">
                    <video 
                      ref={videoRef} 
                      src={videoUrl || ''} 
                      className="w-full h-full object-contain" 
                      style={{ filter: virtualEdit?.filterStyle || 'none' }}
                      controls 
                      onLoadedMetadata={onLoadedMetadata}
                      onTimeUpdate={handleTimeUpdate}
                    />
                    
                    {/* Virtual Edit Active Indicator */}
                    {virtualEdit?.isActive && (
                      <div className="absolute top-4 right-4 bg-purple-600/90 text-white px-3 py-1 rounded-full text-xs font-bold border border-purple-400/50 animate-pulse shadow-lg backdrop-blur-md">
                        {virtualEdit.keepSegments.length < 2 && virtualEdit.keepSegments[0]?.end === videoRef.current?.duration ? "FILTER ACTIVE" : "✂️ AUTO-EDIT ACTIVE"}
                      </div>
                    )}

                    {/* Transition Overlay */}
                    <div className={`absolute inset-0 bg-black pointer-events-none transition-opacity duration-300 ${isTransitioning ? 'opacity-100' : 'opacity-0'}`} />

                    {/* Mode Indicators */}
                    <div className="absolute top-4 left-4 flex gap-2">
                       {playerMode === 'REEL' && <span className="bg-red-600 text-white px-2 py-1 rounded text-xs font-bold animate-pulse">PLAYING REEL</span>}
                       {playerMode === 'SINGLE' && <span className="bg-blue-600 text-white px-2 py-1 rounded text-xs font-bold">LOOPING CLIP</span>}
                    </div>

                    {/* Loading Overlay */}
                    {(appState === AppState.ANALYZING || appState === AppState.UPLOADING) && (
                      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-10 flex-col">
                        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="font-semibold">{statusMessage}</p>
                      </div>
                    )}
                 </div>

                 {/* Segmentation Timeline Visualizer */}
                 {virtualEdit?.isActive && videoDuration > 0 && (
                     <div className="w-full h-8 bg-slate-900 mt-2 rounded flex relative overflow-hidden border border-slate-700">
                        {/* Base Red Bar (Removed Parts) */}
                        <div className="absolute inset-0 bg-red-900/30 flex items-center justify-center">
                            <span className="text-[10px] text-red-200 uppercase tracking-widest font-bold opacity-50">Removed Parts</span>
                        </div>
                        {/* Green Bars (Kept Parts) */}
                        {virtualEdit.keepSegments.map((seg, i) => (
                             <div 
                                key={i}
                                className="absolute top-0 bottom-0 bg-green-500/80 hover:bg-green-400 transition-colors border-r border-green-300/20"
                                style={{
                                    left: `${(seg.start / videoDuration) * 100}%`,
                                    width: `${((seg.end - seg.start) / videoDuration) * 100}%`
                                }}
                                title={`Keep: ${Math.round(seg.start)}s - ${Math.round(seg.end)}s`}
                             />
                        ))}
                     </div>
                 )}

                 {/* Available Clips (Mini Drawer) */}
                 {analysisData && (
                   <div className="mt-4 p-4 bg-slate-900/50 rounded-xl border border-slate-800">
                      <div className="flex items-center justify-between mb-2">
                         <div className="flex items-center gap-3">
                            <h3 className="text-xs font-bold uppercase text-slate-500 tracking-wider">Discovered Moments</h3>
                            <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">{analysisData.clips.length} found</span>
                         </div>
                      </div>
                      <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                         {analysisData.clips.map(clip => (
                           <div key={clip.id} onClick={() => playClip(clip)} className="group relative flex-none w-48 bg-slate-800 p-2 rounded-lg cursor-pointer hover:bg-slate-700 transition-colors border border-slate-700">
                              <p className="text-sm font-medium truncate">{clip.title}</p>
                              <div className="flex justify-between text-[10px] text-slate-400 mt-1">
                                <span>{Math.round(clip.endTime - clip.startTime)}s</span>
                                <span className={clip.viralityScore >= 8 ? "text-green-400" : "text-blue-400"}>Score: {clip.viralityScore}</span>
                              </div>
                              {/* Download Button on Clip */}
                              <button 
                                onClick={(e) => handleDownloadClip(e, clip)}
                                disabled={downloadingClipId === clip.id}
                                className={`absolute top-2 right-2 p-1.5 rounded-full bg-slate-900/80 hover:bg-blue-600 text-white shadow-md transition-all ${downloadingClipId === clip.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                                title="Download this clip"
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
                 )}
               </div>
             )}
          </div>

          {/* RIGHT: Chat Interface */}
          {file && (
            <div className="w-96 bg-slate-900 border-l border-slate-800 flex flex-col shadow-2xl z-20">
              <div className="p-4 border-b border-slate-800 bg-slate-900/95 backdrop-blur z-10 flex items-center justify-between">
                <div>
                   <h2 className="font-bold text-slate-200">Highlight Copilot</h2>
                   <p className="text-xs text-slate-500">Ask to find moments or build your reel.</p>
                </div>
                <button 
                   onClick={resetChat} 
                   className="p-2 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-white transition-colors"
                   title="Reset Conversation"
                >
                   <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                   </svg>
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {chatHistory.map(msg => (
                  <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user' 
                        ? 'bg-blue-600 text-white rounded-br-none' 
                        : 'bg-slate-800 text-slate-200 rounded-bl-none border border-slate-700'
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))}
                {isProcessingChat && (
                  <div className="flex justify-start">
                    <div className="bg-slate-800 rounded-2xl px-4 py-3 rounded-bl-none border border-slate-700">
                      <div className="flex flex-col gap-1.5">
                         <div className="flex gap-1.5 items-center">
                           <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce"></div>
                           <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                           <div className="w-2 h-2 bg-slate-500 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
                           <span className="ml-2 text-xs text-slate-500">Thinking...</span>
                         </div>
                         {longProcessWarning && (
                            <span className="text-[10px] text-blue-400 animate-pulse mt-1">Analyzing audio patterns...</span>
                         )}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="p-4 border-t border-slate-800 bg-slate-900">
                <form onSubmit={handleSendMessage} className="relative">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder="Type a command..."
                    className="w-full bg-slate-950 border border-slate-700 rounded-full pl-4 pr-12 py-3 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                  <button type="submit" disabled={!chatInput.trim() || isProcessingChat} className="absolute right-2 top-2 p-1.5 bg-blue-600 text-white rounded-full hover:bg-blue-500 disabled:opacity-50 transition-colors">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" /></svg>
                  </button>
                </form>
                <div className="flex gap-2 mt-2 overflow-x-auto pb-1 no-scrollbar">
                   {/* Smart Action Chip */}
                   <button onClick={handleAnalyze} disabled={hasPerformedFullAnalysis || appState === AppState.ANALYZING} className="whitespace-nowrap text-xs bg-blue-900/40 border border-blue-500/40 text-blue-300 px-3 py-1 rounded-full hover:bg-blue-800/60 hover:text-white transition-colors flex items-center gap-1">
                      <span>✨ Auto-Find Clips</span>
                   </button>
                   <button onClick={() => setChatInput("Add the funniest moment")} className="whitespace-nowrap text-xs bg-slate-800 px-2 py-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">"Add funny part"</button>
                   <button onClick={() => setChatInput("Create a summary reel")} className="whitespace-nowrap text-xs bg-slate-800 px-2 py-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">"Create summary"</button>
                   <button onClick={() => setChatInput("Remove filler words")} className="whitespace-nowrap text-xs bg-slate-800 px-2 py-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors">"Remove ums"</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* BOTTOM: Timeline Reel */}
        {file && reel.length > 0 && (
          <div className="h-48 bg-slate-950 border-t border-slate-800 flex flex-col shadow-[0_-5px_20px_rgba(0,0,0,0.5)] z-40 animate-in slide-in-from-bottom duration-500">
             <div className="h-10 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                   <span className="text-xs font-bold uppercase tracking-wider text-blue-400">Timeline Reel</span>
                   <span className="bg-slate-800 text-slate-400 text-[10px] px-2 py-0.5 rounded-full">{reel.length} clips • {Math.round(reel.reduce((acc, c) => acc + (c.endTime - c.startTime), 0))}s total</span>
                </div>
                <div className="flex items-center gap-3">
                   <button onClick={playReel} className="flex items-center gap-2 text-xs font-bold bg-white text-slate-900 px-3 py-1.5 rounded hover:bg-blue-50 transition-colors">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                      Play Reel
                   </button>
                   <button onClick={handleExportReel} disabled={isExportingSmart} className="flex items-center gap-2 text-xs font-bold bg-slate-800 text-slate-300 px-3 py-1.5 rounded hover:bg-slate-700 transition-colors border border-slate-700">
                      {isExportingSmart ? (
                        <span className="animate-spin">⌛</span>
                      ) : (
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      )}
                      Export Reel
                   </button>
                   <button onClick={() => setReel([])} className="text-slate-500 hover:text-red-400 p-1"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg></button>
                </div>
             </div>
             
             <div className="flex-1 p-4 overflow-x-auto custom-scrollbar bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-opacity-5">
                <div className="flex gap-1 h-full items-center">
                   {reel.map((clip, idx) => (
                      <div key={`${clip.id}-${idx}`} className="relative group flex-none h-24 bg-slate-800 rounded-md border border-slate-600 hover:border-blue-400 cursor-pointer overflow-hidden transition-all hover:scale-105" style={{width: `${Math.max(80, (clip.endTime - clip.startTime) * 10)}px`}} onClick={() => playClip(clip)}>
                         <div className="absolute top-1 left-2 text-[10px] font-bold truncate w-full pr-4 z-10 text-white shadow-black drop-shadow-md">{clip.title}</div>
                         <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                            <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                         </div>
                         <div className="absolute bottom-1 right-2 text-[9px] bg-black/50 px-1 rounded text-white">{Math.round(clip.endTime - clip.startTime)}s</div>
                         {/* Visual waveform placeholder */}
                         <div className="absolute bottom-0 left-0 right-0 h-8 opacity-20 flex items-end gap-0.5 px-1">
                            {Array.from({length: 20}).map((_, i) => (
                               <div key={i} className="flex-1 bg-white" style={{height: `${Math.random() * 100}%`}}></div>
                            ))}
                         </div>
                      </div>
                   ))}
                   {/* Add Placeholder */}
                   <div className="h-24 w-24 rounded-md border-2 border-dashed border-slate-700 flex items-center justify-center text-slate-600 text-xs text-center px-2">
                      Tell copilot to add more
                   </div>
                </div>
             </div>
          </div>
        )}

      </div>
    </div>
  );
};

export default App;
