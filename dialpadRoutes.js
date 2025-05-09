// dialpadRoutes.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry');
// Dynamic import wrapper for p-map (ESM-only)
const pMap = async (iterable, mapper, options) => {
  const mod = await import('p-map');
  return mod.default(iterable, mapper, options);
};

const csv = require('csvtojson');
const LRU = require('lru-cache');

// Configure Dialpad API client
const DIALPAD_API = axios.create({
  baseURL: 'https://dialpad.com/api/v2',
  timeout: 120000, // 2 minutes
  headers: {
    Authorization: `Bearer ${process.env.DIALPAD_BEARER_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// Retry on network errors or 429s
axiosRetry(DIALPAD_API, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: err => axiosRetry.isNetworkOrIdempotentRequestError(err) || err.response?.status === 429
});

// In-memory cache for stats
const statsCache = new LRU({ max: 500, maxAge: 1000 * 60 * 60 }); // 1 hour

// Poll the stats status until complete, with exponential backoff
async function pollStats(requestId, maxAttempts = 8) {
  let attempt = 0;
  while (attempt++ < maxAttempts) {
    const { data } = await DIALPAD_API.get(`/stats/${requestId}`);
    if (['complete', 'completed'].includes(data.status)) return data;
    await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 500 + Math.random() * 500));
  }
  throw new Error(`Stats request ${requestId} did not complete after ${maxAttempts} attempts`);
}

// Fetch call/text stats for a user, with caching and streaming CSV parse
async function fetchStats(userId, statType, days = 30) {
  const cacheKey = `${userId}:${statType}:${days}`;
  if (statsCache.has(cacheKey)) {
    return statsCache.get(cacheKey);
  }

  const { data: post } = await DIALPAD_API.post('/stats', {
    export_type: 'records',
    stat_type: statType,
    target_type: 'user',
    target_id: userId,
    days_ago_start: days,
    days_ago_end: 0,
    timezone: 'UTC'
  });
  const requestId = post.id || post.request_id;
  const status = await pollStats(requestId);

  const response = await axios.get(status.download_url, { responseType: 'stream', timeout: 180000 });
  const parser = csv({ trim: true }).fromStream(response.data);

  const records = [];
  for await (const rec of parser) {
    records.push(rec);
  }

  statsCache.set(cacheKey, records);
  return records;
}

// Fetch full JSON transcript for a call
async function fetchTranscript(callId) {
  const { data } = await DIALPAD_API.get(`/transcripts/${callId}`);
  return data;
}

// Fetch all users, paging via cursor
async function fetchAllUsers() {
  let users = [];
  let cursor = null;

  do {
    const params = { limit: 100 };
    if (cursor) params.cursor = cursor;
    const resp = await DIALPAD_API.get('/users', { params });
    const data = resp.data;
    if (Array.isArray(data.items)) {
      users.push(...data.items);
    }
    cursor = data.cursor;
  } while (cursor);

  return users;
}

const router = express.Router();

// GET /history/all?days=30
// Returns all users with their call and text histories
router.get('/history/all', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const allUsers = await fetchAllUsers();

    const results = [];
    await pMap(allUsers, async u => {
      try {
        const [calls, texts] = await Promise.all([
          fetchStats(u.id, 'calls', days),
          fetchStats(u.id, 'texts', days)
        ]);
        results.push({ id: u.id, name: u.name, email: u.email, callHistory: calls, chatHistory: texts });
      } catch (err) {
        console.error(`User ${u.id} failed:`, err.message);
      }
    }, { concurrency: 5 });

    res.json({ users: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /history/all/with/:contactNumber?days=30
// Returns only users who've interacted with the given number
router.get('/history/all/with/:contactNumber', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const normalize = n => n ? n.toString().replace(/[^0-9+]/g, '') : '';
    const target = normalize(req.params.contactNumber);

    const allUsers = await fetchAllUsers();
    const results = [];

    await pMap(allUsers, async u => {
      try {
        const [calls, texts] = await Promise.all([
          fetchStats(u.id, 'calls', days),
          fetchStats(u.id, 'texts', days)
        ]);

        const callsWith = calls.filter(c =>
          normalize(c.external_number) === target ||
          normalize(c.internal_number) === target
        );
        const textsWith = texts.filter(t =>
          normalize(t.from_phone) === target ||
          normalize(t.to_phone) === target
        );

        if (callsWith.length || textsWith.length) {
          results.push({ id: u.id, name: u.name, email: u.email, callHistory: callsWith, chatHistory: textsWith });
        }
      } catch (err) {
        console.error(`User ${u.id} filter failed:`, err.message);
      }
    }, { concurrency: 5 });

    res.json({ users: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /transcripts/:callId
// Proxy to Dialpad's transcript endpoint
router.get('/transcripts/:callId', async (req, res) => {
  try {
    const transcript = await fetchTranscript(req.params.callId);
    res.json(transcript);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
