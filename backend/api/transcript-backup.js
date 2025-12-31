// api/transcript-backup.js
// Backup transcript service using direct YouTube timedtext API fetch
// This is a SEPARATE endpoint - does NOT use youtube-caption-extractor
// Uses raw fetch to YouTube's internal caption API

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Fetch video page and extract caption track info
async function getCaptionTracksFromVideoPage(videoId) {
  console.log(`🔍 Fetching video page for caption tracks...`);

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const response = await fetch(videoUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch video page: ${response.status}`);
  }

  const html = await response.text();

  // Look for ytInitialPlayerResponse which contains caption tracks
  let playerResponse = null;

  // Try to find ytInitialPlayerResponse
  const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
  if (playerResponseMatch) {
    try {
      // Find the complete JSON object by counting braces
      const startIdx = html.indexOf('ytInitialPlayerResponse');
      const jsonStartIdx = html.indexOf('{', startIdx);

      let braceCount = 0;
      let jsonEndIdx = jsonStartIdx;

      for (let i = jsonStartIdx; i < html.length; i++) {
        if (html[i] === '{') braceCount++;
        if (html[i] === '}') braceCount--;
        if (braceCount === 0) {
          jsonEndIdx = i + 1;
          break;
        }
      }

      const jsonStr = html.substring(jsonStartIdx, jsonEndIdx);
      playerResponse = JSON.parse(jsonStr);
    } catch (e) {
      console.log(`⚠️ Failed to parse ytInitialPlayerResponse: ${e.message}`);
    }
  }

  // Extract caption tracks from player response
  if (playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer) {
    const captionRenderer = playerResponse.captions.playerCaptionsTracklistRenderer;
    if (captionRenderer.captionTracks && captionRenderer.captionTracks.length > 0) {
      console.log(`✅ Found ${captionRenderer.captionTracks.length} caption track(s) from player response`);
      return captionRenderer.captionTracks;
    }
  }

  // Fallback: Try regex extraction
  console.log(`⚠️ Player response extraction failed, trying regex fallback...`);

  // Look for captionTracks in the raw HTML
  const captionTracksMatch = html.match(/"captionTracks"\s*:\s*\[(.*?)\]/s);
  if (captionTracksMatch) {
    try {
      const tracksJson = '[' + captionTracksMatch[1] + ']';
      const tracks = JSON.parse(tracksJson);
      if (tracks.length > 0) {
        console.log(`✅ Found ${tracks.length} caption track(s) via regex`);
        return tracks;
      }
    } catch (e) {
      console.log(`⚠️ Regex parsing failed: ${e.message}`);
    }
  }

  throw new Error('No caption tracks found in video page');
}

// Fetch captions from a track URL
async function fetchCaptionsFromTrack(trackUrl) {
  console.log(`📥 Fetching captions from track URL...`);

  // Request JSON format by appending fmt=json3
  let jsonUrl = trackUrl;
  if (jsonUrl.includes('&fmt=')) {
    jsonUrl = jsonUrl.replace(/&fmt=[^&]+/, '&fmt=json3');
  } else {
    jsonUrl = jsonUrl + '&fmt=json3';
  }

  const response = await fetch(jsonUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch captions: ${response.status}`);
  }

  const data = await response.json();
  return data;
}

// Parse JSON3 format captions
function parseJson3Captions(data) {
  if (!data.events) {
    throw new Error('No caption events found');
  }

  const segments = [];

  for (const event of data.events) {
    if (event.segs) {
      const text = event.segs.map(seg => seg.utf8 || '').join('');
      if (text.trim()) {
        segments.push({
          text: text.trim(),
          start: (event.tStartMs || 0) / 1000,
          duration: (event.dDurationMs || 0) / 1000
        });
      }
    }
  }

  return segments;
}

// Main extraction function
async function extractTranscriptDirect(videoId, lang = 'en') {
  console.log(`🚀 Starting direct transcript extraction for: ${videoId}`);

  // Get caption tracks from video page
  const tracks = await getCaptionTracksFromVideoPage(videoId);

  if (!tracks || tracks.length === 0) {
    throw new Error('No caption tracks available');
  }

  console.log(`📋 Found ${tracks.length} caption track(s)`);

  // Find the requested language track or fallback
  let selectedTrack = tracks.find(t => t.languageCode === lang);

  // If requested language not found, try English variants
  if (!selectedTrack && lang === 'en') {
    selectedTrack = tracks.find(t =>
      t.languageCode === 'en-US' ||
      t.languageCode === 'en-GB' ||
      (t.languageCode && t.languageCode.startsWith('en'))
    );
  }

  // If still not found, use first available
  if (!selectedTrack) {
    selectedTrack = tracks[0];
    console.log(`⚠️ Requested language '${lang}' not found, using '${selectedTrack.languageCode}'`);
  }

  const trackName = selectedTrack.name?.simpleText || selectedTrack.name || 'auto-generated';
  console.log(`🎯 Using track: ${selectedTrack.languageCode} (${trackName})`);

  // Fetch the actual captions
  const captionData = await fetchCaptionsFromTrack(selectedTrack.baseUrl);

  // Parse the captions
  const segments = parseJson3Captions(captionData);

  if (segments.length === 0) {
    throw new Error('No transcript segments extracted');
  }

  // Combine into full transcript
  const transcript = segments.map(s => s.text).join(' ');

  return {
    transcript,
    segments: segments.length,
    language: selectedTrack.languageCode,
    isAutoGenerated: selectedTrack.kind === 'asr',
    availableTracks: tracks.map(t => ({
      language: t.languageCode,
      name: t.name?.simpleText || t.name || 'Unknown'
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
    console.log('🔄 Backup Transcript Service (direct fetch) called');

    const { videoId, lang = 'en' } = req.body;

    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ error: 'Missing required parameter: videoId' });
      return;
    }

    console.log(`🎬 Processing video: ${videoId}`);

    // Extract transcript using direct method
    const result = await extractTranscriptDirect(videoId, lang);

    console.log(`✅ Transcript extracted: ${result.transcript.length} characters`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: {
        transcript: result.transcript,
        segments: result.segments,
        language: result.language,
        source: 'youtube-direct-fetch',
        isAutoGenerated: result.isAutoGenerated,
        videoId: videoId,
        availableLanguages: result.availableTracks
      },
      message: 'Transcript extracted via backup service (direct fetch)'
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
