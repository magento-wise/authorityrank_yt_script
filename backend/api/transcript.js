// api/transcript.js
// YouTube Transcript Service for Vercel
// Multi-method extraction: YouTube Data API first, then fallbacks

import { fetchTranscript } from 'youtube-transcript-plus';
import { getSubtitles, getVideoDetails } from 'youtube-caption-extractor';
import { YoutubeTranscript } from 'youtube-transcript';

// Browser-like headers and cookies to bypass YouTube consent/blocking
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YOUTUBE_COOKIES = 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2ODE4MTAyNjQaAmVuIAEaBgiA_LyaBg';

// Helper: fetch with YouTube cookies and browser-like headers
function fetchWithCookies(url, options = {}) {
  const headers = {
    'User-Agent': BROWSER_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cookie': YOUTUBE_COOKIES,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

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
// METHOD 0: YouTube Data API (PRIMARY when API key provided)
// Uses official YouTube API - not blocked!
// ============================================
async function extractWithYouTubeDataAPI(videoId, apiKey, lang = 'en') {
  try {
    console.log(`🔄 Method 0: Trying YouTube Data API with API key...`);

    if (!apiKey) {
      throw new Error('No API key provided');
    }

    // Step 1: Get video info to check if captions exist
    const videoInfoUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${apiKey}`;
    const videoResponse = await fetch(videoInfoUrl);

    if (!videoResponse.ok) {
      const errorData = await videoResponse.json();
      throw new Error(`YouTube API error: ${errorData.error?.message || videoResponse.status}`);
    }

    const videoData = await videoResponse.json();
    if (!videoData.items || videoData.items.length === 0) {
      throw new Error('Video not found');
    }

    const video = videoData.items[0];
    const hasCaption = video.contentDetails?.caption === 'true';
    const videoTitle = video.snippet?.title || 'Unknown';

    console.log(`📺 Video: ${videoTitle}`);
    console.log(`📝 Has captions (Data API): ${hasCaption} (note: ASR/auto-generated captions report false)`);

    // Step 2: Fetch the watch page to get caption track URLs
    // Uses cookies and browser headers to bypass consent page
    const watchPageResponse = await fetchWithCookies(`https://www.youtube.com/watch?v=${videoId}`);

    if (!watchPageResponse.ok) {
      throw new Error(`Watch page fetch failed: ${watchPageResponse.status}`);
    }

    const watchPageHtml = await watchPageResponse.text();

    // Extract caption tracks from ytInitialPlayerResponse
    const playerResponseMatch = watchPageHtml.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!playerResponseMatch) {
      throw new Error('Could not find player response');
    }

    let playerResponse;
    try {
      playerResponse = JSON.parse(playerResponseMatch[1]);
    } catch (e) {
      throw new Error('Could not parse player response');
    }

    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      throw new Error('No caption tracks in player response');
    }

    // Prefer English captions, then auto-generated, then any available
    let selectedTrack = captionTracks.find(t => t.languageCode === lang && !t.kind);
    if (!selectedTrack) {
      selectedTrack = captionTracks.find(t => t.languageCode === lang);
    }
    if (!selectedTrack) {
      selectedTrack = captionTracks.find(t => t.languageCode.startsWith('en'));
    }
    if (!selectedTrack) {
      selectedTrack = captionTracks[0];
    }

    const captionUrl = selectedTrack.baseUrl;
    console.log(`📥 Fetching captions: ${selectedTrack.languageCode} (${selectedTrack.name?.simpleText || 'auto'})`);

    // Step 3: Fetch the captions XML
    const captionResponse = await fetch(captionUrl);
    if (!captionResponse.ok) {
      throw new Error(`Caption fetch failed: ${captionResponse.status}`);
    }

    const captionXml = await captionResponse.text();

    // Parse XML and extract text
    const textMatches = captionXml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g);
    const segments = [];

    for (const match of textMatches) {
      const text = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/<[^>]+>/g, '')
        .trim();

      if (text) {
        segments.push(text);
      }
    }

    const transcript = segments.join(' ');

    if (transcript.length < 50) {
      throw new Error(`Transcript too short: ${transcript.length} chars`);
    }

    logAttempt('youtube-data-api', true, `${transcript.length} chars extracted`);

    return {
      transcript,
      language: selectedTrack.languageCode || lang,
      confidence: 0.98,
      source: 'youtube-data-api',
      segments: segments.length,
      videoTitle
    };

  } catch (error) {
    logAttempt('youtube-data-api', false, error.message);
    return null;
  }
}

