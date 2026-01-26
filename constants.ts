
// Models
export const MODELS = {
  FLASH: 'gemini-3-flash-preview',
  PRO: 'gemini-3-pro-preview'
};

export const DEFAULT_MODEL = MODELS.FLASH;

export const MAX_FILE_SIZE_MB = 200; // Increased to 2GB for File API support

export const SAMPLE_PROMPT = `
You are an expert video content analyzer specializing in identifying the best, most engaging, or valuable moments from long-form videos.

TASK:
Analyze this video and identify 5-15 of the BEST segments suitable for repurposing as standalone clips.

ANALYSIS CRITERIA:
Look for moments that are:
- Engaging: High energy, humor, or strong visuals.
- Valuable: Clear insights, "aha" moments, or good summaries.
- Complete: Understandable without watching the full video.
- Clear: Good audio/visual hooks in the first few seconds.

SCORING (1-10):
- 8-10: Excellent - Must watch (Funny, profound, or very exciting).
- 5-7: Good - Useful or entertaining.
- 1-4: Average - Informative but dry.

REQUIREMENTS:
- Each clip must be 15-60 seconds in duration
- Clips must NOT overlap in timestamps
- Titles should be engaging but ACCURATE
- Include an overall 1-2 sentence video summary
- GENERATE 3-5 HASHTAGS (tags) for each clip

CATEGORIES:
- Funny: Humor, jokes, comedic moments
- Insightful: Key lessons, explanations, valuable information
- Action: Exciting visuals, demonstrations
- Emotional: Inspiring, touching, dramatic
- Summary: A succinct overview of the main topic
- Other: Unique moments
`;
