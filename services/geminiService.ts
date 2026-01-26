
import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip, TimeRange, YouTubeMetadata, CopilotResponse } from '../types';

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Uploads a file to the Gemini File API and waits for it to be processed.
 */
export const uploadVideo = async (file: File, onProgress?: (msg: string) => void): Promise<string> => {
  try {
    if (onProgress) onProgress("Uploading video to Gemini...");
    
    const uploadResult = await ai.files.upload({
      file: file,
      config: { 
        displayName: file.name,
      }
    });

    const fileUri = uploadResult.uri;
    const name = uploadResult.name;

    // Poll for processing state
    let fileState = uploadResult.state;
    
    while (fileState === 'PROCESSING') {
      if (onProgress) onProgress("Processing video on server...");
      
      // Wait 2 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const fileStatus = await ai.files.get({ name: name });
      fileState = fileStatus.state;
      
      if (fileState === 'FAILED') {
        throw new Error("Video processing failed on Gemini servers.");
      }
    }

    if (onProgress) onProgress("Video processed and ready.");
    return fileUri;

  } catch (error) {
    console.error("Error uploading file:", error);
    throw new Error("Failed to upload and process video.");
  }
};

/**
 * Helper to parse clips from accumulating JSON string
 */
const parseClipsFromStream = (text: string): Clip[] => {
  const clips: Clip[] = [];
  const clipsStartIndex = text.indexOf('"clips":');
  if (clipsStartIndex === -1) return [];

  // Find start of array
  const arrayStart = text.indexOf('[', clipsStartIndex);
  if (arrayStart === -1) return [];

  let braceCount = 0;
  let inString = false;
  let escape = false;
  let objectStart = -1;

  for (let i = arrayStart + 1; i < text.length; i++) {
    const char = text[i];
    
    if (escape) {
      escape = false;
      continue;
    }
    
    if (char === '\\') {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
    }

    if (!inString) {
      if (char === '{') {
        if (braceCount === 0) objectStart = i;
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && objectStart !== -1) {
          // Found potential complete object
          const jsonStr = text.substring(objectStart, i + 1);
          try {
            const clip = JSON.parse(jsonStr);
            if (clip.title && clip.startTime !== undefined && clip.endTime !== undefined) {
               clips.push(clip);
            }
          } catch (e) {
            // Ignore incomplete or malformed objects during stream
          }
          objectStart = -1;
        }
      } else if (char === ']') {
        // End of array
        break;
      }
    }
  }
  return clips;
};

/**
 * Analyzes the video using the File URI (Server Reference) with Streaming.
 */
export const analyzeVideo = async (
  fileUri: string, 
  mimeType: string,
  onPartialUpdate?: (clips: Clip[]) => void
): Promise<AnalysisResponse> => {
  try {
    // Schema for structured JSON output
    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        clips: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              description: { type: Type.STRING },
              startTime: { type: Type.NUMBER, description: "Start time in seconds" },
              endTime: { type: Type.NUMBER, description: "End time in seconds" },
              viralityScore: { type: Type.NUMBER, description: "Score from 1 to 10" },
              category: { 
                type: Type.STRING, 
                enum: ['Funny', 'Insightful', 'Action', 'Emotional', 'Summary', 'Other'] 
              },
              tags: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "3-5 viral hashtags for this clip" 
              }
            },
            required: ['title', 'description', 'startTime', 'endTime', 'viralityScore', 'category', 'tags']
          }
        },
        overallSummary: { type: Type.STRING }
      },
      required: ['clips', 'overallSummary']
    };

    const streamResult = await ai.models.generateContentStream({
      model: GEMINI_MODEL,
      contents: {
        parts: [
          {
            fileData: {
              mimeType: mimeType,
              fileUri: fileUri
            }
          },
          {
            text: SAMPLE_PROMPT
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.4, 
      }
    });

    let fullText = '';
    let lastClipCount = 0;

    for await (const chunk of streamResult) {
      fullText += chunk.text;
      
      if (onPartialUpdate) {
        const foundClips = parseClipsFromStream(fullText);
        if (foundClips.length > lastClipCount) {
          // Add IDs to ensure React stability
          const clipsWithIds = foundClips.map((c, i) => ({
            ...c,
            id: `clip-${i}-${fileUri.slice(-4)}` // Stable ID based on index
          }));
          onPartialUpdate(clipsWithIds);
          lastClipCount = foundClips.length;
        }
      }
    }

    const data = JSON.parse(fullText) as AnalysisResponse;
    
    // Final pass to ensure all properties (like overallSummary) are set
    data.clips = data.clips.map((clip, index) => ({
      ...clip,
      id: `clip-${index}-${fileUri.slice(-4)}`
    }));

    return data;

  } catch (error) {
    console.error("Error analyzing video:", error);
    throw error;
  }
};

