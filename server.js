require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const session = require('express-session');


const app = express();
const port = 3000;

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
    scope: 'https://graph.microsoft.com/Sites.Read.All offline_access',
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
        scope: 'https://graph.microsoft.com/Sites.Read.All offline_access',
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

    // Save to session
    req.session.user = {
      id: userId,
      name: displayName,
      accessToken,
      refreshToken
    };

    res.redirect('/shared-libraries');


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

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});


app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});
