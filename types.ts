export interface Clip {
  id: string;
  title: string;
  description: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  viralityScore: number; // 1-10
  category: 'Funny' | 'Insightful' | 'Action' | 'Summary' | 'Other' | 'Custom';
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