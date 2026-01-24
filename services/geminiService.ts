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
              category: { 
                type: Type.STRING, 
                // Added Emotional to the enum to match the new prompt
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