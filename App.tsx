
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Clip, AppState, AnalysisResponse, SearchState, VirtualEdit } from './types';
import { MAX_FILE_SIZE_MB } from './constants';
import { analyzeVideo, processUserCommand, uploadVideo } from './services/geminiService';
import { Button } from './components/Button';
import { ClipCard } from './components/ClipCard';

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  
  // Player State
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState<boolean>(false);
  
  // Smart Features State
  const [searchState, setSearchState] = useState<SearchState>({ isSearching: false, query: '' });
  const [virtualEdit, setVirtualEdit] = useState<VirtualEdit | null>(null);
  
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("Processing...");

  const videoRef = useRef<HTMLVideoElement>(null);
  const processingVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

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
    setActiveClipId(null);
    setVirtualEdit(null);
    setSearchState({ isSearching: false, query: '' });
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
    try {
      const uri = await ensureFileUploaded(file);
      setAppState(AppState.ANALYZING);
      setStatusMessage("Identifying viral clips...");
      const data = await analyzeVideo(uri, file.type);
      setAnalysisData(data);
      setAppState(AppState.READY);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to analyze video. Please try again.");
      setAppState(AppState.ERROR);
    }
  };

  const handleCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !searchState.query.trim() || searchState.isSearching) return;

    setSearchState(prev => ({ ...prev, isSearching: true, error: null }));

    try {
      const uri = await ensureFileUploaded(file);
      
      const result = await processUserCommand(uri, file.type, searchState.query);

      if (result.type === 'CLIP') {
        // Handle Search Result
        const customClip = result.data as Clip;
        setAnalysisData(prev => {
          if (!prev) return { overallSummary: "Custom Search Results", clips: [customClip] };
          return { ...prev, clips: [customClip, ...prev.clips] };
        });
        playClip(customClip);
        setSearchState(prev => ({ ...prev, isSearching: false, query: '' }));
      } 
      else if (result.type === 'EDIT') {
        // Handle Virtual Edit / Director Mode
        
        // If keepSegments is empty, implies "Keep Everything" or logic error.
        // If the intent was "Make it black and white", we want to keep the whole video.
        // We'll fallback to [0, duration] if segments are missing but style/metadata exists.
        let finalSegments = result.data.keepSegments;
        if ((!finalSegments || finalSegments.length === 0) && videoRef.current) {
            finalSegments = [{ start: 0, end: videoRef.current.duration }];
        }

        setVirtualEdit({
          isActive: true,
          description: result.data.description,
          keepSegments: finalSegments,
          filterStyle: result.data.filterStyle,
          transitionEffect: result.data.transitionEffect,
          youtubeMetadata: result.data.youtubeMetadata
        });
        setActiveClipId(null); // Exit clip mode
        
        // Start playing from the beginning of the first valid segment
        if (videoRef.current && finalSegments.length > 0) {
          videoRef.current.currentTime = finalSegments[0].start;
          videoRef.current.play();
        }
        
        setSearchState(prev => ({ ...prev, isSearching: false, query: '' }));
      } 
      else {
        setSearchState(prev => ({ ...prev, isSearching: false, error: "I couldn't understand that request. Try 'Find...', 'Remove...', or 'Make it cinematic'" }));
      }
    } catch (err) {
      setSearchState(prev => ({ ...prev, isSearching: false, error: "Failed to process request." }));
    }
  };

  const playClip = (clip: Clip) => {
    if (!videoRef.current) return;
    setVirtualEdit(null); // Disable virtual edits when playing a specific clip
    setActiveClipId(clip.id);
    videoRef.current.currentTime = clip.startTime;
    videoRef.current.play();
  };

  const triggerTransition = () => {
    setIsTransitioning(true);
    setTimeout(() => setIsTransitioning(false), 800); // 800ms transition duration
  };

  const handleDownloadClip = async (e: React.MouseEvent, clip: Clip) => {
    e.stopPropagation();
    if (downloadingClipId) return;

    setDownloadingClipId(clip.id);
    const workerVideo = processingVideoRef.current;
    if (!workerVideo || !videoUrl) {
      setDownloadingClipId(null);
      return;
    }

    try {
      const stream = (workerVideo as any).captureStream ? (workerVideo as any).captureStream() : (workerVideo as any).mozCaptureStream();
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
      const chunks: BlobPart[] = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${clip.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setDownloadingClipId(null);
        workerVideo.pause();
        workerVideo.currentTime = 0;
        workerVideo.src = ""; 
        workerVideo.playbackRate = 1.0;
      };

      workerVideo.src = videoUrl;
      workerVideo.currentTime = clip.startTime;
      workerVideo.playbackRate = 2.0;
      
      await new Promise<void>((resolve) => {
        workerVideo.onseeked = () => {
          workerVideo.onseeked = null;
          resolve();
        };
      });

      mediaRecorder.start();
      workerVideo.play();

      const checkTime = () => {
        if (!downloadingClipId && workerVideo.paused) return;
        if (workerVideo.currentTime >= clip.endTime) {
          mediaRecorder.stop();
          workerVideo.pause();
        } else {
          requestAnimationFrame(checkTime);
        }
      };
      requestAnimationFrame(checkTime);

    } catch (err) {
      console.error("Download failed", err);
      setDownloadingClipId(null);
      alert("Browser does not support capturing video stream. Please use Chrome or Firefox.");
    }
  };

  /**
   * SMART PLAYER LOGIC
   * Handles both Clip Looping AND Virtual Edit Skipping
   */
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;
    const currentTime = videoRef.current.currentTime;

    // 1. Priority: Virtual Edit Mode (Skipping parts)
    if (virtualEdit && virtualEdit.isActive) {
      const { keepSegments } = virtualEdit;
      
      // Check if we are inside a valid segment
      const currentSegmentIndex = keepSegments.findIndex(
        seg => currentTime >= seg.start && currentTime < seg.end
      );

      // If we are INSIDE a segment, check if we are near the end of it
      if (currentSegmentIndex !== -1) {
        const currentSegment = keepSegments[currentSegmentIndex];
        // If we hit the end of this valid segment...
        if (currentTime >= currentSegment.end - 0.1) { // 0.1s buffer
             // Jump to the NEXT valid segment
             const nextSegment = keepSegments[currentSegmentIndex + 1];
             if (nextSegment) {
               if (virtualEdit.transitionEffect && virtualEdit.transitionEffect !== 'NONE') {
                  triggerTransition();
               }
               videoRef.current.currentTime = nextSegment.start;
             } else {
               // End of all segments
               videoRef.current.pause();
             }
        }
      } else {
        // If we are NOT in a valid segment (user scrubbed into a "deleted" zone)
        // Find the next upcoming valid segment
        const nextSegment = keepSegments.find(seg => seg.start > currentTime);
        if (nextSegment) {
          if (virtualEdit.transitionEffect && virtualEdit.transitionEffect !== 'NONE') {
            triggerTransition();
          }
          videoRef.current.currentTime = nextSegment.start;
        } else {
          // No more valid segments after this point
          if (!videoRef.current.paused) videoRef.current.pause();
        }
      }
      return;
    }

    // 2. Fallback: Active Clip Mode (Looping)
    if (activeClipId && analysisData) {
      const currentClip = analysisData.clips.find(c => c.id === activeClipId);
      if (!currentClip) return;

      if (currentTime >= currentClip.endTime) {
        videoRef.current.currentTime = currentClip.startTime;
        videoRef.current.play();
      }
    }
  }, [activeClipId, analysisData, virtualEdit]);

  const reset = () => {
    setFile(null);
    setVideoUrl(null);
    setFileUri(null);
    setAnalysisData(null);
    setAppState(AppState.IDLE);
    setActiveClipId(null);
    setDownloadingClipId(null);
    setVirtualEdit(null);
    setIsTransitioning(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 flex flex-col">
      <video ref={processingVideoRef} className="fixed top-0 left-0 w-1 h-1 pointer-events-none opacity-0" muted crossOrigin="anonymous"/>

      <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
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
          {file && <Button variant="secondary" onClick={reset} className="text-sm py-1">New Project</Button>}
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-6">
        {!file && (
          <div className="h-[calc(100vh-10rem)] flex flex-col items-center justify-center border-2 border-dashed border-slate-700 rounded-2xl bg-slate-800/30 hover:bg-slate-800/50 transition-colors">
            <div className="text-center p-10">
              <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
                <svg className="w-10 h-10 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold mb-2">Upload your video</h2>
              <p className="text-slate-400 mb-8 max-w-md mx-auto">Upload a video (max {MAX_FILE_SIZE_MB}MB) and let Gemini 3 Pro find the viral moments.</p>
              <input type="file" accept="video/*" className="hidden" ref={fileInputRef} onChange={handleFileChange}/>
              <Button onClick={() => fileInputRef.current?.click()} className="px-8 py-3 text-lg shadow-blue-500/20">Select Video File</Button>
              {errorMsg && <div className="mt-4 p-3 bg-red-900/30 border border-red-800 text-red-200 rounded-lg text-sm">{errorMsg}</div>}
            </div>
          </div>
        )}

        {file && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-8rem)]">
            <div className="lg:col-span-2 flex flex-col gap-4">
              <div className="relative bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-slate-800 aspect-video group">
                {videoUrl && (
                  <video 
                    ref={videoRef} 
                    src={videoUrl} 
                    className="w-full h-full object-contain transition-all duration-500" 
                    style={{ filter: virtualEdit?.filterStyle || 'none' }}
                    controls 
                    onTimeUpdate={handleTimeUpdate}
                  />
                )}
                
                {/* Transition Overlay */}
                <div 
                  className={`absolute inset-0 bg-black pointer-events-none transition-opacity duration-300 ${isTransitioning ? 'opacity-100' : 'opacity-0'}`}
                />

                {/* Visual Indicator for Active Virtual Edit / Director Mode */}
                {virtualEdit && virtualEdit.isActive && (
                  <div className="absolute top-4 right-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg backdrop-blur flex items-center gap-2 animate-pulse z-20">
                     <span>🎬 Director Mode: {virtualEdit.description}</span>
                     <button onClick={() => setVirtualEdit(null)} className="hover:text-purple-200 bg-black/20 rounded-full p-0.5"><svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                  </div>
                )}

                {(appState === AppState.ANALYZING || appState === AppState.UPLOADING) && (
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-10 flex-col">
                    <div className="relative w-24 h-24 mb-4">
                      <div className="absolute inset-0 border-t-4 border-blue-500 rounded-full animate-spin"></div>
                      <div className="absolute inset-2 border-r-4 border-purple-500 rounded-full animate-spin animation-delay-150"></div>
                      <div className="absolute inset-4 border-b-4 border-pink-500 rounded-full animate-spin animation-delay-300"></div>
                    </div>
                    <p className="text-lg font-semibold animate-pulse">{statusMessage}</p>
                    <p className="text-sm text-slate-400 mt-2">{appState === AppState.UPLOADING ? "Sending video to Gemini..." : "Identifying viral moments..."}</p>
                  </div>
                )}
              </div>

              {/* Info Bar / YouTube Metadata */}
              {virtualEdit?.youtubeMetadata ? (
                <div className="bg-gradient-to-br from-slate-800 to-slate-900 p-5 rounded-xl border border-slate-700 shadow-xl">
                  <div className="flex items-center justify-between mb-4">
                     <h3 className="text-red-500 font-bold flex items-center gap-2"><svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/></svg> YouTube Export Metadata</h3>
                     <Button variant="secondary" className="text-xs py-1 px-3">Copy</Button>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs text-slate-500 uppercase font-semibold">Title</label>
                      <p className="text-lg font-medium text-white">{virtualEdit.youtubeMetadata.title}</p>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 uppercase font-semibold">Description</label>
                      <p className="text-sm text-slate-300 whitespace-pre-wrap">{virtualEdit.youtubeMetadata.description}</p>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 uppercase font-semibold">Tags</label>
                      <div className="flex flex-wrap gap-2 mt-1">
                        {virtualEdit.youtubeMetadata.tags.map(tag => (
                          <span key={tag} className="text-xs bg-slate-700/50 text-blue-300 px-2 py-1 rounded-full">#{tag}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                /* Default Info Bar */
                <div className="flex items-center justify-between bg-slate-800 p-4 rounded-xl border border-slate-700">
                  <div>
                    <h3 className="font-semibold text-slate-200 truncate max-w-md">{file.name}</h3>
                    <p className="text-xs text-slate-400">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                  </div>
                  {!analysisData && appState !== AppState.ANALYZING && appState !== AppState.UPLOADING && (
                    <Button onClick={handleAnalyze} className="shadow-lg shadow-blue-500/20"><span className="mr-2">✨</span> Generate Clips</Button>
                  )}
                  {analysisData && <div className="text-sm text-slate-400">Found <span className="text-white font-bold">{analysisData.clips.length}</span> clips</div>}
                </div>
              )}

              {analysisData?.overallSummary && !virtualEdit?.youtubeMetadata && (
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Video Summary</h4>
                  <p className="text-slate-300 text-sm leading-relaxed">{analysisData.overallSummary}</p>
                </div>
              )}
            </div>

            <div className="lg:col-span-1 bg-slate-800/30 rounded-2xl border border-slate-700/50 flex flex-col overflow-hidden">
              <div className="p-4 border-b border-slate-700 bg-slate-800/80 backdrop-blur">
                <form onSubmit={handleCommand} className="relative">
                  <input
                    type="text"
                    placeholder="Search OR 'Make it cinematic...'"
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg pl-4 pr-10 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-500 transition-all"
                    value={searchState.query}
                    onChange={(e) => setSearchState(prev => ({ ...prev, query: e.target.value }))}
                    disabled={searchState.isSearching || appState === AppState.ANALYZING || appState === AppState.UPLOADING}
                  />
                  <button type="submit" disabled={searchState.isSearching || !searchState.query.trim()} className="absolute right-1.5 top-1.5 p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                    {searchState.isSearching ? (
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                    )}
                  </button>
                </form>
                {searchState.error && <p className="text-xs text-red-400 mt-2 ml-1">{searchState.error}</p>}
                <div className="mt-2 flex gap-2 flex-wrap">
                  <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Try:</span>
                  <button onClick={() => setSearchState(p => ({...p, query: "Make it look cinematic & professional"}))} className="text-[10px] text-purple-400 hover:text-purple-300 bg-purple-900/20 px-1.5 py-0.5 rounded border border-purple-900/50 transition-colors">"Cinematic Look"</button>
                  <button onClick={() => setSearchState(p => ({...p, query: "Remove silences and ums"}))} className="text-[10px] text-blue-400 hover:text-blue-300 bg-blue-900/20 px-1.5 py-0.5 rounded border border-blue-900/50 transition-colors">"Remove 'um'"</button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                {appState === AppState.ERROR && (
                   <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200 text-sm">
                     {errorMsg}
                     <Button variant="secondary" onClick={handleAnalyze} className="w-full mt-3">Retry Analysis</Button>
                   </div>
                )}
                {!analysisData && appState !== AppState.ANALYZING && appState !== AppState.UPLOADING && (
                  <div className="flex flex-col items-center justify-center h-full text-slate-500 opacity-60">
                     <svg className="w-12 h-12 mb-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                       <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                     </svg>
                     <p className="text-sm">Ready to analyze audio & video</p>
                  </div>
                )}
                {analysisData && analysisData.clips.map((clip) => (
                  <ClipCard 
                    key={clip.id} 
                    clip={clip} 
                    isActive={activeClipId === clip.id}
                    isDownloading={downloadingClipId === clip.id}
                    onClick={() => playClip(clip)}
                    onDownload={(e) => handleDownloadClip(e, clip)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
