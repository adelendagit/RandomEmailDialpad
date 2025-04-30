require("dotenv").config();
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const session = require("express-session");
const cheerio = require("cheerio");
const FileStore = require('session-file-store')(session);
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Base Graph endpoint: first 60 messages, includes webLink
const MESSAGES_URL =
  "https://graph.microsoft.com/v1.0/me/messages" +
  "?$top=60" +
  "&$select=subject,body,from,toRecipients,receivedDateTime,sentDateTime,webLink" +
  "&$orderby=receivedDateTime desc";

// ——— Helpers ——————————————————————————————————————————————

function stripQuotedText(html) {
  const $ = cheerio.load(html);
  $('img[src^="cid:"]').remove();
  $('[id^="divRplyFwdMsg"], [id^="x_divRplyFwdMsg"], [id*="ms-outlook-mobile-body-separator-line"]').remove();
  $("blockquote").remove();
  const hr = $("hr").first();
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

async function fetchAllMessages(initialUrl, accessToken) {
  let all = [];
  let url = initialUrl;
  let page = 0;
  while (url) {
    page += 1;
    console.log(`Fetching page ${page}: ${url}`);
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    all = all.concat(res.data.value);
    url = res.data['@odata.nextLink'] || null;
    if (all.length > 4000) break;
  }
  console.log(`Fetched a total of ${all.length} messages.`);
  return all;
}

// ——— Authentication Middleware —————————————————————————————————

// function ensureAuthenticated(req, res, next) {
//   if (!req.session.user?.accessToken) {
//     req.session.returnTo = req.originalUrl;
//     return res.redirect("/auth");
//   }
//   next();
// }
// function ensureAuthenticated(req, res, next) {
//   const hasToken = !!req.session.user?.accessToken;
//   console.log(`✔️ ensureAuthenticated: hasToken=${hasToken}`);
//   if (!hasToken) {
//     console.log("↩️  redirecting to /auth from", req.originalUrl);
//     req.session.returnTo = req.originalUrl;
//     return res.redirect("/auth");
//   }
//   next();
// }
async function ensureAuthenticated(req, res, next) {
  const user = req.session.user;
  // if we’ve never logged in or have no refresh token, force interactive
  if (!user?.refreshToken) {
    req.session.returnTo = req.originalUrl;
    return res.redirect("/auth");
  }

  // refresh every ~50 minutes (tokens good for 60 min)
  const now        = Date.now();
  const age        = now - (user.tokenObtainedAt || 0);
  const fiftyMins  = 50 * 60 * 1000;
  if (age > fiftyMins) {
    try {
      const resp = await axios.post(
        `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
        qs.stringify({
          client_id:     process.env.CLIENT_ID,
          grant_type:    "refresh_token",
          refresh_token: user.refreshToken,
          client_secret: process.env.CLIENT_SECRET,
          scope:         "openid profile User.Read Mail.Read Mail.Send offline_access Sites.Read.All"
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      // swap in new tokens & timestamp
      user.accessToken     = resp.data.access_token;
      user.refreshToken    = resp.data.refresh_token;
      user.tokenObtainedAt = now;
      req.session.user     = user;
      console.log("🔄 Refreshed token for", user.email);
    }
    catch (err) {
      console.error("❌ Refresh failed:", err.response?.data || err.message);
      // drop session and re-auth
      delete req.session.user;
      req.session.returnTo = req.originalUrl;
      return res.redirect("/auth");
    }
  }

  // still valid, or we just refreshed
  next();
}

// ——— App Setup ——————————————————————————————————————————————

app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new FileStore({
      path: './sessions',        // directory to hold session files
      ttl: 30 * 24 * 60 * 60     // 30 days in seconds
    }),
    secret: process.env.EXPRESS_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,            // HTTPS only
      httpOnly: true,
      sameSite: 'none',        // allow in Trello iframe
      maxAge: 30 * 24 * 60 * 60 * 1000  // 30 days in ms
    }
  })
);
// list all the origins you want to allow
const allowedOrigins = [
  'https://trello.com',
  'https://hotspotsuk.co.uk'
];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (e.g. mobile apps, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS denied for origin ${origin}`));
  },
  credentials: true
}));


