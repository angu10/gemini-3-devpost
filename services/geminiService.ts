import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip, CopilotResponse } from '../types';

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

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
    model: GEMINI_MODEL,
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
  
  return JSON.parse(text) as AnalysisResponse;
};

/**
 * Processes chat commands for the video copilot.
 */
export const processUserCommand = async (
  fileUri: string,
  mimeType: string,
  userMessage: string,
  existingClips: Clip[]
): Promise<CopilotResponse> => {

  const systemPrompt = `
  You are a video editing assistant (Highlight Reel Copilot). 
  Your goal is to interpret the user's request and map it to an action (intent).
  
  AVAILABLE CLIPS CONTEXT:
  ${JSON.stringify(existingClips.map(c => ({ id: c.id, title: c.title, start: c.startTime, end: c.endTime, viralityScore: c.viralityScore, category: c.category })))}

  INTENTS:
  - SEARCH: User wants to find a specific moment. Data: The Clip object found.
  - REEL_ADD: User wants to create a sequence or add clips to the reel. 
    - Data: { clips: [Array of Clip objects] }. 
    - IMPORTANT: If the user asks to "make a reel of funny clips" or "create a summary", SELECT multiple matching items from the AVAILABLE CLIPS CONTEXT and return them in the 'clips' array.
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

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { fileData: { fileUri: fileUri, mimeType: mimeType } },
          { text: `${systemPrompt}\n\nUSER REQUEST: ${userMessage}` },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema,
      // We set a moderate thinking budget. 0 disables it, which breaks complex tasks like "remove ums"
      // because the model needs reasoning to segment audio. 2048 is a good balance for speed vs capability.
      thinkingConfig: { thinkingBudget: 2048 } 
    },
  });

  const text = response.text;
  if (!text) throw new Error("No response from Gemini");

  // Robust cleaning for potential markdown code blocks
  let cleanedText = text.trim();
  // Remove markdown wrapping if present
  if (cleanedText.startsWith('```')) {
    cleanedText = cleanedText.replace(/^```(json)?|```$/g, '');
  }
  
  try {
    return JSON.parse(cleanedText) as CopilotResponse;
  } catch (e) {
    console.error("JSON Parse Error on Gemini Response:", text);
    throw new Error("Failed to process AI response");
  }
};