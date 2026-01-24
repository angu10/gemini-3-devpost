// Using Gemini 3 Pro Preview as requested for best video understanding capabilities
export const GEMINI_MODEL = 'gemini-3-pro-preview'; 

export const MAX_FILE_SIZE_MB = 40; // Browser safety limit for base64 inline

export const SAMPLE_PROMPT = `
Analyze this video meticulously. I need to repurpose this content into short, viral clips (Youtube Shorts/TikToks).
Identify up to 30 distinct, engaging segments.
For each segment, provide:
1. A catchy "Clickbait" style title.
2. A brief description of what happens.
3. Precise start and end timestamps in seconds.
4. A "virality score" from 1-10 based on how engaging it is.
5. A category (Funny, Insightful, Action, Summary, Other).

Return the response strictly as a JSON object with this schema:
{
  "clips": [
    {
      "title": "string",
      "description": "string",
      "startTime": number,
      "endTime": number,
      "viralityScore": number,
      "category": "string"
    }
  ],
  "overallSummary": "string"
}
`;