// ============================================
// METHOD 0.5: youtube-transcript-plus (works in 2026)
// Uses updated Innertube approach
// ============================================
async function extractWithTranscriptPlus(videoId, lang = 'en') {
  try {
    console.log(`🔄 Method 0.5: Trying youtube-transcript-plus with cookies...`);

    // Custom fetch hooks to add CONSENT cookies and browser headers
    // This bypasses YouTube's consent page that blocks datacenter IPs
    const cookieFetch = async (params) => {
      const headers = {
        'User-Agent': params.userAgent || BROWSER_UA,
        'Cookie': YOUTUBE_COOKIES,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': params.lang || 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        ...(params.headers || {})
      };
      const options = { method: params.method || 'GET', headers };
      if (params.body) options.body = params.body;
      return fetch(params.url, options);
    };

    const segments = await fetchTranscript(videoId, {
      lang,
      videoFetch: cookieFetch,
      playerFetch: cookieFetch,
      transcriptFetch: cookieFetch
    });

    if (!segments || segments.length === 0) {
      throw new Error('No transcript segments found');
    }

    const transcript = segments
      .map(s => s.text)
      .join(' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    if (transcript.length < 50) {
      throw new Error(`Insufficient content (${transcript.length} chars)`);
    }

    logAttempt('youtube-transcript-plus', true, `${transcript.length} chars extracted`);

    return {
      transcript,
      language: segments[0]?.lang || lang,
      confidence: 0.97,
      source: 'youtube-transcript-plus',
      segments: segments.length,
      videoTitle: null
    };

  } catch (error) {
    logAttempt('youtube-transcript-plus', false, error.message);
    return null;
  }
}

// ============================================
// METHOD 1: youtube-caption-extractor
// Fast and reliable for videos with captions
// ============================================
async function extractWithCaptionExtractor(videoId, lang = 'en') {
  try {
    console.log(`🔄 Method 1: Trying youtube-caption-extractor...`);

    const subtitles = await getSubtitles({ videoID: videoId, lang });

    if (!subtitles || subtitles.length === 0) {
      throw new Error('No captions found');
    }

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
// ============================================
async function extractWithInnertubeAPI(videoId, lang = 'en') {
  try {
    console.log(`🔄 Method 3: Trying YouTube Innertube API (ANDROID client)...`);

    // Use ANDROID client context (like youtube-transcript-plus does)
    // ANDROID client is less likely to be blocked from datacenter IPs
    const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
        'Origin': 'https://www.youtube.com',
        'Referer': `https://www.youtube.com/watch?v=${videoId}`,
        'Cookie': YOUTUBE_COOKIES
      },
      body: JSON.stringify({
        videoId: videoId,
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
            hl: lang,
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

    // Strip fmt parameter from URL (like youtube-transcript-plus does) to get XML format
    let captionUrl = selectedTrack.baseUrl.replace(/&fmt=[^&]+/, '');

    const captionResponse = await fetchWithCookies(captionUrl, {
      headers: {
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-origin'
      }
    });

    if (!captionResponse.ok) {
      throw new Error(`Failed to fetch captions: ${captionResponse.status}`);
    }

    const captionXml = await captionResponse.text();

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
// ============================================
async function extractTranscript(videoId, lang = 'en', apiKey = null) {
  console.log(`🎬 Starting multi-method extraction for: ${videoId}`);
  if (apiKey) {
    console.log(`🔑 YouTube API key provided`);
  }

  extractionLog.length = 0;

  // METHOD 0: YouTube Data API (if API key provided)
  if (apiKey) {
    let result = await extractWithYouTubeDataAPI(videoId, apiKey, lang);
    if (result) return result;
  }

  // METHOD 0.5: youtube-transcript-plus (works in 2026)
  let result = await extractWithTranscriptPlus(videoId, lang);
  if (result) return result;

  // METHOD 1: youtube-caption-extractor
  result = await extractWithCaptionExtractor(videoId, lang);
  if (result) return result;

  // METHOD 2: youtube-transcript npm
  result = await extractWithYoutubeTranscript(videoId);
  if (result) return result;

  // METHOD 3: Innertube API
  result = await extractWithInnertubeAPI(videoId, lang);
  if (result) return result;

  const errors = extractionLog.map(e => `${e.method}: ${e.details}`).join('; ');
  throw new Error(`All extraction methods failed. Errors: ${errors}`);
}

// ============================================
// API HANDLER
// ============================================
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(405).json({
      error: 'Method not allowed. Use POST.',
      hint: 'Send POST request with { videoId, lang?, apiKey? }'
    });
    return;
  }

  try {
    console.log('🚀 YouTube Transcript Service called');

    const { videoId, lang = 'en', apiKey } = req.body;

    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({
        success: false,
        error: 'Missing required parameter: videoId',
        hint: 'Provide videoId in request body. Optional: apiKey for YouTube Data API'
      });
      return;
    }

    console.log(`🎬 Processing video: ${videoId}`);

    const result = await extractTranscript(videoId, lang, apiKey);

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
      hint: 'Try providing a YouTube API key in the request body: { videoId, apiKey }',
      attempts: extractionLog
    });
  }
}
