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
  for (let i = 1; i <= 10; i++) {
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

const router = express.Router();

// full history
router.get('/history/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const days   = parseInt(req.query.days)||30;
    const [calls, texts] = await Promise.all([
      fetchStats(userId,'calls',days),
      fetchStats(userId,'texts',days)
    ]);
    res.json({ callHistory: calls, chatHistory: texts });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// per-contact history
router.get('/history/:userId/with/:contactNumber', async (req, res) => {
  try {
    const { userId, contactNumber } = req.params;
    const days = parseInt(req.query.days)||30;
    const [allCalls, allTexts] = await Promise.all([
      fetchStats(userId,'calls',days),
      fetchStats(userId,'texts',days)
    ]);

    const normalize = n => n? n.toString().replace(/[^0-9+]/g,'') : '';
    const target = normalize(contactNumber);

    const calls = allCalls.filter(c=>
      normalize(c.from_number)===target ||
      normalize(c.to_number)  ===target
    );
    const texts = allTexts.filter(t=>
      normalize(t.from_number)===target ||
      normalize(t.to_number)  ===target
    );

    res.json({ calls, texts });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
