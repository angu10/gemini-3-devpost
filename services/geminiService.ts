
import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip, TimeRange, YouTubeMetadata } from '../types';

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
 * Analyzes the video using the File URI (Server Reference).
 */
export const analyzeVideo = async (fileUri: string, mimeType: string): Promise<AnalysisResponse> => {
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
              }
            },
            required: ['title', 'description', 'startTime', 'endTime', 'viralityScore', 'category']
          }
        },
        overallSummary: { type: Type.STRING }
      },
      required: ['clips', 'overallSummary']
    };

    const response = await ai.models.generateContent({
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

    const text = response.text;
    if (!text) {
      throw new Error("No response from Gemini");
    }

    const data = JSON.parse(text) as AnalysisResponse;
    
    data.clips = data.clips.map((clip, index) => ({
      ...clip,
      id: `clip-${index}-${Date.now()}`
    }));

    return data;

  } catch (error) {
    console.error("Error analyzing video:", error);
    throw error;
  }
};

/**
 * Unified Command Processor
 * Decides if the user wants to FIND a clip or EDIT the video (Virtual Edit/Director Mode).
 */
export const processUserCommand = async (
  fileUri: string, 
  mimeType: string, 
  query: string
): Promise<{ type: 'CLIP' | 'EDIT' | 'NONE', data: any }> => {
  try {
    const prompt = `
      You are an intelligent video assistant acting as a Professional AI Director.
      USER QUERY: "${query}"

      TASK:
      Determine if the user wants to:
      1. SEARCH/FIND a specific moment.
      2. EDIT/MODIFY the video (Cuts, Styles, Transitions, Metadata).

      OUTPUT RULES:
      
      IF SEARCH/FIND:
      - Return 'intent': 'SEARCH' and the single best clip.

      IF EDIT/MODIFY (e.g. "Remove ums", "Make it cinematic", "Export for YouTube"):
      - Return 'intent': 'EDIT'.
      - 'keepSegments': List of time ranges to KEEP. 
         * If the user only asks for style (e.g. "Make it black and white"), return the FULL video duration as one segment (0 to duration).
         * If the user asks to remove things, calculate the cuts.
      - 'filterStyle': Generate a CSS filter string if requested (e.g. "grayscale(1) contrast(1.2)" for noir, "saturate(1.3) contrast(1.1)" for vibrant). Default to null.
      - 'transitionEffect': If the user mentions transitions or "professional" editing, pick one: 'FADE_BLACK', 'FLASH_WHITE', 'ZOOM'. Default to null.
      - 'youtubeMetadata': If the user mentions "Export", "YouTube", "Title", or "SEO", generate optimized metadata.

      CSS FILTER GUIDE:
      - Cinematic/Professional: "contrast(1.1) saturate(0.9) sepia(0.2)"
      - Noir/B&W: "grayscale(1) contrast(1.2)"
      - Vibrant/Vlog: "saturate(1.4) brightness(1.05)"
      - Vintage: "sepia(0.6) contrast(0.9) brightness(0.9)"
    `;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING, enum: ['SEARCH', 'EDIT', 'UNKNOWN'] },
        // For SEARCH
        found: { type: Type.BOOLEAN },
        clip: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            startTime: { type: Type.NUMBER },
            endTime: { type: Type.NUMBER },
            viralityScore: { type: Type.NUMBER },
            category: { type: Type.STRING, enum: ['Custom'] }
          }
        },
        // For EDIT (Director Mode)
        editDescription: { type: Type.STRING },
        keepSegments: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              start: { type: Type.NUMBER },
              end: { type: Type.NUMBER }
            }
          }
        },
        filterStyle: { type: Type.STRING, nullable: true },
        transitionEffect: { type: Type.STRING, enum: ['FADE_BLACK', 'FLASH_WHITE', 'ZOOM', 'NONE'], nullable: true },
        youtubeMetadata: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            title: { type: Type.STRING },
            description: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } }
          }
        }
      },
      required: ['intent']
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
    if (!text) return { type: 'NONE', data: null };
    
    const result = JSON.parse(text);

    if (result.intent === 'SEARCH' && result.found && result.clip) {
      return { 
        type: 'CLIP', 
        data: {
          ...result.clip,
          id: `custom-${Date.now()}`,
          category: 'Custom'
        }
      };
    }

    if (result.intent === 'EDIT') {
      // If AI didn't return segments (e.g. just asked for style), assume we keep the whole video?
      // Actually the prompt instructs to return full duration, but let's be safe.
      // We'll handle empty segments in the UI or here. 
      // For now, assume Gemini follows instructions.
      
      return {
        type: 'EDIT',
        data: {
          description: result.editDescription || query,
          keepSegments: result.keepSegments && result.keepSegments.length > 0 
            ? result.keepSegments.sort((a: TimeRange, b: TimeRange) => a.start - b.start) 
            : [], // Empty array might imply "keep original" or "keep nothing", handled in App.tsx
          filterStyle: result.filterStyle,
          transitionEffect: result.transitionEffect,
          youtubeMetadata: result.youtubeMetadata
        }
      };
    }

    return { type: 'NONE', data: null };

  } catch (error) {
    console.error("Error processing command:", error);
    throw error;
  }
};
