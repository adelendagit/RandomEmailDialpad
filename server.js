require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const session = require('express-session');
const cheerio = require('cheerio');

const app = express();
const port = 3000;

function stripQuotedText(html) {
  const $ = cheerio.load(html);

  // Remove Outlook-style reply blocks
  $('[id^="divRplyFwdMsg"]').remove();
  $('[id^="x_divRplyFwdMsg"]').remove();
  $('[id*="ms-outlook-mobile-body-separator-line"]').remove();

  // Remove all <blockquote> elements (Gmail etc.)
  $('blockquote').remove();

  // Remove <hr> or sections with 'From:', 'Sent:', 'Subject:'
  $('hr').each(function () {
    const next = $(this).nextAll();
    let foundMeta = false;
    next.each(function () {
      const text = $(this).text();
      if (/from:|sent:|to:|subject:/i.test(text)) {
        foundMeta = true;
      }
    });
    if (foundMeta) {
      $(this).nextAll().remove();
      $(this).remove();
    }
  });

  // Remove Outlook name divs and tables (signatures)
  $('[class^="MsoNormalTable"]').remove();
  $('[class*="MsoNormal"]').each((_, el) => {
    const text = $(el).text().trim();
    if (/^\s*Με εκτίμηση|^Best regards|Kind regards|Thanks/i.test(text)) {
      $(el).nextAll().remove();
      $(el).remove();
    }
  });

  return $.html();
}

app.use(session({
  secret: `${process.env.EXPRESS_SESSION_SECRET}`, // change this to something secure in production
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // secure: true only if using HTTPS
}));

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');


// Redirect to Microsoft login
app.get('/auth', (req, res) => {
  const authUrl = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?${qs.stringify({
    client_id: process.env.CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.REDIRECT_URI,
    response_mode: 'query',
    //scope: 'https://graph.microsoft.com/Files.ReadWrite.All offline_access',
    //scope: 'https://graph.microsoft.com/Sites.Read.All offline_access',
    scope: 'https://graph.microsoft.com/Sites.Read.All Mail.Send offline_access',
    state: '12345' // Optional: CSRF protection
  })}`;
  res.redirect(authUrl);
});

// Callback from Microsoft
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: process.env.CLIENT_ID,
        //scope: 'https://graph.microsoft.com/Files.ReadWrite.All offline_access',
        //scope: 'https://graph.microsoft.com/Sites.Read.All offline_access',
        scope: 'https://graph.microsoft.com/Sites.Read.All Mail.Send offline_access',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: 'authorization_code',
        client_secret: process.env.CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;

    // Get the current user's info from Graph
    const userResponse = await axios.get('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const userId = userResponse.data.id;
    const displayName = userResponse.data.displayName;
    const userEmail = userResponse.data.mail || userResponse.data.userPrincipalName;

    req.session.user = {
      id: userId,
      name: displayName,
      email: userEmail,
      accessToken,
      refreshToken
    };


    //res.redirect('/shared-libraries');
    //res.redirect('/dashboard');
    res.redirect('/');

  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed.');
  }
});

app.get('/files', async (req, res) => {
  const user = req.session.user;

  if (!user || !user.accessToken) {
    return res.redirect('/auth');
  }

  try {
    const graphResponse = await axios.get('https://graph.microsoft.com/v1.0/me/drive/root/children', {
      headers: { Authorization: `Bearer ${user.accessToken}` }
    });

    const files = graphResponse.data.value;
    res.render('files', { files, user });
  } catch (error) {
    console.error('Failed to fetch files:', error.response?.data || error.message);
    res.status(500).send('Could not fetch files.');
  }
});

app.get('/shared-libraries', async (req, res) => {
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');

  try {
    const siteResponse = await axios.get('https://graph.microsoft.com/v1.0/sites?search=*', {
      headers: { Authorization: `Bearer ${user.accessToken}` }
    });

    const sites = siteResponse.data.value;

    // Optionally: fetch document libraries (drives) for each site
    const siteData = await Promise.all(
      sites.map(async site => {
        const driveRes = await axios.get(`https://graph.microsoft.com/v1.0/sites/${site.id}/drives`, {
          headers: { Authorization: `Bearer ${user.accessToken}` }
        });

        return {
          name: site.name,
          webUrl: site.webUrl,
          id: site.id, // <-- ADD this
          drives: driveRes.data.value
        };
      })
    );

    res.render('shared', { sites: siteData, user });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Error fetching shared libraries.');
  }
});

app.get('/shared-library/:siteId/:driveId', async (req, res) => {
  const { siteId, driveId } = req.params;
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');

  try {
    const filesRes = await axios.get(`https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/root/children`, {
      headers: { Authorization: `Bearer ${user.accessToken}` }
    });

    const items = filesRes.data.value;

    res.render('library', { items, siteId, driveId, user });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Could not fetch shared library contents.');
  }
});

