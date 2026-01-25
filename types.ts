
export interface Clip {
  id: string;
  title: string;
  description: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  viralityScore: number; // 1-10
  category: 'Funny' | 'Insightful' | 'Action' | 'Emotional' | 'Summary' | 'Other' | 'Custom';
  tags: string[]; // SEO Hashtags
}

export interface VideoMetadata {
  filename: string;
  duration: number;
  fileSize: number;
}

export enum AppState {
  IDLE = 'IDLE',
  UPLOADING = 'UPLOADING',
  ANALYZING = 'ANALYZING',
  READY = 'READY',
  ERROR = 'ERROR'
}

export interface AnalysisResponse {
  clips: Clip[];
  overallSummary: string;
}

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

export interface VirtualEdit {
  isActive: boolean;
  description: string;
  keepSegments: TimeRange[];
  filterStyle?: string; // CSS filter string e.g., "contrast(1.1) grayscale(1)"
  transitionEffect?: 'FADE_BLACK' | 'FLASH_WHITE' | 'ZOOM' | 'NONE';
  youtubeMetadata?: YouTubeMetadata;
}
