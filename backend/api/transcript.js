// api/transcript.js
// YouTube Transcript Service for Vercel
// Uses youtube-caption-extractor as primary method (fast, reliable)

import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Method 1: Extract using youtube-caption-extractor (PRIMARY - fast and reliable)
async function extractWithCaptionExtractor(videoId, lang = 'en') {
  console.log(`📥 Method 1: Fetching captions for: ${videoId}`);

  try {
    // Get subtitles using youtube-caption-extractor
    const subtitles = await getSubtitles({ videoID: videoId, lang });

    if (!subtitles || subtitles.length === 0) {
      throw new Error('No captions found');
    }

    console.log(`✅ Found ${subtitles.length} subtitle segments`);

    // Get video details for additional info
    let videoDetails = {};
    try {
      videoDetails = await getVideoDetails({ videoID: videoId, lang });
      console.log(`📺 Video title: ${videoDetails.title || 'Unknown'}`);
    } catch (e) {
      console.log(`⚠️ Could not get video details: ${e.message}`);
    }

    // Combine all subtitle text into one continuous transcript
    const transcript = subtitles.map(item => item.text).join(' ');

    return {
      transcript,
      segments: subtitles.length,
      language: lang,
      source: 'youtube-caption-extractor',
      videoTitle: videoDetails.title || 'Unknown',
      videoDuration: videoDetails.duration || 'Unknown'
    };

  } catch (error) {
    console.log(`⚠️ Method 1 failed: ${error.message}`);
    throw error;
  }
}

// Main API handler
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({
      error: 'Method not allowed. Use POST.'
    });
    return;
  }

  try {
    console.log('🚀 YouTube Transcript Service called');

    // Parse request body
    const { videoId, format = 'txt', lang = 'en' } = req.body;

    // Validate required parameters
    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        error: 'Missing required parameter: videoId'
      });
      return;
    }

    console.log(`🎬 Processing video: ${videoId}`);
    console.log(`🌍 Language: ${lang}`);

    // Extract transcript using youtube-caption-extractor
    const result = await extractWithCaptionExtractor(videoId, lang);

    if (!result.transcript || result.transcript.length < 50) {
      throw new Error('Transcript too short or empty');
    }

    console.log('✅ Transcript extraction completed successfully');
    console.log(`📊 Transcript length: ${result.transcript.length} characters`);

    // Return success response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: result,
      message: 'Transcript extracted successfully'
    });

  } catch (error) {
    console.error('❌ Service error:', error.message);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Transcript extraction failed',
      hint: 'This video may not have captions available or they may be disabled.'
    });
  }
}