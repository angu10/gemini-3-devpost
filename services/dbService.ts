
import { db } from "../firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { VideoMetadata, AnalysisResponse, TranscriptSegment } from "../types";

/**
 * Generates a simple ID based on file properties.
 * In production, use a proper file hash.
 */
export const generateVideoId = (file: File): string => {
  return `${file.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${file.size}`;
};

/**
 * Checks if the video has already been analyzed.
 */
export const getCachedAnalysis = async (file: File): Promise<VideoMetadata | null> => {
  if (!db) return null;

  try {
    const docId = generateVideoId(file);
    const docRef = doc(db, "videos", docId);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      console.log("🔥 Cache Hit! Loaded from Firestore.");
      return docSnap.data() as VideoMetadata;
    }
    return null;
  } catch (error) {
    console.warn("Error checking Firestore cache:", error);
    return null;
  }
};

/**
 * Saves the analysis results to Firestore.
 */
export const saveAnalysisToCache = async (
  file: File, 
  analysis: AnalysisResponse, 
  transcript: TranscriptSegment[],
  modelUsed: string
): Promise<void> => {
  if (!db) return;

  try {
    const docId = generateVideoId(file);
    const metadata: VideoMetadata = {
      id: docId,
      filename: file.name,
      fileSize: file.size,
      uploadDate: Date.now(),
      transcript: transcript,
      analysis: analysis,
      modelUsed: modelUsed
    };

    await setDoc(doc(db, "videos", docId), metadata);
    console.log("💾 Saved analysis to Firestore.");
  } catch (error) {
    console.error("Error saving to Firestore:", error);
  }
};