// app.use(
//   session({
//     secret: process.env.EXPRESS_SESSION_SECRET,
//     resave: false,
//     saveUninitialized: true,
//     cookie: {
//       secure: true,    // only send over HTTPS
//       sameSite: 'none',// allow in Trello.com’s iframe
//       httpOnly: true   // standard best practice
//     }
//   })
// );

// app.use(
//   session({
//     secret: process.env.EXPRESS_SESSION_SECRET,
//     resave: false,
//     saveUninitialized: true,
//     cookie: { secure: false }
//   })
// );
app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

// ——— OAuth ——————————————————————————————————————————————

app.get("/auth", (req, res) => {
  const params = qs.stringify({
    client_id: process.env.CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.REDIRECT_URI,
    response_mode: "query",
    scope: "openid profile User.Read Mail.Read Mail.Send offline_access Sites.Read.All",
    state: "12345"
  });
  res.redirect(
    `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?${params}`
  );
});

// app.get("/auth/callback", async (req, res) => {
//   try {
//     const code = req.query.code;
//     const tokenRes = await axios.post(
//       `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
//       qs.stringify({
//         client_id: process.env.CLIENT_ID,
//         scope: "openid profile User.Read Mail.Read Mail.Send offline_access Sites.Read.All",
//         code,
//         redirect_uri: process.env.REDIRECT_URI,
//         grant_type: "authorization_code",
//         client_secret: process.env.CLIENT_SECRET
//       }),
//       { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
//     );

//     const accessToken = tokenRes.data.access_token;
//     const userRes = await axios.get("https://graph.microsoft.com/v1.0/me", {
//       headers: { Authorization: `Bearer ${accessToken}` }
//     });

//     req.session.user = {
//       id: userRes.data.id,
//       name: userRes.data.displayName,
//       email: userRes.data.mail || userRes.data.userPrincipalName,
//       accessToken,
//       refreshToken: tokenRes.data.refresh_token
//     };

//     const redirectTo = req.session.returnTo || "/dashboard";
//     delete req.session.returnTo;
//     //res.redirect(redirectTo);
//     // replace your existing res.redirect(redirectTo) in /auth/callback
//     res.send(`
//       <!DOCTYPE html>
//       <html>
//         <head><meta charset="utf-8"></head>
//         <body>
//           <script>
//             // then close this popup
//             window.close();
//           </script>
//         </body>
//       </html>
//     `);

//   } catch (err) {
//     console.error("Auth callback error:", err.response?.data || err.message);
//     res.status(500).send("Authentication failed.");
//   }
// });
// ─── OAuth callback ──────────────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id:     process.env.CLIENT_ID,
        scope:         "openid profile User.Read Mail.Read Mail.Send offline_access Sites.Read.All",
        code,
        redirect_uri:  process.env.REDIRECT_URI,
        grant_type:    "authorization_code",
        client_secret: process.env.CLIENT_SECRET
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    // grab fresh tokens + timestamp
    const { access_token, refresh_token } = tokenRes.data;
    req.session.user = {
      id:               req.session.user?.id,
      name:             null,   // will fill below
      email:            null,
      accessToken:      access_token,
      refreshToken:     refresh_token,
      tokenObtainedAt:  Date.now()
    };

    // fetch user profile
    const userRes = await axios.get("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    req.session.user.name  = userRes.data.displayName;
    req.session.user.email = userRes.data.mail || userRes.data.userPrincipalName;

    // all set—close the popup and leave the session behind
    res.send(`<!DOCTYPE html><html><body><script>window.close();</script></body></html>`);
  }
  catch (err) {
    console.error("Auth callback error:", err.response?.data || err.message);
    res.status(500).send("Authentication failed.");
  }
});

