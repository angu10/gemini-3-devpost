
import { GoogleGenAI, Type } from "@google/genai";
import { SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip, CopilotResponse } from '../types';

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Helper: Sanitize Clip Data ---
const sanitizeClip = (clip: any): Clip => {
    let start = Number(clip.startTime);
    let end = Number(clip.endTime);
    let score = Number(clip.viralityScore);

    // Fix Timestamps
    if (!Number.isFinite(start) || start < 0) start = 0;
    
    // If end is missing, invalid, or less than start, give it a default duration (15s)
    if (!Number.isFinite(end) || end <= start) {
        end = start + 15;
    }

    // Fix Score: Handle weird hallucinations like 0.00008 or >10
    if (!Number.isFinite(score)) {
        score = 5;
    } else {
        // If score is normalized (0.0 to 1.0), scale it up. 
        if (score > 0 && score <= 1) {
            score = Math.round(score * 10);
        }
        // Clamp 1-10
        if (score < 1) score = 1;
        if (score > 10) score = 10;
        score = Math.round(score);
    }

    // Ensure strings
    const title = clip.title ? String(clip.title) : "Untitled Clip";
    const description = clip.description ? String(clip.description) : "No description provided.";
    const category = clip.category || 'Other';
    const tags = Array.isArray(clip.tags) ? clip.tags.map(String) : [];

    return {
        id: clip.id || `gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title,
        description,
        startTime: start,
        endTime: end,
        viralityScore: score,
        category,
        tags
    };
};

/**
 * Uploads a file to the Gemini File API and waits for it to be processed.
 */
export const uploadVideo = async (file: File, onProgress?: (msg: string) => void): Promise<string> => {
  if (onProgress) onProgress("Uploading video to Gemini...");
  
  const uploadResult = await ai.files.upload({
    file: file,
    config: { displayName: file.name },
  });

  let fileInfo = await ai.files.get({ name: uploadResult.name });
  
  if (onProgress) onProgress("Processing video...");
  
  let attempts = 0;
  const maxAttempts = 60; // 2 minutes max waiting (2s interval)

  while (fileInfo.state === 'PROCESSING') {
    if (attempts >= maxAttempts) {
        throw new Error("Video processing timed out. Please try a smaller file or try again later.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    fileInfo = await ai.files.get({ name: uploadResult.name });
    attempts++;
  }

  if (fileInfo.state === 'FAILED') {
    throw new Error('Video processing failed.');
  }

  if (onProgress) onProgress("Ready for analysis.");
  return fileInfo.uri;
};

/**
 * Analyzes the video to find viral clips.
 */
export const analyzeVideo = async (
  fileUri: string, 
  mimeType: string,
  modelName: string,
  onPartial?: (clips: Clip[]) => void
): Promise<AnalysisResponse> => {
  // Schema definition for the analysis response
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      overallSummary: { type: Type.STRING },
      clips: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            startTime: { type: Type.NUMBER },
            endTime: { type: Type.NUMBER },
            viralityScore: { type: Type.INTEGER }, // Changed from NUMBER to INTEGER
            category: { type: Type.STRING, enum: ['Funny', 'Insightful', 'Action', 'Emotional', 'Summary', 'Other', 'Custom'] },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['id', 'title', 'description', 'startTime', 'endTime', 'viralityScore', 'category', 'tags'],
        },
      },
    },
    required: ['overallSummary', 'clips'],
  };

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: fileUri, mimeType: mimeType } },
          { text: SAMPLE_PROMPT },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema,
    },
  });

  const text = response.text;
  if (!text) throw new Error("No response from Gemini");
  
  // Clean JSON before parsing
  let fixedText = text.trim();
  // Strip markdown code blocks
  if (fixedText.startsWith('```')) {
     fixedText = fixedText.replace(/^```(json)?|```$/g, '');
  }
  
  // Truncate long floats for timestamps (e.g. 123.456789 -> 123.456)
  // We no longer strictly regex replace viralityScore here because Type.INTEGER handles it,
  // but we keep the timestamp cleaner for safety.
  fixedText = fixedText.replace(/(\d+\.\d{3})\d{5,}/g, "$1");

  let result: AnalysisResponse;
  try {
     result = JSON.parse(fixedText) as AnalysisResponse;
  } catch (e) {
     console.error("JSON Parse Error (Analysis):", fixedText.substring(0, 500));
     throw new Error("Failed to parse analysis results.");
  }

  // Sanitize the output
  if (result.clips && Array.isArray(result.clips)) {
      result.clips = result.clips.map(sanitizeClip);
  } else {
      result.clips = [];
  }

  return result;
};

/**
 * Processes chat commands for the video copilot.
 */
