require("dotenv").config();
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const session = require("express-session");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

// ——— Configuration —————————————————————————————————————————————

// Base Graph endpoint pulling 50 newest messages (all folders), including webLink
const MESSAGES_URL =
  "https://graph.microsoft.com/v1.0/me/messages" +
  "?$top=50" +
  "&$select=subject,body,from,toRecipients,receivedDateTime,sentDateTime,webLink" +
  "&$orderby=receivedDateTime desc";

// ——— Helpers ————————————————————————————————————————————————

/**
 * Strips quoted text, signatures, <hr> dividers, and cid: images
 */
function stripQuotedText(html) {
  const $ = cheerio.load(html);

  // Remove embedded cid images
  $('img[src^="cid:"]').remove();

  // Outlook reply blocks
  $('[id^="divRplyFwdMsg"], [id^="x_divRplyFwdMsg"], [id*="ms-outlook-mobile-body-separator-line"]').remove();

  // Blockquote replies
  $("blockquote").remove();

  // Trim after first <hr>
  const hr = $("hr").first();
  if (hr.length) {
    hr.nextAll().remove();
    hr.remove();
  }

  // Signature tables
  $('[class^="MsoNormalTable"]').remove();

  // Common signature lines
  $('[class*="MsoNormal"]').each((_, el) => {
    const t = $(el).text().trim();
    if (/^\s*(Με εκτίμηση|Best regards|Kind regards|Thanks)/i.test(t)) {
      $(el).nextAll().remove();
      $(el).remove();
    }
  });

  return $.html();
}

/**
 * Paginates through every page of a Graph query via @odata.nextLink
 */
async function fetchAllMessages(initialUrl, accessToken) {
  let all = [];
  let url = initialUrl;

  while (url) {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    all = all.concat(res.data.value);
    url = res.data["@odata.nextLink"] || null;
    // safety cap
    if (all.length > 2000) break;
  }

  return all;
}

// ——— App Setup ——————————————————————————————————————————————

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.EXPRESS_SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // set to true if you have HTTPS
  })
);

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

// ——— Authentication ————————————————————————————————————————————

app.get("/auth", (req, res) => {
  const params = qs.stringify({
    client_id: process.env.CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.REDIRECT_URI,
    response_mode: "query",
    scope:
      "openid profile User.Read Mail.Read Mail.Send offline_access Sites.Read.All",
    state: "12345"
  });
  res.redirect(
    `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/authorize?${params}`
  );
});

app.get("/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: process.env.CLIENT_ID,
        scope:
          "openid profile User.Read Mail.Read Mail.Send offline_access Sites.Read.All",
        code,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: "authorization_code",
        client_secret: process.env.CLIENT_SECRET
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    req.session.user = {
      id: userRes.data.id,
      name: userRes.data.displayName,
      email: userRes.data.mail || userRes.data.userPrincipalName,
      accessToken,
      refreshToken: tokenRes.data.refresh_token
    };

    res.redirect("/");
  } catch (err) {
    console.error("Auth callback error:", err.response?.data || err.message);
    res.status(500).send("Authentication failed.");
  }
});

// ——— Dashboard & Logout ——————————————————————————————————————

app.get("/", (req, res) => {
  if (!req.session.user?.accessToken) return res.redirect("/auth");
  res.redirect("/dashboard");
});

app.get("/dashboard", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");

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
  } catch {}
  res.render("dashboard", { user, photoDataUrl });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ——— Email Search / Conversation —————————————————————————————

app.get("/search-emails", (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
  res.render("search-email", {
    user,
    results: null,
    query: "",
    subject: ""
  });
});

app.post("/search-emails", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");

  const targetEmail = (req.body.email || "").toLowerCase();
  const subjectQuery = (req.body.subject || "").toLowerCase();
  if (!targetEmail) return res.redirect("/search-emails");

  // 1) Fetch first 50 messages across all folders
  const initialRes = await axios.get(MESSAGES_URL, {
    headers: { Authorization: `Bearer ${user.accessToken}` }
  });
  let msgs = initialRes.data.value;

  // 2) Filter by contact & optional subject
  msgs = msgs.filter(m =>
    m.from?.emailAddress.address.toLowerCase() === targetEmail ||
    m.toRecipients.some(r => r.emailAddress.address.toLowerCase() === targetEmail)
  );
  if (subjectQuery) {
    msgs = msgs.filter(m =>
      m.subject?.toLowerCase().includes(subjectQuery)
    );
  }

  // 3) Strip quotes and carry webLink
  const results = msgs
    .sort(
      (a, b) =>
        new Date(b.receivedDateTime || b.sentDateTime) -
        new Date(a.receivedDateTime || a.sentDateTime)
    )
    .map(m => ({
      id: m.id,
      subject: m.subject,
      from: m.from,
      toRecipients: m.toRecipients,
      receivedDateTime: m.receivedDateTime,
      sentDateTime: m.sentDateTime,
      webLink: m.webLink,
      body: { content: stripQuotedText(m.body.content || "") }
    }));

  res.render("search-email", {
    user,
    results,
    query: targetEmail,
    subject: subjectQuery
  });
});

app.post("/search-emails/expand", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.status(401).json({ error: "Unauthorized" });

  const targetEmail = (req.body.email || "").toLowerCase();
  const subjectQuery = (req.body.subject || "").toLowerCase();

  // 1) Page through *all* messages
  let all = await fetchAllMessages(MESSAGES_URL, user.accessToken);

  // 2) Same filtering
  all = all.filter(m =>
    m.from?.emailAddress.address.toLowerCase() === targetEmail ||
    m.toRecipients.some(r => r.emailAddress.address.toLowerCase() === targetEmail)
  );
  if (subjectQuery) {
    all = all.filter(m =>
      m.subject?.toLowerCase().includes(subjectQuery)
    );
  }

  // 3) Strip quotes + carry webLink
  const results = all.map(m => ({
    id: m.id,
    subject: m.subject,
    from: m.from,
    toRecipients: m.toRecipients,
    receivedDateTime: m.receivedDateTime,
    sentDateTime: m.sentDateTime,
    webLink: m.webLink,
    body: { content: stripQuotedText(m.body.content || "") }
  }));

  res.json(results);
});

// ——— Other existing routes (files, shared libraries, send-email) ——————

app.get("/files", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
  const driveRes = await axios.get(
    "https://graph.microsoft.com/v1.0/me/drive/root/children",
    { headers: { Authorization: `Bearer ${user.accessToken}` } }
  );
  res.render("files", { user, files: driveRes.data.value });
});

// … your shared‐libraries, send‐email, etc. remain unchanged …

// ——— Start the server ——————————————————————————————————————

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