// right below your other routes
app.get('/auth/status', (req, res) => {
  if (req.session.user?.accessToken) {
    return res.json({ authenticated: true });
  }
  res.status(401).json({ authenticated: false });
});

// ——— Dashboard & Logout ——————————————————————————————————————

app.get("/", ensureAuthenticated, (req, res) => {
  res.redirect("/dashboard");
});

app.get("/dashboard", ensureAuthenticated, async (req, res) => {
  const user = req.session.user;
  let photoDataUrl = null;
  try {
    const photoRes = await axios.get(
      "https://graph.microsoft.com/v1.0/me/photo/$value",
      {
        headers: { Authorization: `Bearer ${user.accessToken}` },
        responseType: "arraybuffer"
      }
    );
    const b64 = Buffer.from(photoRes.data, "binary").toString("base64");
    photoDataUrl = `data:image/jpeg;base64,${b64}`;
  } catch {};
  res.render("dashboard", { user, photoDataUrl });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ——— File + Library Routes ——————————————————————————————————

app.get("/files", ensureAuthenticated, async (req, res) => {
  const user = req.session.user;
  const driveRes = await axios.get(
    "https://graph.microsoft.com/v1.0/me/drive/root/children",
    { headers: { Authorization: `Bearer ${user.accessToken}` } }
  );
  res.render("files", { user, files: driveRes.data.value });
});

app.get("/shared-libraries", ensureAuthenticated, async (req, res) => {
  const user = req.session.user;
  const siteRes = await axios.get(
    "https://graph.microsoft.com/v1.0/sites?search=*",
    { headers: { Authorization: `Bearer ${user.accessToken}` } }
  );
  const sites = siteRes.data.value;
  const siteData = await Promise.all(
    sites.map(async site => {
      const driveRes = await axios.get(
        `https://graph.microsoft.com/v1.0/sites/${site.id}/drives`,
        { headers: { Authorization: `Bearer ${req.session.user.accessToken}` } }
      );
      return { name: site.name, webUrl: site.webUrl, id: site.id, drives: driveRes.data.value };
    })
  );
  res.render("shared", { user, sites: siteData });
});

app.get(
  "/shared-library/:siteId/:driveId",
  ensureAuthenticated,
  async (req, res) => {
    const { siteId, driveId } = req.params;
    const user = req.session.user;
    const filesRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/root/children`,
      { headers: { Authorization: `Bearer ${user.accessToken}` } }
    );
    res.render("library", { user, items: filesRes.data.value, siteId, driveId });
  }
);

app.get(
  "/shared-library/:siteId/:driveId/folder/:itemId",
  ensureAuthenticated,
  async (req, res) => {
    const { siteId, driveId, itemId } = req.params;
    const user = req.session.user;
    const folderRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${itemId}/children`,
      { headers: { Authorization: `Bearer ${user.accessToken}` } }
    );
    res.render("library", { user, items: folderRes.data.value, siteId, driveId });
  }
);

// ——— Send Email —————————————————————————————————————————————

app.get("/send-email", ensureAuthenticated, (req, res) => {
  res.render("send-email", { user: req.session.user });
});

app.post("/send-email", ensureAuthenticated, async (req, res) => {
  const user = req.session.user;
  const { to, subject, body } = req.body;
  await axios.post(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    { message: { subject, body: { contentType: "Text", content: body }, toRecipients: [{ emailAddress: { address: to } }] } },
    { headers: { Authorization: `Bearer ${user.accessToken}`, "Content-Type": "application/json" } }
  );
  res.send('<p>Email sent! <a href="/send-email">Send another</a></p>');
});

// ——— Client-side filtered search —————————————————————————————————

app.get("/search-emails", ensureAuthenticated, async (req, res) => {
  const user = req.session.user;
  const targetEmail  = (req.query.email   || "").toLowerCase();
  const subjectQuery = (req.query.subject || "").toLowerCase();
  if (!targetEmail) {
    return res.render("search-email", { user, results: null, query: "", subject: "" });
  }
  const initialRes = await axios.get(MESSAGES_URL, { headers: { Authorization: `Bearer ${user.accessToken}` } });
  let msgs = initialRes.data.value;
  msgs = msgs.filter(m => {
    const from = m.from?.emailAddress?.address.toLowerCase() || "";
    const toMatch = (m.toRecipients || []).some(r => r.emailAddress?.address.toLowerCase() === targetEmail);
    return from === targetEmail || toMatch;
  });
  if (subjectQuery) msgs = msgs.filter(m => m.subject?.toLowerCase().includes(subjectQuery));
  const results = msgs.sort((a, b) => new Date(b.receivedDateTime || b.sentDateTime) - new Date(a.receivedDateTime || a.sentDateTime))
    .map(m => ({ id: m.id, subject: m.subject, from: m.from, toRecipients: m.toRecipients, receivedDateTime: m.receivedDateTime, sentDateTime: m.sentDateTime, webLink: m.webLink, body: { content: stripQuotedText(m.body.content || "") } }));
  res.render("search-email", { user, results, query: targetEmail, subject: subjectQuery });
});

app.get("/search-emails/expand", ensureAuthenticated, async (req, res) => {
  const targetEmail  = (req.query.email   || "").toLowerCase();
  const subjectQuery = (req.query.subject || "").toLowerCase();
  let all = await fetchAllMessages(MESSAGES_URL, req.session.user.accessToken);
  all = all.filter(m => {
    const from = m.from?.emailAddress?.address.toLowerCase() || "";
    const toMatch = (m.toRecipients || []).some(r => r.emailAddress?.address.toLowerCase() === targetEmail);
    return from === targetEmail || toMatch;
  });
  if (subjectQuery) all = all.filter(m => m.subject?.toLowerCase().includes(subjectQuery));
  const results = all.map(m => ({ id: m.id, subject: m.subject, from: m.from, toRecipients: m.toRecipients, receivedDateTime: m.receivedDateTime, sentDateTime: m.sentDateTime, webLink: m.webLink, body: { content: stripQuotedText(m.body.content || "") } }));
  res.json(results);
});

// ——— Server-side search via $search —————————————————————————————————

app.get("/search-email-server-search", 
  (req, res, next) => {
    console.log(`🔍 GET ${req.originalUrl}`, {
      cookie: req.headers.cookie, session: req.session.user
    });
    next();
  },
  ensureAuthenticated, 
  async (req, res) => {
    const targetEmail  = (req.query.email   || "").trim().toLowerCase();
    const subjectQuery = (req.query.subject || "").trim().toLowerCase();
    if (!targetEmail) {
      return res.render("search-email-server-search", { user: req.session.user, results: null, query: "", subject: "" });
    }
    let searchClause = `from:${targetEmail} OR to:${targetEmail}`;
    if (subjectQuery) searchClause += ` AND ${subjectQuery}`;
    searchClause = `"${searchClause}"`;
    const url = `https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent(searchClause)}&$count=true&$top=50`;
    console.log("Graph $search URL:", url);
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${req.session.user.accessToken}`, ConsistencyLevel: "eventual" }
    });
    let results = resp.data.value.map(m => ({ id: m.id, subject: m.subject || "", from: m.from, toRecipients: m.toRecipients, receivedDateTime: m.receivedDateTime, webLink: m.webLink, body: { content: stripQuotedText(m.body.content || "") } }));
    if (subjectQuery) results = results.filter(m => m.subject.toLowerCase().includes(subjectQuery));
    results.sort((a,b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
    res.render("search-email-server-search", { user: req.session.user, results, query: targetEmail, subject: subjectQuery });
});

// ——— Start Server ———————————————————————————————————————————

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
