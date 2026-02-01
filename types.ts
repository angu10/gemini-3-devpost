
export interface Clip {
  id: string;
  title: string;
  description: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  category: 'Funny' | 'Insightful' | 'Action' | 'Emotional' | 'Summary' | 'Other' | 'Custom';
  tags: string[]; // SEO Hashtags
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface VideoMetadata {
  id: string; // generated from filename + size
  filename: string;
  fileSize: number;
  uploadDate: number;
  transcript: TranscriptSegment[];
  analysis: AnalysisResponse;
  modelUsed: string;
}

export enum AppState {
  IDLE = 'IDLE',
  CHECKING_DB = 'CHECKING_DB',
  UPLOADING = 'UPLOADING',
  ANALYZING = 'ANALYZING',
  READY = 'READY',
  ERROR = 'ERROR'
}

export interface AnalysisResponse {
  clips: Clip[];
  overallSummary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export type PlayerMode = 'FULL' | 'SINGLE' | 'REEL';

export interface SearchState {
  isSearching: boolean;
  query: string;
  error?: string | null;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface YouTubeMetadata {
  title: string;
  description: string;
  tags: string[];
}

// New Editing Types
export interface ClipOverlay {
  type: 'TEXT' | 'EMOJI' | 'IMAGE';
  content: string; // The text, emoji char, or image URL
  position: 'TOP' | 'BOTTOM' | 'CENTER' | 'TOP_RIGHT' | 'TOP_LEFT' | 'BOTTOM_RIGHT' | 'BOTTOM_LEFT';
}

export interface ClipEdit {
  id: string; // ID of the clip this edit belongs to
  filterStyle?: string; // CSS filter string
  subtitles?: string; // Translated or transcribed text to show
  overlay?: ClipOverlay;
}

export interface VirtualEdit {
  isActive: boolean;
  description: string;
  keepSegments: TimeRange[];
  filterStyle?: string; 
  transitionEffect?: 'FADE_BLACK' | 'FLASH_WHITE' | 'ZOOM' | 'NONE';
  youtubeMetadata?: YouTubeMetadata;
}

export interface CopilotResponse {
  intent: 'SEARCH' | 'EDIT' | 'REEL_ADD' | 'REEL_REMOVE' | 'REEL_CLEAR' | 'CLIP_EDIT' | 'UNKNOWN';
  message: string;
  data?: any;
}