/**
 * Unified Command Processor (Copilot)
 */
export const processUserCommand = async (
  fileUri: string, 
  mimeType: string, 
  query: string,
  existingClips: Clip[] = []
): Promise<CopilotResponse> => {
  try {
    const prompt = `
      You are an intelligent Video Editor Copilot.
      USER QUERY: "${query}"

      CONTEXT - EXISTING CLIPS FOUND:
      ${JSON.stringify(existingClips.map((c, i) => ({ index: i, title: c.title, start: c.startTime, end: c.endTime, id: c.id })))}

      TASK:
      Determine the user's intent and execute the appropriate action.
      
      INTENTS:
      
      1. REEL_ADD: User wants to add a clip to the Montage/Timeline/Reel.
         - If they reference an existing clip (e.g., "Add the funny one", "Add clip 1"), use its ID.
         - If they want a NEW segment (e.g., "Add the part where he smiles"), define the new start/end times.
         - Return 'intent': 'REEL_ADD', and 'clip' data.
      
      2. REEL_REMOVE: User wants to remove a clip from the Montage/Reel.
         - Return 'intent': 'REEL_REMOVE', and 'clipIndex' (if they say "remove the last one") or 'clipId'.
      
      3. REEL_CLEAR: User wants to clear the timeline.
         - Return 'intent': 'REEL_CLEAR'.

      4. EDIT: Global edits like filters or transitions. (e.g., "Make it cinematic").
         - Return 'intent': 'EDIT' and 'filterStyle'/'transitionEffect'.

      5. SEARCH: User just wants to see/find a clip but NOT add it to the reel yet.
         - Return 'intent': 'SEARCH'.

      OUTPUT RULES:
      - Be conversational in the 'message' field.
    `;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING, enum: ['SEARCH', 'EDIT', 'REEL_ADD', 'REEL_REMOVE', 'REEL_CLEAR', 'UNKNOWN'] },
        message: { type: Type.STRING },
        clip: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            id: { type: Type.STRING },
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            startTime: { type: Type.NUMBER },
            endTime: { type: Type.NUMBER },
            viralityScore: { type: Type.NUMBER },
            category: { type: Type.STRING, enum: ['Custom'] },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } }
          }
        },
        // For REEL_REMOVE
        removeIndex: { type: Type.INTEGER, nullable: true, description: "-1 for last item, 0 for first" },
        
        // For EDIT
        editDescription: { type: Type.STRING },
        filterStyle: { type: Type.STRING, nullable: true },
        transitionEffect: { type: Type.STRING, enum: ['FADE_BLACK', 'FLASH_WHITE', 'ZOOM', 'NONE'], nullable: true },
      },
      required: ['intent', 'message']
    };

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: {
        parts: [
          { fileData: { mimeType: mimeType, fileUri: fileUri } },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      }
    });

    const text = response.text;
    if (!text) return { intent: 'UNKNOWN', message: "I didn't catch that." };
    
    const result = JSON.parse(text);

    // Normalize Data
    if (result.intent === 'REEL_ADD' && result.clip) {
        // If ID matches existing, use it, otherwise generate temp ID
        if (!result.clip.id) result.clip.id = `custom-${Date.now()}`;
        if (!result.clip.category) result.clip.category = 'Custom';
        
        return {
            intent: 'REEL_ADD',
            message: result.message,
            data: result.clip
        };
    }
    
    if (result.intent === 'REEL_REMOVE') {
        return {
            intent: 'REEL_REMOVE',
            message: result.message,
            data: { index: result.removeIndex }
        }
    }

    if (result.intent === 'EDIT') {
        return {
            intent: 'EDIT',
            message: result.message,
            data: {
                description: result.editDescription,
                filterStyle: result.filterStyle,
                transitionEffect: result.transitionEffect
            }
        };
    }

    return { intent: result.intent, message: result.message, data: result.clip };

  } catch (error) {
    console.error("Error processing command:", error);
    throw error;
  }
};
