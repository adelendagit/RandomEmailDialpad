// dialpadRoutes.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const csv = require('csvtojson');

const DIALPAD_API = axios.create({
  baseURL: 'https://dialpad.com/api/v2',
  headers: {
    Authorization: `Bearer ${process.env.DIALPAD_BEARER_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function fetchStats(userId, statType, days = 30) {
  console.log(`[fetchStats] ${statType} for user=${userId} (${days}d)`);
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
  let statusRes;
  for (let i = 1; i <= 5; i++) {
    statusRes = (await DIALPAD_API.get(`/stats/${requestId}`)).data;
    console.log(`  poll#${i}: ${statusRes.status}`);
    if (['complete','completed'].includes(statusRes.status)) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  if (!['complete','completed'].includes(statusRes.status)) {
    throw new Error(`Stats[${statType}] timed out (${statusRes.status})`);
  }
  const csvText = (await axios.get(statusRes.download_url)).data;
  const records = await csv().fromString(csvText);
  console.log(`  got ${records.length} ${statType} records`);
  return records;
}

// returns the JSON transcript (including “moments”) for a call
async function fetchTranscript(callId) {
  console.log(`[fetchTranscript] callId=${callId}`);
  const { data } = await DIALPAD_API.get(`/transcripts/${callId}`);
  return data;
}

// fetchAllUsers: returns an array of user objects ({ id, name, email, … })
// returns an array of all users, paging via the `cursor` field
// Helper: list all users, paging via the `cursor` field and reading `items[]`
async function fetchAllUsers() {
  let users  = [];
  let cursor = null;

  do {
    console.log(`[fetchAllUsers] fetching cursor=${cursor}`);
    const params = { limit: 100 };
    if (cursor) params.cursor = cursor;

    const resp = await DIALPAD_API.get('/users', { params });
    const data = resp.data;

    // this API returns { items: [...], cursor: "…" }
    const batch = Array.isArray(data.items) ? data.items : [];
    users.push(...batch);

    cursor = data.cursor;    // loop until no more cursor
  } while (cursor);

  console.log(`[fetchAllUsers] total users = ${users.length}`);
  console.log(users);
  return users;
}

const router = express.Router();

// GET /history/all?days=30
// Returns { users: [ { id, name, callHistory, chatHistory }, … ] }
router.get('/history/all', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const allUsers = await fetchAllUsers();
    const results = [];

    // You may want to throttle or batch these in production
    for (const u of allUsers) {
      console.log(`[route /history/all] fetching for user ${u.id}`);
      const [calls, texts] = await Promise.all([
        fetchStats(u.id, 'calls', days),
        fetchStats(u.id, 'texts', days)
      ]);

      results.push({
        id:          u.id,
        name:        u.name,
        email:       u.email,
        callHistory: calls,
        chatHistory: texts
      });
    }

    res.json({ users: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// full history
// router.get('/history/:userId', async (req, res) => {
//   console.log('/history/:userId called')
//   try {
//     const userId = req.params.userId;
//     console.log(userId);
//     const days   = parseInt(req.query.days)||30;
//     const [calls, texts] = await Promise.all([
//       fetchStats(userId,'calls',days),
//       fetchStats(userId,'texts',days)
//     ]);
//     res.json({ callHistory: calls, chatHistory: texts });
//   } catch(err) {
//     console.error(err);
//     res.status(500).json({ error: err.message });
//   }
// });

// GET /history/all/with/:contactNumber?days=30
// Returns only users who’ve interacted with that number, and only the matching records
router.get('/history/all/with/:contactNumber', async (req, res) => {
  try {
    const days          = parseInt(req.query.days) || 30;
    const contactNumber = req.params.contactNumber;
    const normalize     = n => n ? n.toString().replace(/[^0-9+]/g, '') : '';
    const target        = normalize(contactNumber);

    console.log(`[route /history/all/with] contact=${contactNumber}, days=${days}`);

    const allUsers = await fetchAllUsers();    // as defined previously
    const results  = [];

    for (const u of allUsers) {
      console.log(`  checking user ${u.id}`);
      const [calls, texts] = await Promise.all([
        fetchStats(u.id, 'calls', days),
        fetchStats(u.id, 'texts', days)
      ]);

      // filter each user’s arrays
      const callsWithContact = calls.filter(c =>
        normalize(c.external_number) === target ||
        normalize(c.internal_number)   === target
      );
      const textsWithContact = texts.filter(t =>
        normalize(t.from_phone) === target ||
        normalize(t.to_phone)   === target
      );

      // only include users who have at least one interaction
      if (callsWithContact.length || textsWithContact.length) {
        results.push({
          id:          u.id,
          name:        u.name,
          email:       u.email,
          callHistory: callsWithContact,
          chatHistory: textsWithContact
        });
      }
    }

    console.log(`[route /history/all/with] found ${results.length} users with interactions`);
    res.json({ users: results });
  }
  catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// per-contact history
// router.get('/history/:userId/with/:contactNumber', async (req, res) => {
//   try {
//     const { userId, contactNumber } = req.params;
//     const days = parseInt(req.query.days)||30;
//     const [allCalls, allTexts] = await Promise.all([
//       fetchStats(userId,'calls',days),
//       fetchStats(userId,'texts',days)
//     ]);

//     const normalize = n => n? n.toString().replace(/[^0-9+]/g,'') : '';
//     const target = normalize(contactNumber);

//     const calls = allCalls.filter(c=>
//       normalize(c.external_number)===target ||
//       normalize(c.internal_number)  ===target
//     );
//     const texts = allTexts.filter(t=>
//       normalize(t.from_phone)===target ||
//       normalize(t.to_phone)  ===target
//     );

//     res.json({ calls, texts });
//   } catch(err) {
//     console.error(err);
//     res.status(500).json({ error: err.message });
//   }
// });

// GET  /transcripts/:callId
// Proxy to Dialpad’s /transcripts/{call_id} endpoint
router.get('/transcripts/:callId', async (req, res) => {
  try {
    const { callId } = req.params;
    const transcript = await fetchTranscript(callId);
    res.json(transcript);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
