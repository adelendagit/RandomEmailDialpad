require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('querystring');

const app = express();
const port = 3000;

// Redirect to Microsoft login
app.get('/auth', (req, res) => {
  const authUrl = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?${qs.stringify({
    client_id: process.env.CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.REDIRECT_URI,
    response_mode: 'query',
    scope: 'https://graph.microsoft.com/Files.ReadWrite.All offline_access',
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
        scope: 'https://graph.microsoft.com/Files.ReadWrite.All offline_access',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: 'authorization_code',
        client_secret: process.env.CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const accessToken = tokenResponse.data.access_token;

    // Example: List files from OneDrive root
    const graphResponse = await axios.get('https://graph.microsoft.com/v1.0/me/drive/root/children', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    res.json({
      message: 'Successfully authenticated!',
      files: graphResponse.data.value
    });

  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.status(500).send('Authentication failed.');
  }
});

app.listen(port, () => {
  console.log(`App listening at http://localhost:${port}`);
});
