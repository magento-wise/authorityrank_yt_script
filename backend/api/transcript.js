// api/transcript.js
// YouTube Transcript Service for Vercel
// Multi-method extraction: Captions first, multiple fallbacks

import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';
import { YoutubeTranscript } from 'youtube-transcript';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Track extraction attempts for debugging
const extractionLog = [];

function logAttempt(method, success, details) {
  extractionLog.push({
    method,
    success,
    details,
    timestamp: new Date().toISOString()
  });
  console.log(`${success ? '✅' : '❌'} ${method}: ${details}`);
}

// ============================================
// METHOD 1: youtube-caption-extractor (PRIMARY)
// Fast and reliable for videos with captions
// ============================================
async function extractWithCaptionExtractor(videoId, lang = 'en') {
  try {
    console.log(`🔄 Method 1: Trying youtube-caption-extractor...`);

    const subtitles = await getSubtitles({ videoID: videoId, lang });

    if (!subtitles || subtitles.length === 0) {
      throw new Error('No captions found');
    }

    // Get video details for additional info
    let videoTitle = 'Unknown';
    try {
      const videoDetails = await getVideoDetails({ videoID: videoId, lang });
      videoTitle = videoDetails.title || 'Unknown';
    } catch (e) {
      // Ignore video details errors
    }

    const transcript = subtitles.map(item => item.text).join(' ');

    if (transcript.length < 50) {
      throw new Error(`Insufficient content (${transcript.length} chars)`);
    }

    logAttempt('youtube-caption-extractor', true, `${transcript.length} chars extracted`);

    return {
      transcript,
      language: lang,
      confidence: 0.95,
      source: 'youtube-caption-extractor',
      segments: subtitles.length,
      videoTitle
    };

  } catch (error) {
    logAttempt('youtube-caption-extractor', false, error.message);
    return null;
  }
}

// ============================================
// METHOD 2: youtube-transcript npm package
// Alternative caption extraction method
// ============================================
async function extractWithYoutubeTranscript(videoId) {
  try {
    console.log(`🔄 Method 2: Trying youtube-transcript npm...`);

    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: 'en'
    });

    if (!transcriptItems || transcriptItems.length === 0) {
      throw new Error('No transcript items found');
    }

    const transcript = transcriptItems.map(item => item.text).join(' ');

    if (transcript.length < 50) {
      throw new Error(`Insufficient content (${transcript.length} chars)`);
    }

    logAttempt('youtube-transcript', true, `${transcript.length} chars extracted`);

    return {
      transcript,
      language: 'en',
      confidence: 0.93,
      source: 'youtube-transcript',
      segments: transcriptItems.length
    };

  } catch (error) {
    logAttempt('youtube-transcript', false, error.message);
    return null;
  }
}

// ============================================
// METHOD 3: YouTube Innertube API (Direct)
// Uses YouTube's internal API
// ============================================
async function extractWithInnertubeAPI(videoId, lang = 'en') {
  try {
    console.log(`🔄 Method 3: Trying YouTube Innertube API...`);

    const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.youtube.com',
        'Referer': `https://www.youtube.com/watch?v=${videoId}`
      },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20231219.04.00',
            hl: 'en',
            gl: 'US'
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Innertube API returned ${response.status}`);
    }

    const data = await response.json();

    const captionRenderer = data?.captions?.playerCaptionsTracklistRenderer;
    if (!captionRenderer || !captionRenderer.captionTracks || captionRenderer.captionTracks.length === 0) {
      throw new Error('No caption tracks available');
    }

    const tracks = captionRenderer.captionTracks;
    let selectedTrack = tracks.find(t => t.languageCode === lang) ||
                        tracks.find(t => t.languageCode.startsWith('en')) ||
                        tracks[0];

    // Fetch captions XML
    const captionResponse = await fetch(selectedTrack.baseUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!captionResponse.ok) {
      throw new Error(`Failed to fetch captions: ${captionResponse.status}`);
    }

    const captionXml = await captionResponse.text();

    // Parse XML
    const segments = [];
    const textRegex = /<text[^>]*>([^<]*(?:<[^/][^<]*)*?)<\/text>/g;
    let match;
    while ((match = textRegex.exec(captionXml)) !== null) {
      let text = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n/g, ' ')
        .trim();
      if (text) segments.push(text);
    }

    const transcript = segments.join(' ');

    if (transcript.length < 50) {
      throw new Error(`Insufficient content (${transcript.length} chars)`);
    }

    logAttempt('innertube-api', true, `${transcript.length} chars extracted`);

    return {
      transcript,
      language: selectedTrack.languageCode || 'en',
      confidence: 0.90,
      source: 'youtube-innertube-api',
      segments: segments.length,
      videoTitle: data.videoDetails?.title || 'Unknown'
    };

  } catch (error) {
    logAttempt('innertube-api', false, error.message);
    return null;
  }
}

// ============================================
// MAIN EXTRACTION FUNCTION
// Tries all methods in order until one succeeds
// ============================================
async function extractTranscript(videoId, lang = 'en') {
  console.log(`🎬 Starting multi-method extraction for: ${videoId}`);

  // Clear extraction log
  extractionLog.length = 0;

  // METHOD 1: youtube-caption-extractor (fastest)
  let result = await extractWithCaptionExtractor(videoId, lang);
  if (result) return result;

  // METHOD 2: youtube-transcript npm
  result = await extractWithYoutubeTranscript(videoId);
  if (result) return result;

  // METHOD 3: Innertube API (direct YouTube API)
  result = await extractWithInnertubeAPI(videoId, lang);
  if (result) return result;

  // All methods failed
  const errors = extractionLog.map(e => `${e.method}: ${e.details}`).join('; ');
  throw new Error(`All extraction methods failed. Errors: ${errors}`);
}

// ============================================
// API HANDLER
// ============================================
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
      error: 'Method not allowed. Use POST.',
      hint: 'Send POST request with { videoId, lang? }'
    });
    return;
  }

  try {
    console.log('🚀 YouTube Transcript Service called');

    const { videoId, lang = 'en' } = req.body;

    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: videoId',
        hint: 'Provide videoId in request body'
      });
      return;
    }

    console.log(`🎬 Processing video: ${videoId}`);

    const result = await extractTranscript(videoId, lang);

    console.log(`✅ Success using ${result.source}: ${result.transcript.length} chars`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: {
        transcript: result.transcript,
        language: result.language,
        confidence: result.confidence,
        source: result.source,
        segments: result.segments,
        videoId: videoId,
        videoTitle: result.videoTitle
      },
      message: `Transcript extracted successfully using ${result.source}`,
      attempts: extractionLog
    });

  } catch (error) {
    console.error('❌ Service error:', error.message);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Transcript extraction failed',
      hint: 'This video may not have captions available or they may be disabled.',
      attempts: extractionLog
    });
  }
}