export const processUserCommand = async (
  fileUri: string,
  mimeType: string,
  userMessage: string,
  existingClips: Clip[],
  modelName: string
): Promise<CopilotResponse> => {

  const systemPrompt = `
  You are a video editing assistant (Highlight Reel Copilot). 
  Your goal is to interpret the user's request and map it to an action (intent).
  
  AVAILABLE CLIPS: ${existingClips.length} clips found.
  Top clips: ${existingClips.slice(0, 3).map(c => c.title).join(', ')}

  SPEED PRIORITY:
  - For SEARCH: Return result in <5 seconds.
  - If query matches existing clip titles, use context immediately.
  - Only deep-analyze video if no context match.

  INTENTS:
  - SEARCH: User wants to find a specific moment or topic.
    - FIRST: Check 'AVAILABLE CLIPS' titles. If match, return that existing clip.
    - SECOND: If NOT found, ANALYZE VIDEO FILE.
      - Create NEW Clip in 'data'.
      - **CRITICAL**: Accurate 'startTime' and 'endTime' (POSITIVE SECONDS).
      - 'viralityScore' must be INTEGER (1-10).
  
  - REEL_ADD: User wants to create sequence/add clips.
    - If existingClips.length > 0 and user wants "all": return data: { all: true }.
    - Otherwise: Analyze video, return data: { clips: [ ...new... ] }.
  
  - REEL_REMOVE: Remove clip.
  - REEL_CLEAR: Clear reel.
  
  - EDIT: Visual effect OR remove audio fillers.
    - "remove ums": Analyze audio, return 'keepSegments' (parts WITH speech).
    - Visual filter: Set filterStyle.
  
  OUTPUT format MUST be JSON matching the schema.
  `;

  // Define data schema
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: ['SEARCH', 'EDIT', 'REEL_ADD', 'REEL_REMOVE', 'REEL_CLEAR', 'UNKNOWN'] },
      message: { type: Type.STRING },
      data: { 
        type: Type.OBJECT,
        nullable: true,
        properties: {
            all: { type: Type.BOOLEAN, nullable: true },
            id: { type: Type.STRING, nullable: true },
            title: { type: Type.STRING, nullable: true },
            startTime: { type: Type.NUMBER, nullable: true },
            endTime: { type: Type.NUMBER, nullable: true },
            viralityScore: { type: Type.INTEGER, nullable: true }, // Changed from NUMBER to INTEGER
            description: { type: Type.STRING, nullable: true },
            filterStyle: { type: Type.STRING, nullable: true },
            index: { type: Type.NUMBER, nullable: true },
            tags: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
            keepSegments: { 
              type: Type.ARRAY, 
              nullable: true,
              items: {
                type: Type.OBJECT,
                properties: {
                  start: { type: Type.NUMBER },
                  end: { type: Type.NUMBER }
                }
              }
            },
            clips: {
                type: Type.ARRAY,
                nullable: true,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        startTime: { type: Type.NUMBER },
                        endTime: { type: Type.NUMBER },
                        viralityScore: { type: Type.INTEGER }, // Changed from NUMBER to INTEGER
                        description: { type: Type.STRING },
                        tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                        category: { type: Type.STRING, nullable: true }
                    }
                }
            }
        }
      },
    },
    required: ['intent', 'message'],
  };

  const config: any = {
    responseMimeType: 'application/json',
    responseSchema: responseSchema,
  };

  // Only use thinking budget for Pro models
  if (modelName.toLowerCase().includes('pro')) {
     config.thinkingConfig = { thinkingBudget: 2048 };
  }

  const response = await ai.models.generateContent({
    model: modelName,
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: fileUri, mimeType: mimeType } },
          { text: `${systemPrompt}\n\nUSER REQUEST: ${userMessage}` },
        ],
      },
    ],
    config: config,
  });

  const text = response.text;
  if (!text) throw new Error("No response from Gemini");

  let cleanedText = text.trim();
  const firstOpen = text.indexOf('{');
  const lastClose = text.lastIndexOf('}');
  
  if (firstOpen !== -1 && lastClose !== -1) {
    cleanedText = text.substring(firstOpen, lastClose + 1);
  } else if (cleanedText.startsWith('```')) {
     cleanedText = cleanedText.replace(/^```(json)?|```$/g, '');
  }
  
  // Clean potentially extremely long floats from timestamps
  cleanedText = cleanedText.replace(/(\d+\.\d{3})\d{5,}/g, "$1");

  let copilotResponse: CopilotResponse;
  
  try {
    copilotResponse = JSON.parse(cleanedText) as CopilotResponse;
  } catch (e) {
    console.error("JSON Parse Error on Gemini Response:", text.substring(0, 500));
    throw new Error("Failed to process AI response");
  }

  // --- Sanitize Copilot Data ---
  if (copilotResponse.data) {
      if (Array.isArray(copilotResponse.data.clips)) {
          copilotResponse.data.clips = copilotResponse.data.clips.map(sanitizeClip);
      }
      if (copilotResponse.intent === 'SEARCH' && copilotResponse.data.startTime !== undefined) {
          const sanitized = sanitizeClip(copilotResponse.data);
          copilotResponse.data = { ...copilotResponse.data, ...sanitized };
      }
  }

  return copilotResponse;
};
