
import { GoogleGenAI, Type } from "@google/genai";
import { SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip, CopilotResponse } from '../types';

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Helper: Sanitize Clip Data ---
const sanitizeClip = (clip: any): Clip => {
    let start = Number(clip.startTime);
    let end = Number(clip.endTime);

    // Fix Timestamps
    if (!Number.isFinite(start) || start < 0) start = 0;
    
    // If end is missing, invalid, or less than start, give it a default duration (15s)
    if (!Number.isFinite(end) || end <= start) {
        end = start + 15;
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
        category,
        tags
    };
};

// --- Helper: Robust JSON Parser ---
const parseJSONSafely = (text: string): any => {
    // 1. Try cleaning markdown code blocks
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(json)?|```$/g, '');
    }
    
    // 2. Remove extremely long float precision (prevents some parser errors)
    cleanedText = cleanedText.replace(/(\d+\.\d{3})\d{5,}/g, "$1");

    // 3. Extract JSON object if embedded in other text
    const firstOpen = cleanedText.indexOf('{');
    const lastClose = cleanedText.lastIndexOf('}');
    
    if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
        cleanedText = cleanedText.substring(firstOpen, lastClose + 1);
    } else if (firstOpen !== -1) {
        // Truncated JSON case: starts with { but no closing } found
        cleanedText = cleanedText.substring(firstOpen);
    }

    try {
        return JSON.parse(cleanedText);
    } catch (e) {
        console.warn("Standard JSON parse failed, attempting auto-repair for truncated JSON...");
        
        // 4. Auto-repair truncated JSON
        // This is a basic heuristic to close open strings and brackets/braces
        let fixed = cleanedText.trim();
        const stack: string[] = [];
        let inString = false;
        let isEscaped = false;

        for (let i = 0; i < fixed.length; i++) {
            const char = fixed[i];
            
            if (inString) {
                if (char === '\\' && !isEscaped) {
                    isEscaped = true;
                } else if (char === '"' && !isEscaped) {
                    inString = false;
                } else {
                    isEscaped = false;
                }
            } else {
                if (char === '"') {
                    inString = true;
                } else if (char === '{' || char === '[') {
                    stack.push(char);
                } else if (char === '}') {
                    if (stack[stack.length - 1] === '{') stack.pop();
                } else if (char === ']') {
                    if (stack[stack.length - 1] === '[') stack.pop();
                }
            }
        }

        // Close open string
        if (inString) fixed += '"';

        // Close open structures in reverse order
        while (stack.length > 0) {
            const open = stack.pop();
            if (open === '{') fixed += '}';
            if (open === '[') fixed += ']';
        }

        try {
            return JSON.parse(fixed);
        } catch (repairError) {
            console.error("JSON Repair Failed:", repairError);
            console.error("Original Text:", text.substring(0, 500) + "...");
            throw new Error("Failed to parse response from Gemini.");
        }
    }
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
            category: { type: Type.STRING, enum: ['Funny', 'Insightful', 'Action', 'Emotional', 'Summary', 'Other', 'Custom'] },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['id', 'title', 'description', 'startTime', 'endTime', 'category', 'tags'],
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
  
  let result: AnalysisResponse;
  try {
     result = parseJSONSafely(text) as AnalysisResponse;
  } catch (e) {
     throw e;
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
      - **CRITICAL**: Keep 'title' under 10 words.
      - **CRITICAL**: Keep 'description' under 20 words.
  
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

  let copilotResponse: CopilotResponse;
  
  try {
    copilotResponse = parseJSONSafely(text) as CopilotResponse;
  } catch (e) {
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
