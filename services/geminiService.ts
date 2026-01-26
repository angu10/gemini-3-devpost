
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
        // If it's micro-garbage (0.00008), it usually means 0 relevance, but we'll default to 5 to show it.
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
            viralityScore: { type: Type.NUMBER },
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
  
  let result: AnalysisResponse;
  try {
     result = JSON.parse(text) as AnalysisResponse;
  } catch (e) {
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
  
  AVAILABLE CLIPS CONTEXT (Already found):
  ${JSON.stringify(existingClips.map(c => ({ id: c.id, title: c.title, start: c.startTime, end: c.endTime, viralityScore: c.viralityScore, category: c.category })))}

  INTENTS:
  - SEARCH: User wants to find a specific moment or topic (e.g. "Find the part about privacy").
    - FIRST: Check 'AVAILABLE CLIPS CONTEXT'. If a match is found, return that existing clip object.
    - SECOND: If NOT found in context, YOU MUST ANALYZE THE VIDEO FILE to find the specific segment.
      - Create a NEW Clip object in the 'data' field.
      - **CRITICAL**: You MUST provide accurate 'startTime' and 'endTime' (in POSITIVE SECONDS) based on the video content. 
      - **TIMESTAMPS**: If you find the topic but cannot determine the exact start time, return 'startTime': -1. DO NOT GUESS 0 or negative numbers.
      - Generate a 'title', 'description', 'viralityScore' (INTEGER 1-10), 'tags' and 'category'.
  
  - REEL_ADD: User wants to create a sequence or add clips to the reel. 
    - **CASE 1: CONTEXT EXISTS**: If 'AVAILABLE CLIPS CONTEXT' is NOT empty and user wants to add them (e.g., "Add all", "Make a reel"), return data: { all: true }.
    - **CASE 2: NO CONTEXT**: If 'AVAILABLE CLIPS CONTEXT' is EMPTY, you MUST ANALYZE the video file to find suitable clips for the request.
      - Generate a list of new clips.
      - Return data: { clips: [ ...new clips... ] }.
    - **CASE 3: SPECIFIC NEW CLIPS**: If user asks for specific moments not in context, generate them and return data: { clips: [ ... ] }.
  
  - REEL_REMOVE: Remove clip.
  - REEL_CLEAR: Clear reel.
  
  - EDIT: Visual effect OR remove audio fillers.
    - If "remove ums/fillers": 
      1. Analyze the audio transcript.
      2. Set 'intent' to 'EDIT'.
      3. Return 'keepSegments' (array of {start, end}). 
      4. STRATEGY: Return segments that CONTAIN SPEECH, effectively skipping silences and filler words (um, uh).
      5. Set filterStyle to null.
    - If visual filter requested: Set filterStyle CSS string.
  
  OUTPUT format MUST be JSON matching the schema.
  `;

  // Define data schema to be flexible but structured enough for Type.OBJECT validation
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: ['SEARCH', 'EDIT', 'REEL_ADD', 'REEL_REMOVE', 'REEL_CLEAR', 'UNKNOWN'] },
      message: { type: Type.STRING, description: "Conversational response to the user" },
      data: { 
        type: Type.OBJECT,
        nullable: true,
        properties: {
            all: { type: Type.BOOLEAN, nullable: true },
            id: { type: Type.STRING, nullable: true },
            title: { type: Type.STRING, nullable: true },
            startTime: { type: Type.NUMBER, nullable: true },
            endTime: { type: Type.NUMBER, nullable: true },
            viralityScore: { type: Type.NUMBER, nullable: true },
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
                        viralityScore: { type: Type.NUMBER },
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

  // Only use thinking budget for Pro models to avoid issues with Flash
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

  // Robust cleaning: Extract JSON object if wrapped in markdown or chat text
  let cleanedText = text.trim();
  const firstOpen = text.indexOf('{');
  const lastClose = text.lastIndexOf('}');
  
  if (firstOpen !== -1 && lastClose !== -1) {
    cleanedText = text.substring(firstOpen, lastClose + 1);
  } else if (cleanedText.startsWith('```')) {
     cleanedText = cleanedText.replace(/^```(json)?|```$/g, '');
  }
  
  let copilotResponse: CopilotResponse;
  
  try {
    copilotResponse = JSON.parse(cleanedText) as CopilotResponse;
  } catch (e) {
    console.error("JSON Parse Error on Gemini Response:", text);
    throw new Error("Failed to process AI response");
  }

  // --- Sanitize Copilot Data ---
  if (copilotResponse.data) {
      if (Array.isArray(copilotResponse.data.clips)) {
          copilotResponse.data.clips = copilotResponse.data.clips.map(sanitizeClip);
      }
      // If it returned a single clip structure in the root of data (for SEARCH intent)
      if (copilotResponse.intent === 'SEARCH' && copilotResponse.data.startTime !== undefined) {
          const sanitized = sanitizeClip(copilotResponse.data);
          copilotResponse.data = { ...copilotResponse.data, ...sanitized };
      }
  }

  return copilotResponse;
};
