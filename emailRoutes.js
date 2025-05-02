// emailRoutes.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

// Utility to strip quoted reply text from HTML
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
    const text = $(el).text().trim();
    if (/^\s*(Με εκτίμηση|regards|Thanks|Cheers)/i.test(text)) {
      $(el).nextAll().remove();
      $(el).remove();
    }
  });
  return $.html();
}

const router = express.Router();

// GET /email/history?email=<emailAddress>&subject=<optional>
// Renders view of email interactions across specified mailboxes

router.get('/history', async (req, res) => {
  try {
    const targetEmail = (req.query.email || '').trim().toLowerCase();
    const subjectQuery = (req.query.subject || '').trim().toLowerCase();

    // Render empty form if no email provided
    if (!targetEmail) {
      return res.render('email-history', {
        user: req.session.user,
        results: null,
        query: '',
        subject: ''
      });
    }

    // Build search clause
    let clause = `from:${targetEmail} OR to:${targetEmail}`;
    if (subjectQuery) clause += ` AND ${subjectQuery}`;
    clause = `"${clause}"`;

    // Define mailboxes to query
    const mailboxes = [
      'achilleas@delendaest.co.uk',
      'helen@delendaest.co.uk'
    ];

    const headers = {
      Authorization: `Bearer ${req.session.user.accessToken}`,
      ConsistencyLevel: 'eventual'
    };

    let allResults = [];

    // Query each mailbox
    for (const mailbox of mailboxes) {
      const url =
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages` +
        `?$search=${encodeURIComponent(clause)}` +
        `&$count=true&$top=50`;
      try {
        const resp = await axios.get(url, { headers });
        const msgs = resp.data.value
          .filter(m => !m.isDraft)
          .map(m => ({
            mailbox,
            id: m.id,
            subject: m.subject || '',
            from: m.from,
            toRecipients: m.toRecipients,
            receivedDateTime: m.receivedDateTime,
            webLink: m.webLink,
            body: { content: stripQuotedText(m.body.content || '') }
          }));
        allResults.push(...msgs);
      } catch (err) {
        if (err.response?.status === 403) {
          console.warn(`Skipping ${mailbox}: no access`);
          continue;
        }
        throw err;
      }
    }

    // Sort newest first and apply optional subject filter again if needed
    allResults.sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    if (subjectQuery) {
      allResults = allResults.filter(m => m.subject.toLowerCase().includes(subjectQuery));
    }

    // Render results
    res.render('email-history', {
      user: req.session.user,
      results: allResults,
      query: targetEmail,
      subject: subjectQuery
    });
  } catch (error) {
    console.error('Email history error:', error);
    res.status(500).send('Failed to fetch email history');
  }
});

module.exports = router;
