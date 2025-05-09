// dialpadRoutes.js
require('dotenv').config();
const express = require('express');
const router  = express.Router();
const axios = require('axios');
const csv = require('csvtojson');

const normalize = n => n ? n.toString().replace(/[^0-9+]/g, '') : '';
// helper: turn "2025-05-07 09:31:32.049899" → "2025-05-07T09:31:32.049899Z"
function toISO(s) {
  if (!s) return null;
  const t = s.replace(' ', 'T');
  return t.endsWith('Z') ? t : t + 'Z';
}

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
  //console.log(records);
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
  //console.log(users);
  return users;
}

// GET /history/all?days=30
// Returns { users: [ { id, name, callHistory, chatHistory }, … ] }
router.get('/history/all', async (req, res) => {
  console.log('/history/all called')
  try {
    const days = parseInt(req.query.days) || 30;
    const allUsers = await fetchAllUsers();
    
    const userPromises = allUsers.map(async u => {
      const [calls, texts] = await Promise.all([
        fetchStats(u.id, 'calls', days),
        fetchStats(u.id, 'texts', days)
      ]);
      return {
        id:          u.id,
        name:        u.name,
        email:       u.email,
        callHistory: calls,
        chatHistory: texts
      };
    });
    const results = await Promise.all(userPromises);

    res.json({ users: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


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

// NEW: GET /history/view?phone=…&days=…
router.get('/history/view', async (req, res) => {
  try {
    const rawPhone = (req.query.phone || '').trim();
    const target   = normalize(rawPhone);
    const days     = parseInt(req.query.days, 10) || 30;

    // If no phone, just render empty form
    if (!target) {
      return res.render('dialpad-history', {
        user:   req.session.user,
        query:  '',    // for the input value
        days,
        messages: []
      });
    }

    // 1) fetch users
    const allUsers = await fetchAllUsers();

    // 2) for each user, in parallel, pull calls+texts
    const rawResults = await Promise.all(
      allUsers.map(async u => {
        const [calls, texts] = await Promise.all([
          fetchStats(u.id, 'calls', days),
          fetchStats(u.id, 'texts', days)
        ]);
        return { user: u, calls, texts };
      })
    );
    

    // 3) filter + normalize into a flat array
    const messages = [];
    rawResults.forEach(({ user, calls, texts }) => {
      calls.forEach(c => {
        if (
          normalize(c.external_number) === target ||
          normalize(c.internal_number) === target
        ) {
          messages.push({
            type:      'call',
            id:        c.id || c.call_id,
            direction: c.direction,                // 'inbound' | 'outbound'
            phone:     normalize(c.external_number) === target 
                         ? c.internal_number 
                         : c.external_number,
            time:      toISO(c.date_started),                     // ← use `date_started`
            duration:  c.talk_duration                             // seconds
          });
        }
      });
      texts.forEach(t => {
        if (
          normalize(t.from_phone) === target ||
          normalize(t.to_phone)   === target
        ) {
          console.log(t);
          messages.push({
            type:      'text',
            id:        t.id,
            direction: t.direction,
            phone:     normalize(t.from_phone) === target 
                         ? t.to_phone 
                         : t.from_phone,
            time:      toISO(t.date),                             // ← use `date`
            body:      t.encrypted_aes_text || t.body || t.text
          });
        }
      });
    });

    // 4) sort newest → oldest
    messages.sort((a, b) => new Date(b.time) - new Date(a.time));

    // 5) render into the EJS view
    res.render('dialpad-history', {
      user:     req.session.user,
      query:    rawPhone,
      days,
      messages
    });
  } catch (err) {
    console.error('Dialpad history error:', err);
    res.status(500).send('Failed to fetch Dialpad history');
  }
});

module.exports = router;
