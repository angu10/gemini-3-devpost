
import { GoogleGenAI, Type, Modality, HarmCategory, HarmBlockThreshold } from "@google/genai";
import { SAMPLE_PROMPT, STORY_PROMPT, MODELS } from '../constants';
import { AnalysisResponse, Clip, CopilotResponse, TranscriptSegment, TimeRange, StoryResponse } from '../types';

// Initialize Gemini Client
// Guideline: The API key must be obtained exclusively from the environment variable process.env.API_KEY.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY }); 

// Common Safety Settings to prevent "No response" on valid video content
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

/**
 * Validates the Gemini API connection by making a lightweight model call.
 */
export const validateGeminiConnection = async (): Promise<{ success: boolean; message: string }> => {
    if (!process.env.API_KEY) {
        return { success: false, message: "Missing API Key" };
    }
    if (process.env.API_KEY.startsWith("project-")) {
         return { success: false, message: "Invalid Key Format (Looks like Project ID)" };
    }
    try {
        // Use countTokens on ai.models instead of creating a model instance
        await ai.models.countTokens({ 
            model: MODELS.FLASH,
            contents: [{ role: 'user', parts: [{ text: 'test' }] }] 
        });
        return { success: true, message: "Connected" };
    } catch (e: any) {
        console.error("Gemini Validation Failed:", e);
        return { success: false, message: e.message || "Connection Failed" };
    }
};

// --- Helper: File to Base64 Part ---
const fileToPart = async (file: File): Promise<any> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
             const base64String = (reader.result as string).split(',')[1];
             resolve({
                 inlineData: {
                     data: base64String,
                     mimeType: file.type
                 }
             });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

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

// --- Helper: Client-Side Smart Edit (Silence/Filler Removal) ---
const FILLER_WORDS = new Set(['um', 'uh', 'ah', 'umm', 'uhh', 'hmm', 'er', 'like', 'you know', 'basically', 'literally']);

const performSmartEdit = (transcript: TranscriptSegment[]): TimeRange[] => {
    // 1. Filter valid segments (remove segments that are just filler words)
    const validSegments = transcript.filter(seg => {
        if (!seg.text) return false;
        const cleanText = seg.text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        // Keep segment if it's not empty and not JUST a filler word
        if (!cleanText) return false;
        if (FILLER_WORDS.has(cleanText)) return false;
        return true;
    });

    if (validSegments.length === 0) return [{ start: 0, end: 10 }]; // Fallback if everything is filtered

    // 2. Construct Keep Segments with Padding & Merge logic
    // We assume gaps between transcript segments > GAP_THRESHOLD are "silence"
    const merged: TimeRange[] = [];
    const GAP_THRESHOLD = 0.5; // If gap is less than 0.5s, merge them (don't cut)
    const PADDING = 0.1; // Keep 0.1s audio around the speech to sound natural

    let current = {
        start: Math.max(0, validSegments[0].start - PADDING),
        end: validSegments[0].end + PADDING
    };

    for (let i = 1; i < validSegments.length; i++) {
        const seg = validSegments[i];
        const nextStart = Math.max(0, seg.start - PADDING);
        const nextEnd = seg.end + PADDING;

        if (nextStart <= current.end + GAP_THRESHOLD) {
            // Overlapping or close enough: Merge
            current.end = Math.max(current.end, nextEnd);
        } else {
            // Significant gap: Push current and start new
            merged.push(current);
            current = { start: nextStart, end: nextEnd };
        }
    }
    merged.push(current);

    return merged;
};

/**
 * Uploads a file using MANUAL Resumable Upload via Proxy.
 * Bypasses SDK upload to avoid CORS/Header stripping issues in cloud environments.
 */
