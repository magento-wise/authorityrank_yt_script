// api/transcript-backup.js
// Backup transcript service using YouTube Innertube API
// This is a SEPARATE endpoint - uses YouTube's internal API directly
// Different approach from youtube-caption-extractor and youtube-transcript

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Innertube API client info
const INNERTUBE_CLIENT = {
  clientName: 'WEB',
  clientVersion: '2.20231219.04.00',
  hl: 'en',
  gl: 'US'
};

// Get video info using Innertube API
async function getVideoInfoInnertube(videoId) {
  console.log(`🔍 Fetching video info via Innertube API...`);

  const response = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`
    },
    body: JSON.stringify({
      videoId: videoId,
      context: {
        client: INNERTUBE_CLIENT
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Innertube API returned ${response.status}`);
  }

  const data = await response.json();
  return data;
}

// Fetch captions using the track URL
async function fetchCaptions(trackUrl) {
  console.log(`📥 Fetching captions from track URL...`);

  // Try XML format first (more reliable)
  const response = await fetch(trackUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch captions: ${response.status}`);
  }

  const text = await response.text();
  return text;
}

// Parse XML captions to transcript segments
function parseXmlCaptions(xmlText) {
  const segments = [];

  // Match all <text> elements with their attributes and content
  const textRegex = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([^<]*(?:<[^/][^<]*)*?)<\/text>/g;
  let match;

  while ((match = textRegex.exec(xmlText)) !== null) {
    const start = parseFloat(match[1]);
    const dur = parseFloat(match[2]);
    let text = match[3];

    // Decode HTML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
      .replace(/\n/g, ' ')
      .trim();

    if (text) {
      segments.push({
        text,
        start,
        duration: dur
      });
    }
  }

  // Alternative regex if the first one doesn't match (different attribute order)
  if (segments.length === 0) {
    const altRegex = /<text[^>]*start="([^"]+)"[^>]*dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
    while ((match = altRegex.exec(xmlText)) !== null) {
      const start = parseFloat(match[1]);
      const dur = parseFloat(match[2]);
      let text = match[3]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n/g, ' ')
        .trim();

      if (text) {
        segments.push({ text, start, duration: dur });
      }
    }
  }

  return segments;
}

// Main extraction function
async function extractTranscriptInnertube(videoId, lang = 'en') {
  console.log(`🚀 Starting Innertube transcript extraction for: ${videoId}`);

  // Get video info with caption tracks
  const videoInfo = await getVideoInfoInnertube(videoId);

  // Check if captions are available
  const captionRenderer = videoInfo?.captions?.playerCaptionsTracklistRenderer;
  if (!captionRenderer || !captionRenderer.captionTracks || captionRenderer.captionTracks.length === 0) {
    throw new Error('No caption tracks available for this video');
  }

  const tracks = captionRenderer.captionTracks;
  console.log(`📋 Found ${tracks.length} caption track(s)`);

  // Find the requested language track
  let selectedTrack = tracks.find(t => t.languageCode === lang);

  // Fallback to English variants
  if (!selectedTrack && lang === 'en') {
    selectedTrack = tracks.find(t =>
      t.languageCode === 'en-US' ||
      t.languageCode === 'en-GB' ||
      (t.languageCode && t.languageCode.startsWith('en'))
    );
  }

  // Use first available if still not found
  if (!selectedTrack) {
    selectedTrack = tracks[0];
    console.log(`⚠️ Requested language '${lang}' not found, using '${selectedTrack.languageCode}'`);
  }

  const trackName = selectedTrack.name?.simpleText || 'auto-generated';
  console.log(`🎯 Using track: ${selectedTrack.languageCode} (${trackName})`);

  // Fetch the captions
  const captionXml = await fetchCaptions(selectedTrack.baseUrl);

  // Parse the captions
  const segments = parseXmlCaptions(captionXml);

  if (segments.length === 0) {
    throw new Error('No transcript segments found');
  }

  // Combine into full transcript
  const transcript = segments.map(s => s.text).join(' ');

  return {
    transcript,
    segments: segments.length,
    language: selectedTrack.languageCode,
    isAutoGenerated: selectedTrack.kind === 'asr',
    videoTitle: videoInfo.videoDetails?.title || 'Unknown',
    availableTracks: tracks.map(t => ({
      language: t.languageCode,
      name: t.name?.simpleText || 'Unknown'
    }))
  };
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
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    console.log('🔄 Backup Transcript Service (Innertube API) called');

    const { videoId, lang = 'en' } = req.body;

    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ error: 'Missing required parameter: videoId' });
      return;
    }

    console.log(`🎬 Processing video: ${videoId}`);

    // Extract transcript using Innertube method
    const result = await extractTranscriptInnertube(videoId, lang);

    console.log(`✅ Transcript extracted: ${result.transcript.length} characters`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: {
        transcript: result.transcript,
        segments: result.segments,
        language: result.language,
        source: 'youtube-innertube-api',
        isAutoGenerated: result.isAutoGenerated,
        videoId: videoId,
        videoTitle: result.videoTitle,
        availableLanguages: result.availableTracks
      },
      message: 'Transcript extracted via backup service (Innertube API)'
    });

  } catch (error) {
    console.error('❌ Backup service error:', error.message);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Backup transcript extraction failed',
      hint: 'This video may not have captions available.'
    });
  }
}