app.get('/shared-library/:siteId/:driveId/folder/:itemId', async (req, res) => {
  const { siteId, driveId, itemId } = req.params;
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');

  try {
    const folderRes = await axios.get(`https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${itemId}/children`, {
      headers: { Authorization: `Bearer ${user.accessToken}` }
    });

    const items = folderRes.data.value;
    res.render('library', { items, siteId, driveId, user });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Could not fetch folder contents.');
  }
});

app.get('/send-email', (req, res) => {
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');
  res.render('send-email', { user });
});

app.post('/send-email', express.urlencoded({ extended: true }), async (req, res) => {
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');

  const { to, subject, body } = req.body;

  const message = {
    message: {
      subject,
      body: {
        contentType: "Text",
        content: body
      },
      toRecipients: [
        {
          emailAddress: {
            address: to
          }
        }
      ]
    }
  };

  try {
    await axios.post('https://graph.microsoft.com/v1.0/me/sendMail', message, {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    res.send('<p>Email sent successfully! <a href="/send-email">Send another</a></p>');
  } catch (err) {
    console.error('Error sending email:', err.response?.data || err.message);
    res.status(500).send('Failed to send email.');
  }
});

app.get('/search-emails', (req, res) => {
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');
  res.render('search-email', { user, results: null, query: null });
});

// app.post('/search-emails', express.urlencoded({ extended: true }), async (req, res) => {
//   const user = req.session.user;
//   if (!user || !user.accessToken) return res.redirect('/auth');

//   const targetEmail = req.body.email?.toLowerCase();
//   if (!targetEmail) return res.redirect('/search-emails');

//   try {
//     const response = await axios.get(
//       `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=100`,
//       {
//         headers: { Authorization: `Bearer ${user.accessToken}` }
//       }
//     );

//     const allMessages = response.data.value;

//     const relevantMessages = allMessages.filter(msg =>
//       msg.from?.emailAddress?.address?.toLowerCase() === targetEmail ||
//       msg.toRecipients?.some(r => r.emailAddress?.address?.toLowerCase() === targetEmail)
//     );

//     const messages = relevantMessages.sort((a, b) =>
//       new Date(b.receivedDateTime) - new Date(a.receivedDateTime)
//     );

//     res.render('search-email', { user, results: messages, query: targetEmail });
//   } catch (error) {
//     console.error('Timeline error:', error.response?.data || error.message);
//     res.status(500).send('Error building timeline.');
//   }
// });
app.post('/search-emails', express.urlencoded({ extended: true }), async (req, res) => {
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');

  const targetEmail = req.body.email?.toLowerCase();
  if (!targetEmail) return res.redirect('/search-emails');

  try {
    const [inboxResponse, sentResponse] = await Promise.all([
      axios.get(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=50`, {
        headers: { Authorization: `Bearer ${user.accessToken}` }
      }),
      axios.get(`https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?$top=50`, {
        headers: { Authorization: `Bearer ${user.accessToken}` }
      })
    ]);

    const combinedMessages = [...inboxResponse.data.value, ...sentResponse.data.value];

    const relevantMessages = combinedMessages.filter(msg =>
      msg.from?.emailAddress?.address?.toLowerCase() === targetEmail ||
      msg.toRecipients?.some(r => r.emailAddress?.address?.toLowerCase() === targetEmail)
    );

    // const messages = relevantMessages.sort((a, b) =>
    //   new Date(b.receivedDateTime || b.sentDateTime) - new Date(a.receivedDateTime || a.sentDateTime)
    // );
    const messages = relevantMessages.sort((a, b) =>
      new Date(b.receivedDateTime || b.sentDateTime) - new Date(a.receivedDateTime || a.sentDateTime)
    ).map(msg => ({
      ...msg,
      body: {
        ...msg.body,
        content: stripQuotedText(msg.body?.content || '')
      }
    }));


    res.render('search-email', { user, results: messages, query: targetEmail });
  } catch (error) {
    console.error('Timeline error:', error.response?.data || error.message);
    res.status(500).send('Error building timeline.');
  }
});

app.get('/dashboard', async (req, res) => {
  const user = req.session.user;
  if (!user || !user.accessToken) return res.redirect('/auth');

  let photoDataUrl = null;

  try {
    const photoResponse = await axios.get('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      responseType: 'arraybuffer'
    });

    const photoBase64 = Buffer.from(photoResponse.data, 'binary').toString('base64');
    photoDataUrl = `data:image/jpeg;base64,${photoBase64}`;
  } catch (err) {
    console.warn('No profile photo found or error loading photo.');
  }

  res.render('dashboard', { user, photoDataUrl });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/', (req, res) => {
  const user = req.session.user;
  if (user && user.accessToken) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/auth');
  }
});

app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});