export const uploadVideo = async (file: File, onProgress?: (msg: string) => void): Promise<string> => {
    if (onProgress) onProgress("Initializing upload...");

    // 1. Initiate Resumable Upload (Proxied)
    // We pass the API key via HEADER 'x-goog-api-key' instead of query param 
    // to prevent encoding issues and 400 Bad Request errors.
    const initUrl = `/api-proxy/upload/v1beta/files?uploadType=resumable`;
    
    const initResponse = await fetch(initUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.API_KEY || '',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': file.size.toString(),
        'X-Goog-Upload-Header-Content-Type': file.type || 'application/octet-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName: file.name } })
    });
  
    if (!initResponse.ok) {
       const text = await initResponse.text();
       throw new Error(`Upload init failed: ${initResponse.status} - ${text}`);
    }
  
    // 2. Get Upload URL from Headers
    const uploadUrlRaw = initResponse.headers.get('x-goog-upload-url');
    if (!uploadUrlRaw) {
      throw new Error("Failed to get upload URL. Server did not return x-goog-upload-url.");
    }
  
    // 3. Convert to Proxy URL
    // The raw URL is absolute (e.g. https://generativelanguage.googleapis.com/upload/...)
    // We strip the domain to route it through our /api-proxy
    const uploadUrl = uploadUrlRaw.replace('https://generativelanguage.googleapis.com', '/api-proxy');
  
    if (onProgress) onProgress("Uploading video data...");
  
    // 4. Perform Actual Upload (Streamed via Proxy)
    // We use the Blob directly so the browser streams it (memory efficient)
    // We also include the API Key header again for safety, though the uploadUrl usually encodes auth.
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST', // 'upload, finalize' command works with POST on the session URI
      headers: {
        'x-goog-api-key': process.env.API_KEY || '',
        'Content-Length': file.size.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: file
    });
  
    if (!uploadResponse.ok) {
       const text = await uploadResponse.text();
       throw new Error(`File upload failed: ${uploadResponse.status} - ${text}`);
    }
  
    const result = await uploadResponse.json();
    const fileInfo = result.file;
    
    // 5. Poll for processing using the SDK (GET requests are safe)
    if (onProgress) onProgress("Processing video...");
    
    let currentFile = await ai.files.get({ name: fileInfo.name });
    
    let attempts = 0;
    const maxAttempts = 60; // 2 minutes
  
    while (currentFile.state === 'PROCESSING') {
      if (attempts >= maxAttempts) throw new Error("Video processing timed out.");
      await new Promise(r => setTimeout(r, 2000));
      currentFile = await ai.files.get({ name: fileInfo.name });
      attempts++;
    }
  
    if (currentFile.state === 'FAILED') throw new Error("Video processing failed.");
  
    if (onProgress) onProgress("Ready for analysis.");
    return currentFile.uri;
};

/**
 * IMAGE STORY MODE: Generate Script & Order
 */
export const generateStoryFromImages = async (files: File[], context?: string): Promise<StoryResponse> => {
    // Convert files to inline data (multimodal input)
    const imageParts = await Promise.all(files.map(f => fileToPart(f)));
    
    let prompt = STORY_PROMPT;
    if (context && context.trim()) {
        prompt += `\n\nUSER PROVIDED CONTEXT / BACKSTORY:\n"${context}"\n\nUse this context to guide the narrative script and tone.`;
    }

    const responseSchema = {
        type: Type.OBJECT,
        properties: {
            script: { type: Type.STRING },
            imageOrder: { type: Type.ARRAY, items: { type: Type.NUMBER } },
            title: { type: Type.STRING }
        },
        required: ['script', 'imageOrder', 'title']
    };

    const response = await ai.models.generateContent({
        model: MODELS.FLASH, // Use Flash for multimodal analysis
        contents: [{
            role: 'user',
            parts: [...imageParts, { text: prompt }]
        }],
        config: {
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
            safetySettings: SAFETY_SETTINGS,
        }
    });

    const text = response.text;
    if(!text) {
        const reason = response.candidates?.[0]?.finishReason;
        throw new Error(`Failed to generate story. Reason: ${reason || 'Unknown'}`);
    }

    return parseJSONSafely(text) as StoryResponse;
};

/**
 * IMAGE STORY MODE: Generate TTS Audio
 */
