import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Clip, AppState, AnalysisResponse, SearchState } from './types';
import { MAX_FILE_SIZE_MB } from './constants';
import { analyzeVideo, findMomentInVideo } from './services/geminiService';
import { Button } from './components/Button';
import { ClipCard } from './components/ClipCard';

const App: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [analysisData, setAnalysisData] = useState<AnalysisResponse | null>(null);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  // Search State
  const [searchState, setSearchState] = useState<SearchState>({ isSearching: false, query: '' });

  const videoRef = useRef<HTMLVideoElement>(null);
  const processingVideoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cleanup object URL on unmount
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
    setAppState(AppState.READY);
    setErrorMsg(null);
    setAnalysisData(null);
    setActiveClipId(null);
    setSearchState({ isSearching: false, query: '' });
  };

  const handleAnalyze = async () => {
    if (!file) return;

    setAppState(AppState.ANALYZING);
    setErrorMsg(null);

    try {
      const data = await analyzeVideo(file);
      setAnalysisData(data);
      setAppState(AppState.READY);
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Failed to analyze video. Please try again.");
      setAppState(AppState.ERROR);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !searchState.query.trim() || searchState.isSearching) return;

    setSearchState(prev => ({ ...prev, isSearching: true, error: null }));

    try {
      const customClip = await findMomentInVideo(file, searchState.query);
      
      if (customClip) {
        setAnalysisData(prev => {
          if (!prev) return { overallSummary: "Custom Search Results", clips: [customClip] };
          return {
            ...prev,
            clips: [customClip, ...prev.clips] // Add to top
          };
        });
        // Auto play the new clip
        setActiveClipId(customClip.id);
        if (videoRef.current) {
          videoRef.current.currentTime = customClip.startTime;
          videoRef.current.play();
        }
        setSearchState(prev => ({ ...prev, isSearching: false, query: '' })); // Clear query on success
      } else {
        setSearchState(prev => ({ ...prev, isSearching: false, error: "No matching moment found." }));
      }
    } catch (err) {
      setSearchState(prev => ({ ...prev, isSearching: false, error: "Failed to search video." }));
    }
  };

  const playClip = (clip: Clip) => {
    if (!videoRef.current) return;
    
    setActiveClipId(clip.id);
    videoRef.current.currentTime = clip.startTime;
    videoRef.current.play();
  };

  const handleDownloadClip = async (e: React.MouseEvent, clip: Clip) => {
    e.stopPropagation(); // Prevent playing the clip when clicking download
    if (downloadingClipId) return; // Prevent multiple downloads at once

    setDownloadingClipId(clip.id);
    
    const workerVideo = processingVideoRef.current;
    if (!workerVideo || !videoUrl) {
      setDownloadingClipId(null);
      return;
    }

    try {
      // Setup the recorder
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
        
        // Reset worker video
        workerVideo.pause();
        workerVideo.currentTime = 0;
        workerVideo.src = ""; 
        workerVideo.playbackRate = 1.0;
      };

      // Prepare video for recording
      workerVideo.src = videoUrl;
      workerVideo.currentTime = clip.startTime;
      workerVideo.playbackRate = 2.0; // Speed up processing
      
      // Wait for seek to complete
      await new Promise<void>((resolve) => {
        workerVideo.onseeked = () => {
          workerVideo.onseeked = null;
          resolve();
        };
      });

      mediaRecorder.start();
      workerVideo.play();

      // Monitor end time
      const checkTime = () => {
        if (!downloadingClipId && workerVideo.paused) return; // Abort check if cancelled
        
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

  // Monitor playback to loop current clip or stop at end
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current || !activeClipId || !analysisData) return;

    const currentClip = analysisData.clips.find(c => c.id === activeClipId);
    if (!currentClip) return;

    if (videoRef.current.currentTime >= currentClip.endTime) {
      // Loop the clip
      videoRef.current.currentTime = currentClip.startTime;
      videoRef.current.play();
    }
  }, [activeClipId, analysisData]);

  const reset = () => {
    setFile(null);
    setVideoUrl(null);
    setAnalysisData(null);
    setAppState(AppState.IDLE);
    setActiveClipId(null);
    setDownloadingClipId(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 flex flex-col">
      {/* Hidden video element for processing downloads */}
      <video 
        ref={processingVideoRef} 
        className="fixed top-0 left-0 w-1 h-1 pointer-events-none opacity-0" 
        muted 
        crossOrigin="anonymous"
      />

      {/* Header */}
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
          {file && (
            <Button variant="secondary" onClick={reset} className="text-sm py-1">
              New Project
            </Button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full p-6">
        
        {/* State: IDLE / Upload */}
        {!file && (
          <div className="h-[calc(100vh-10rem)] flex flex-col items-center justify-center border-2 border-dashed border-slate-700 rounded-2xl bg-slate-800/30 hover:bg-slate-800/50 transition-colors">
            <div className="text-center p-10">
              <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
                <svg className="w-10 h-10 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h2 className="text-2xl font-semibold mb-2">Upload your video</h2>
              <p className="text-slate-400 mb-8 max-w-md mx-auto">
                Upload a video (max {MAX_FILE_SIZE_MB}MB) and let Gemini 3 Pro find the viral moments for you.
              </p>
              
              <input 
                type="file" 
                accept="video/*" 
                className="hidden" 
                ref={fileInputRef}
                onChange={handleFileChange}
              />
              <Button onClick={() => fileInputRef.current?.click()} className="px-8 py-3 text-lg shadow-blue-500/20">
                Select Video File
              </Button>
              {errorMsg && (
                <div className="mt-4 p-3 bg-red-900/30 border border-red-800 text-red-200 rounded-lg text-sm">
                  {errorMsg}
                </div>
              )}
            </div>
          </div>
        )}

        {/* State: Ready / Analyzing / Results */}
        {file && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-8rem)]">
            
            {/* Left Column: Video Player */}
            <div className="lg:col-span-2 flex flex-col gap-4">
              <div className="relative bg-black rounded-2xl overflow-hidden shadow-2xl ring-1 ring-slate-800 aspect-video group">
                {videoUrl && (
                  <video 
                    ref={videoRef}
                    src={videoUrl}
                    className="w-full h-full object-contain"
                    controls
                    onTimeUpdate={handleTimeUpdate}
                  />
                )}
                
                {/* Overlay while analyzing */}
                {appState === AppState.ANALYZING && (
                  <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-10 flex-col">
                    <div className="relative w-24 h-24 mb-4">
                      <div className="absolute inset-0 border-t-4 border-blue-500 rounded-full animate-spin"></div>
                      <div className="absolute inset-2 border-r-4 border-purple-500 rounded-full animate-spin animation-delay-150"></div>
                      <div className="absolute inset-4 border-b-4 border-pink-500 rounded-full animate-spin animation-delay-300"></div>
                    </div>
                    <p className="text-lg font-semibold animate-pulse">Gemini is watching your video...</p>
                    <p className="text-sm text-slate-400 mt-2">Identifying viral moments</p>
                  </div>
                )}
              </div>

              {/* Action Bar */}
              <div className="flex items-center justify-between bg-slate-800 p-4 rounded-xl border border-slate-700">
                <div>
                  <h3 className="font-semibold text-slate-200 truncate max-w-md">{file.name}</h3>
                  <p className="text-xs text-slate-400">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                </div>
                
                {!analysisData && appState !== AppState.ANALYZING && (
                  <Button onClick={handleAnalyze} className="shadow-lg shadow-blue-500/20">
                    <span className="mr-2">✨</span> Generate Clips
                  </Button>
                )}

                {analysisData && (
                  <div className="text-sm text-slate-400">
                    Found <span className="text-white font-bold">{analysisData.clips.length}</span> clips
                  </div>
                )}
              </div>

              {/* Summary Box */}
              {analysisData?.overallSummary && (
                <div className="bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Video Summary</h4>
                  <p className="text-slate-300 text-sm leading-relaxed">{analysisData.overallSummary}</p>
                </div>
              )}
            </div>

            {/* Right Column: Clip List */}
            <div className="lg:col-span-1 bg-slate-800/30 rounded-2xl border border-slate-700/50 flex flex-col overflow-hidden">
              {/* Search Bar Section */}
              <div className="p-4 border-b border-slate-700 bg-slate-800/80 backdrop-blur">
                <form onSubmit={handleSearch} className="relative">
                  <input
                    type="text"
                    placeholder="Describe a moment to find... (e.g., 'When he laughs')"
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg pl-4 pr-10 py-2.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 placeholder-slate-500 transition-all"
                    value={searchState.query}
                    onChange={(e) => setSearchState(prev => ({ ...prev, query: e.target.value }))}
                    disabled={searchState.isSearching || appState === AppState.ANALYZING}
                  />
                  <button 
                    type="submit"
                    disabled={searchState.isSearching || !searchState.query.trim()}
                    className="absolute right-1.5 top-1.5 p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {searchState.isSearching ? (
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    )}
                  </button>
                </form>
                {searchState.error && (
                  <p className="text-xs text-red-400 mt-2 ml-1">{searchState.error}</p>
                )}
              </div>

              {/* Results List */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                {appState === AppState.ERROR && (
                   <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200 text-sm">
                     {errorMsg}
                     <Button variant="secondary" onClick={handleAnalyze} className="w-full mt-3">Retry Analysis</Button>
                   </div>
                )}

                {!analysisData && appState !== AppState.ANALYZING && (
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