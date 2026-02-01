
import { GoogleGenAI, Type } from "@google/genai";
import { SAMPLE_PROMPT, MODELS } from '../constants';
import { AnalysisResponse, Clip, CopilotResponse, TranscriptSegment } from '../types';

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

    // Constraint: Max 30 seconds
    if (end - start > 30) {
        end = start + 30;
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
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(json)?|```$/g, '');
    }
    
    // Remove extremely long float precision
    cleanedText = cleanedText.replace(/(\d+\.\d{3})\d{5,}/g, "$1");

    // Extract JSON object
    const firstOpen = cleanedText.indexOf('{');
    const lastClose = cleanedText.lastIndexOf('}');
    const firstArray = cleanedText.indexOf('[');
    const lastArray = cleanedText.lastIndexOf(']');

    // Check if it's an array or object
    if (firstArray !== -1 && lastArray !== -1 && (firstOpen === -1 || firstArray < firstOpen)) {
         cleanedText = cleanedText.substring(firstArray, lastArray + 1);
    } else if (firstOpen !== -1 && lastClose !== -1) {
        cleanedText = cleanedText.substring(firstOpen, lastClose + 1);
    }

    try {
        return JSON.parse(cleanedText);
    } catch (e) {
        console.warn("JSON Parse failed, attempting cleanup...");
        try {
            // Very basic cleanup for trailing commas
            return JSON.parse(cleanedText.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
        } catch (e2) {
             throw new Error("Failed to parse Gemini response");
        }
    }
};

/**
 * Uploads a file to the Gemini File API.
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
  const maxAttempts = 60; // 2 minutes

  while (fileInfo.state === 'PROCESSING') {
    if (attempts >= maxAttempts) {
        throw new Error("Video processing timed out.");
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
 * PASS 1: Extract Transcript (Cheap/Fast using Flash)
 */
export const extractTranscript = async (
    fileUri: string,
    mimeType: string
): Promise<TranscriptSegment[]> => {
    console.log("🎙️ Pass 1: Extracting Transcript...");
    
    const transcriptSchema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: {
                start: { type: Type.NUMBER },
                end: { type: Type.NUMBER },
                text: { type: Type.STRING },
                speaker: { type: Type.STRING }
            },
            required: ['start', 'text']
        }
    };

    const response = await ai.models.generateContent({
        model: MODELS.FLASH, // Use Flash for speed/cost
        contents: [
            {
                role: 'user',
                parts: [
                    { fileData: { fileUri: fileUri, mimeType: mimeType } },
                    { text: "Generate a detailed timestamped transcript of this video. Group sentences meaningfully." },
                ],
            },
        ],
        config: {
            responseMimeType: 'application/json',
            responseSchema: transcriptSchema,
        },
    });

    const text = response.text;
    if (!text) return [];

    try {
        return parseJSONSafely(text) as TranscriptSegment[];
    } catch (e) {
        console.warn("Failed to parse transcript", e);
        return [];
    }
};

/**
 * PASS 2: Analyze Visuals (Expensive/Smart using Pro)
 */
export const analyzeVideo = async (
  fileUri: string, 
  mimeType: string,
  modelName: string,
  onPartial?: (clips: Clip[]) => void
): Promise<{ analysis: AnalysisResponse, transcript: TranscriptSegment[] }> => {
  
  // 1. Parallel Execution: Start Transcript extraction (Pass 1)
  const transcriptPromise = extractTranscript(fileUri, mimeType);

  // 2. Main Execution: Viral Clip Analysis (Pass 2)
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

  const analysisPromise = ai.models.generateContent({
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

  // Wait for both
  const [transcript, analysisResponse] = await Promise.all([transcriptPromise, analysisPromise]);

  const text = analysisResponse.text;
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

  return { analysis: result, transcript };
};

/**
 * Processes chat commands for the video copilot.
 */
export const processUserCommand = async (
  fileUri: string,
  mimeType: string,
  userMessage: string,
  existingClips: Clip[],
  modelName: string,
  transcript?: TranscriptSegment[], // Optional transcript for context
  activeClip?: Clip | null // NEW: The currently selected clip
): Promise<CopilotResponse> => {

  // Prepare Transcript Context if available (First 5000 chars to save context)
  const transcriptContext = transcript 
    ? `\nTRANSCRIPT CONTEXT:\n${JSON.stringify(transcript.slice(0, 20))}\n...(truncated)`
    : "";

  // Prepare Active Clip Context
  const activeClipContext = activeClip 
    ? `\nCURRENTLY SELECTED CLIP: ${JSON.stringify(activeClip)}\nIf user says "this clip", "enhance", "translate" or "add", apply changes to THIS clip ID.`
    : "";

  const systemPrompt = `
  You are 'Director AI' - A professional Video Editor and Creative Director.
  Your goal is to interpret the user's request and act with EDITORIAL JUDGMENT.
  
  AVAILABLE CLIPS: ${existingClips.length} clips found.
  ${transcriptContext}
  ${activeClipContext}

  DIRECTOR GUIDELINES:
  1. **Be Precise**: When finding a clip, ensure the 'startTime' is EXACTLY when the action/speech starts.
  2. **Be Creative**: For 'CLIP_EDIT' intents, generate CSS filters or text overlays that match the mood.
  3. **Context Matters**: If a clip is selected, prioritize editing THAT clip over searching for new ones.

  INTENTS:
  - SEARCH: User wants to find a specific moment.
  - REEL_ADD / REEL_REMOVE / REEL_CLEAR: Manage the highlight reel.
  - EDIT: Global visual effect or auto-edit on the whole video.
  - CLIP_EDIT: Modify the currently selected clip (Filters, Subtitles, Overlays). 
      - If user says "Translate", provide 'subtitles' field.
      - If user says "Add [thing]", provide 'overlay' field.
      - If user says "Enhance" or "Make it [style]", provide 'filterStyle'.

  OUTPUT format MUST be JSON matching the schema.
  `;

  // Define data schema
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      intent: { type: Type.STRING, enum: ['SEARCH', 'EDIT', 'REEL_ADD', 'REEL_REMOVE', 'REEL_CLEAR', 'CLIP_EDIT', 'UNKNOWN'] },
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
            subtitles: { type: Type.STRING, nullable: true },
            overlay: {
                type: Type.OBJECT,
                nullable: true,
                properties: {
                    type: { type: Type.STRING, enum: ['TEXT', 'EMOJI', 'IMAGE'] },
                    content: { type: Type.STRING },
                    position: { type: Type.STRING, enum: ['TOP', 'BOTTOM', 'CENTER', 'TOP_RIGHT', 'TOP_LEFT'] }
                }
            },
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

  // Sanitize
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
