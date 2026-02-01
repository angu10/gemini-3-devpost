
// Models
export const MODELS = {
  FLASH: 'gemini-3-flash-preview',
  PRO: 'gemini-3-pro-preview',
  TTS: 'gemini-2.5-flash-preview-tts'
};

export const DEFAULT_MODEL = MODELS.FLASH;

export const MAX_FILE_SIZE_MB = 200; // Limit to 200MB

export const SAMPLE_PROMPT = `
You are a World-Class Video Editor & Viral Content Director.
Your goal is to repurpose this long-form video into high-performance short clips (TikTok/Reels/Shorts).

THE "VIRAL" CRITERIA:
1. THE HOOK: The clip MUST start with a strong visual or audio cue. No slow buildups.
2. THE PAYOFF: The clip must have a clear laugh, insight, or "wow" moment.
3. NO DEAD AIR: Tighten start/end times. Do not include silence or "umms" at the edges.

TASK:
Identify 5-15 of the absolute BEST moments.

SELECTION GUIDELINES:
- **Funny**: High energy, laughter, banter, or bloopers.
- **Insightful**: A complete thought that teaches the viewer something new in <30s.
- **Action**: Visual movement, demonstrations, or high-motion scenes.

REQUIREMENTS:
- **timestamps**: Precise SECONDS (e.g., 15.5).
- **startTime**: Start exactly when the sentence or action begins.
- **endTime**: Cut right after the point is made.
- **Duration**: 15-30 seconds STRICTLY.
- **Titles**: CLICKBAIT STYLE (Under 10 words). Make me want to watch. (e.g. "The moment he realized..." instead of "Speaker discusses realization").
- **Tags**: 3-5 high-volume SEO hashtags.
`;

export const STORY_PROMPT = `
You are a Documentary Director. I will provide a set of images.
1. Analyze the visual story.
2. Order the images to create the best narrative flow.
3. Write a short, engaging voiceover script (max 30 seconds) that narrates the story shown in the photos. 
   - The script should be emotional, exciting, or funny depending on the images.
   - Do NOT include "Image 1:" prefixes in the script. Just the spoken text.
4. Give it a catchy title.

Return JSON:
{
  "script": "string",
  "imageOrder": [original_index_numbers],
  "title": "string"
}
`;
