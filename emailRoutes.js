// emailRoutes.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const cheerio = require('cheerio');

// Base Graph endpoint: first 60 messages, includes webLink
const MESSAGES_URL =
  'https://graph.microsoft.com/v1.0/me/messages'
  + '?$top=60'
  + '&$select=subject,body,from,toRecipients,receivedDateTime,sentDateTime,webLink'
  + '&$orderby=receivedDateTime desc';

// helper: strip quoted reply text from HTML
function stripQuotedText(html) {
  const $ = cheerio.load(html);
  $('img[src^="cid:"]').remove();
  $('[id^="divRplyFwdMsg"], [id^="x_divRplyFwdMsg"], [id*="ms-outlook-mobile-body-separator-line"]').remove();
  $('blockquote').remove();
  const hr = $('hr').first();
  if (hr.length) {
    hr.nextAll().remove();
    hr.remove();
  }
  $('[class^="MsoNormalTable"]').remove();
  $('[class*="MsoNormal"]').each((_, el) => {
    const t = $(el).text().trim();
    if (/^\s*(Με εκτίμηση|regards|Thanks|Cheers)/i.test(t)) {
      $(el).nextAll().remove();
      $(el).remove();
    }
  });
  return $.html();
}

// helper: fetch up to ~4,000 messages via paging
async function fetchAllMessages(initialUrl, accessToken) {
  let all = [];
  let url = initialUrl;
  let page = 0;

  while (url) {
    page += 1;
    console.log(`[fetchAllMessages] page ${page}: ${url}`);
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    all = all.concat(res.data.value);
    url = res.data['@odata.nextLink'] || null;
    if (all.length > 4000) break;
  }

  console.log(`[fetchAllMessages] fetched ${all.length} messages`);
  return all;
}

const router = express.Router();

// GET /email/history?email=address@example.com&subject=optional
// Renders a view with messages exchanged with the specified address
router.get('/history', async (req, res) => {
  try {
    const accessToken = req.session.user.accessToken;
    const targetEmail  = (req.query.email   || '').toLowerCase();
    const subjectQuery = (req.query.subject || '').toLowerCase();

    // no email provided: render empty search form
    if (!targetEmail) {
      return res.render('search-email', { user: req.session.user, results: null, query: '', subject: '' });
    }

    // fetch first page of messages
    const initialRes = await axios.get(MESSAGES_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    let msgs = initialRes.data.value;

    // filter to/from the target
    msgs = msgs.filter(m => {
      const from = m.from?.emailAddress?.address.toLowerCase() || '';
      const toMatch = (m.toRecipients || []).some(r => r.emailAddress?.address.toLowerCase() === targetEmail);
      return from === targetEmail || toMatch;
    });

    // optional subject filter
    if (subjectQuery) {
      msgs = msgs.filter(m => m.subject?.toLowerCase().includes(subjectQuery));
    }

    // sort newest first & strip quoted HTML
    const results = msgs
      .sort((a,b) => new Date(b.receivedDateTime || b.sentDateTime) - new Date(a.receivedDateTime || a.sentDateTime))
      .map(m => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        toRecipients: m.toRecipients,
        receivedDateTime: m.receivedDateTime,
        sentDateTime: m.sentDateTime,
        webLink: m.webLink,
        body: { content: stripQuotedText(m.body.content || '') }
      }));

    res.render('search-email', { user: req.session.user, results, query: targetEmail, subject: subjectQuery });
  } catch(err) {
    console.error(err);
    res.status(500).send('Email history fetch failed');
  }
});

// GET /email/expand?email=address@example.com&subject=optional
// Returns full JSON array of all pages for client-side display
router.get('/expand', async (req, res) => {
  try {
    const targetEmail  = (req.query.email   || '').toLowerCase();
    const subjectQuery = (req.query.subject || '').toLowerCase();
    const accessToken  = req.session.user.accessToken;

    if (!targetEmail) {
      return res.status(400).json([]);
    }

    // fetch all pages
    let all = await fetchAllMessages(MESSAGES_URL, accessToken);

    // filter as above
    all = all.filter(m => {
      const from = m.from?.emailAddress?.address.toLowerCase() || '';
      const toMatch = (m.toRecipients || []).some(r => r.emailAddress?.address.toLowerCase() === targetEmail);
      return from === targetEmail || toMatch;
    });
    if (subjectQuery) all = all.filter(m => m.subject?.toLowerCase().includes(subjectQuery));

    // strip quoted text
    const results = all.map(m => ({
      id: m.id,
      subject: m.subject || '',
      from: m.from,
      toRecipients: m.toRecipients,
      receivedDateTime: m.receivedDateTime,
      sentDateTime: m.sentDateTime,
      webLink: m.webLink,
      body: { content: stripQuotedText(m.body.content || '') }
    }));

    res.json(results);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

/*
To mount in your main server.js:

const emailRouter = require('./emailRoutes');
app.use('/email', ensureAuthenticated, emailRouter);
*/
