import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip } from '../types';

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
 * Searches the video using the File URI.
 */
export const findMomentInVideo = async (fileUri: string, mimeType: string, query: string): Promise<Clip | null> => {
  try {
    const searchPrompt = `
      You are analyzing a video to find a specific moment requested by the user.

      USER QUERY: "${query}"

      TASK:
      1. Search through the video for the moment that BEST matches this query
      2. Consider visual content, spoken dialogue, actions, and context
      3. If found, extract a 15-60 second clip containing that moment
      4. If the query genuinely cannot be matched in the video, set "found" to false

      MATCHING CRITERIA:
      - Prioritize exact matches first (if they say "laughing", find actual laughter)
      - Consider semantic similarity (if they say "funny part", find humor)
      - Include context before/after the moment for clarity
      - Ensure the clip is self-contained and makes sense alone

      CLIP REQUIREMENTS:
      - Duration: 15-60 seconds optimal
      - Start slightly before the moment for context
      - End after the moment completes
      - Must be understandable without watching the full video
    `;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
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
          },
          required: ['title', 'description', 'startTime', 'endTime', 'viralityScore', 'category']
        }
      },
      required: ['found']
    };

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: {
        parts: [
          { fileData: { mimeType: mimeType, fileUri: fileUri } },
          { text: searchPrompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      }
    });

    const text = response.text;
    if (!text) return null;

    const data = JSON.parse(text);
    if (!data.found || !data.clip) return null;

    return {
      ...data.clip,
      id: `custom-${Date.now()}`,
      category: 'Custom'
    };

  } catch (error) {
    console.error("Error searching video:", error);
    throw error;
  }
};