// api/transcript-backup.js
// Backup transcript service using youtube-transcript-api (via youtube-transcript.io)
// This is a SEPARATE endpoint - does NOT modify existing transcript services

import TranscriptClient from 'youtube-transcript-api';

// Singleton client instance
let client = null;

async function getClient() {
  if (!client) {
    client = new TranscriptClient();
    await client.ready;
  }
  return client;
}

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
    console.log('Backup Transcript Service (youtube-transcript-api) called');

    const { videoId, lang = 'en' } = req.body;

    if (!videoId) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(400).json({ error: 'Missing required parameter: videoId' });
      return;
    }

    console.log('Processing video: ' + videoId);

    // Get or initialize client
    const transcriptClient = await getClient();

    // Fetch transcript
    const result = await transcriptClient.getTranscript(videoId);

    if (!result || !result.tracks || result.tracks.length === 0) {
      throw new Error('No transcript tracks found');
    }

    // Find the requested language track (or first available)
    const track = result.tracks.find(t => t.language === lang) || result.tracks[0];

    if (!track || !track.segments || track.segments.length === 0) {
      throw new Error('No transcript segments found');
    }

    // Combine segments into full transcript
    const transcript = track.segments.map(s => s.text).join(' ');

    console.log('Transcript extracted: ' + transcript.length + ' characters');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      success: true,
      data: {
        transcript: transcript,
        segments: track.segments.length,
        language: track.language || lang,
        source: 'youtube-transcript-api',
        videoId: videoId,
        videoTitle: result.title || 'Unknown',
        availableLanguages: result.languages || []
      },
      message: 'Transcript extracted via backup service'
    });

  } catch (error) {
    console.error('Backup service error:', error.message);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Backup transcript extraction failed',
      hint: 'This video may not have captions available.'
    });
  }
}