export const generateTTS = async (text: string): Promise<string> => {
    const response = await ai.models.generateContent({
        model: MODELS.TTS,
        contents: [{ parts: [{ text: text }] }],
        config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: 'Kore' },
                },
            },
        },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) throw new Error("No audio generated");
    return base64Audio;
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
            safetySettings: SAFETY_SETTINGS,
        },
    });

    const text = response.text;
    if (!text) {
        console.warn("Transcript generation returned no text. FinishReason:", response.candidates?.[0]?.finishReason);
        return [];
    }

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
      safetySettings: SAFETY_SETTINGS,
    },
  });

  // Wait for both
  const [transcript, analysisResponse] = await Promise.all([transcriptPromise, analysisPromise]);

  const text = analysisResponse.text;
  if (!text) {
      const reason = analysisResponse.candidates?.[0]?.finishReason;
      throw new Error(`No response from Gemini during Analysis. Reason: ${reason || 'Unknown'}`);
  }
  
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

  // --- 0. INTERCEPT: Fast Silence/Filler Removal ---
  const lowerMsg = userMessage.toLowerCase();
  const isSilenceRemoval = lowerMsg.includes('silence') || lowerMsg.includes('filler') || lowerMsg.includes('remove gaps');

  if (isSilenceRemoval && transcript && transcript.length > 0) {
      console.log("⚡ Executing Fast Client-Side Silence Removal");
      const keepSegments = performSmartEdit(transcript);
      return {
          intent: 'EDIT',
          message: "I've analyzed the transcript and removed silence and filler words instantly. Here is the tightened video.",
          data: { 
              keepSegments,
              description: "Auto-Removed Silence & Fillers"
          }
      };
  }

  // --- 1. Regular AI Processing ---

  // Prepare Transcript Context if available (First 5000 chars to save context)
  const transcriptContext = transcript 
    ? `\nTRANSCRIPT CONTEXT:\n${JSON.stringify(transcript.slice(0, 20))}\n...(truncated)`
    : "";

  // Prepare Active Clip Context
  const activeClipContext = activeClip 
    ? `\nCURRENTLY SELECTED CLIP: ${JSON.stringify(activeClip)}\nIf user says "this clip", "enhance", "translate", "add" or "trim", apply changes to THIS clip ID.`
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
  4. **Explicit Time Ranges**: If the user asks for a specific time range (e.g., "clip from 10s to 20s" or "play 1:00 to 1:30"), return intent 'SEARCH' with the explicit startTime and endTime.

  INTENTS:
  - SEARCH: User wants to find a specific moment OR specifies a time range to play/create.
  - REEL_ADD / REEL_REMOVE / REEL_CLEAR: Manage the highlight reel.
  - EDIT: Global visual effect or auto-edit on the whole video.
      - **VISUAL STYLES**: If user says "Vintage", "Black and White", "Cinematic" AND no clip is selected, use 'EDIT'.
      - **CRITICAL**: Provide valid CSS syntax for 'filterStyle'. 
        - Valid: "grayscale(1)", "sepia(0.8) contrast(1.2)", "saturate(2) brightness(1.1)", "blur(2px)".
        - INVALID: "vintage", "black_and_white", "warm". Do NOT return these.
      - If no specific time range or silence removal is requested, do NOT return 'keepSegments' (implies whole video).
  - CLIP_EDIT: Modify the currently selected clip. 
      - **TIMESTAMPS**: If user asks to "trim", "cut", "shorten", "remove first 5s", or "extend", you MUST calculate the NEW startTime/endTime and return them.
      - If user says "Translate", provide 'subtitles' field.
      - If user says "Add [thing]", provide 'overlay' field.
      - If user says "Enhance", "Vintage", "Black and White" for THIS clip, return 'filterStyle' with valid CSS.

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
    safetySettings: SAFETY_SETTINGS,
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
  if (!text) {
      const reason = response.candidates?.[0]?.finishReason;
      throw new Error(`No response from Gemini Copilot. Reason: ${reason || 'Unknown'}`);
  }

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
