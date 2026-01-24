
import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip, TimeRange } from '../types';

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
 * Decides if the user wants to FIND a clip or EDIT the video (Virtual Edit).
 */
export const processUserCommand = async (
  fileUri: string, 
  mimeType: string, 
  query: string
): Promise<{ type: 'CLIP' | 'EDIT' | 'NONE', data: any }> => {
  try {
    const prompt = `
      You are an intelligent video assistant.
      USER QUERY: "${query}"

      TASK:
      Determine if the user wants to:
      1. SEARCH/FIND a specific moment (e.g., "Find the part where...", "Show me the goal").
      2. EDIT/FILTER the playback (e.g., "Remove ums", "Skip silence", "Cut out the boring parts", "Only show the action scenes").
      
      OUTPUT RULES:
      - If EDIT/FILTER: Return a list of time ranges to KEEP (include everything EXCEPT what needs to be removed).
      - If SEARCH/FIND: Return a single best matching clip.
      
      IMPORTANT FOR EDITING:
      - If the user says "Remove X", you must identify all timestamps of X, and return the COMPLEMENT segments (the parts to keep).
      - Ensure 'keepSegments' cover the entire video excluding the unwanted parts.
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
        // For EDIT
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

    if (result.intent === 'EDIT' && result.keepSegments && result.keepSegments.length > 0) {
      return {
        type: 'EDIT',
        data: {
          description: result.editDescription || query,
          keepSegments: result.keepSegments.sort((a: TimeRange, b: TimeRange) => a.start - b.start)
        }
      };
    }

    return { type: 'NONE', data: null };

  } catch (error) {
    console.error("Error processing command:", error);
    throw error;
  }
};
