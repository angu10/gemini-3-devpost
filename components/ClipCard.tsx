
import React from 'react';
import { Clip } from '../types';

interface ClipCardProps {
  clip: Clip;
  isActive: boolean;
  isDownloading: boolean;
  onClick: () => void;
  onDownload: (e: React.MouseEvent) => void;
}

export const ClipCard: React.FC<ClipCardProps> = ({ 
  clip, 
  isActive, 
  isDownloading,
  onClick, 
  onDownload 
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div 
      onClick={onClick}
      className={`
        p-4 rounded-xl cursor-pointer border transition-all duration-200 relative overflow-hidden group
        ${isActive 
          ? 'bg-blue-900/20 border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.2)]' 
          : 'bg-slate-800 border-slate-700 hover:border-slate-500 hover:bg-slate-750'
        }
      `}
    >
      {/* Active Indicator Bar */}
      {isActive && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500"></div>
      )}

      <div className="flex justify-between items-start mb-1">
        <h3 className={`font-semibold text-sm ${isActive ? 'text-blue-200' : 'text-slate-100'} pr-8`}>
          {clip.title}
        </h3>
      </div>

      <p className="text-xs text-slate-400 line-clamp-2 mb-2">
        {clip.description}
      </p>

      {/* Tags Section */}
      {clip.tags && clip.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {clip.tags.slice(0, 3).map((tag, idx) => (
            <span key={idx} className="text-[10px] text-blue-300 bg-blue-500/10 px-1.5 py-0.5 rounded-full border border-blue-500/20">
              #{tag.replace(/^#/, '')}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-slate-500">
        <div className="flex items-center space-x-2">
          <span className="bg-slate-700/50 px-1.5 py-0.5 rounded text-slate-300">
            {formatTime(clip.startTime)} - {formatTime(clip.endTime)}
          </span>
          <span className="text-slate-600">
             • {Math.round(clip.endTime - clip.startTime)}s
          </span>
        </div>
        <span className="uppercase tracking-wider text-[10px] font-medium opacity-70">
          {clip.category}
        </span>
      </div>

      {/* Download Button - Visible on hover or when downloading */}
      <button
        onClick={onDownload}
        disabled={isDownloading}
        className={`
          absolute top-2 right-2 p-1.5 rounded-lg
          bg-slate-700/80 hover:bg-blue-600 text-white shadow-lg backdrop-blur-sm
          transition-all duration-200
          ${isDownloading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
        `}
        title="Download Clip"
      >
        {isDownloading ? (
          <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        )}
      </button>
    </div>
  );
};

export const SkeletonClipCard: React.FC = () => {
  return (
    <div className="p-4 rounded-xl border border-slate-800 bg-slate-800/50 animate-pulse relative">
      <div className="flex justify-between items-start mb-3">
        <div className="h-4 bg-slate-700 rounded w-2/3"></div>
      </div>
      <div className="space-y-2 mb-4">
        <div className="h-2 bg-slate-700/50 rounded w-full"></div>
        <div className="h-2 bg-slate-700/50 rounded w-5/6"></div>
      </div>
      <div className="flex gap-2 mb-3">
        <div className="h-3 bg-slate-700/30 rounded w-12"></div>
        <div className="h-3 bg-slate-700/30 rounded w-16"></div>
      </div>
      <div className="flex justify-between items-center mt-2">
        <div className="h-3 bg-slate-700 rounded w-24"></div>
        <div className="h-3 bg-slate-700 rounded w-16"></div>
      </div>
    </div>
  );
};
