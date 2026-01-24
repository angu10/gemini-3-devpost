import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, SAMPLE_PROMPT } from '../constants';
import { AnalysisResponse, Clip } from '../types';

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Converts a File object to a Base64 string usable by the API.
 */
export const fileToGenerativePart = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      // Remove the data URL prefix (e.g., "data:video/mp4;base64,")
      const base64Data = base64String.split(',')[1];
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Analyzes the video using Gemini to extract clips.
 */
export const analyzeVideo = async (file: File): Promise<AnalysisResponse> => {
  try {
    const base64Data = await fileToGenerativePart(file);

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
              category: { type: Type.STRING, enum: ['Funny', 'Insightful', 'Action', 'Summary', 'Other'] }
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
            inlineData: {
              mimeType: file.type,
              data: base64Data
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
        temperature: 0.4, // Lower temperature for more factual timestamping
      }
    });

    const text = response.text;
    if (!text) {
      throw new Error("No response from Gemini");
    }

    // Parse the JSON response
    const data = JSON.parse(text) as AnalysisResponse;
    
    // Add IDs to clips for React keys
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
 * Searches the video for a specific user query and returns a single clip.
 */
export const findMomentInVideo = async (file: File, query: string): Promise<Clip | null> => {
  try {
    const base64Data = await fileToGenerativePart(file);

    const searchPrompt = `
      You are an expert video editor. The user is asking to find a specific moment in the video.
      User Query: "${query}"
      
      Locate the most relevant segment that matches this query. 
      Return a SINGLE clip object in JSON format.
      If the query cannot be found in the video, return null.
      
      Required JSON Schema:
      {
        "found": boolean,
        "clip": {
           "title": "string (short catchy title based on query)",
           "description": "string (what happens in this specific moment)",
           "startTime": number (seconds),
           "endTime": number (seconds),
           "viralityScore": number (estimate 1-10),
           "category": "Custom"
        }
      }
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
          { inlineData: { mimeType: file.type, data: base64Data } },
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