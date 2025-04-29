require("dotenv").config();
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const session = require("express-session");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

// Base Graph endpoint: first 50 messages, includes webLink
const MESSAGES_URL =
  "https://graph.microsoft.com/v1.0/me/messages" +
  "?$top=50" +
  "&$select=subject,body,from,toRecipients,receivedDateTime,sentDateTime,webLink" +
  "&$orderby=receivedDateTime desc";

// ——— Helpers ——————————————————————————————————————————————

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
    cookie: { secure: false }
  })
);

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

// ——— File + Library Routes ——————————————————————————————————

app.get("/files", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
  const driveRes = await axios.get(
    "https://graph.microsoft.com/v1.0/me/drive/root/children",
    { headers: { Authorization: `Bearer ${user.accessToken}` } }
  );
  res.render("files", { user, files: driveRes.data.value });
});

app.get("/shared-libraries", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
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
      return {
        name: site.name,
        webUrl: site.webUrl,
        id: site.id,
        drives: driveRes.data.value
      };
    })
  );
  res.render("shared", { user, sites: siteData });
});

app.get(
  "/shared-library/:siteId/:driveId",
  async (req, res) => {
    const { siteId, driveId } = req.params;
    const user = req.session.user;
    if (!user?.accessToken) return res.redirect("/auth");
    const filesRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/root/children`,
      { headers: { Authorization: `Bearer ${user.accessToken}` } }
    );
    res.render("library", {
      user,
      items: filesRes.data.value,
      siteId,
      driveId
    });
  }
);

app.get(
  "/shared-library/:siteId/:driveId/folder/:itemId",
  async (req, res) => {
    const { siteId, driveId, itemId } = req.params;
    const user = req.session.user;
    if (!user?.accessToken) return res.redirect("/auth");
    const folderRes = await axios.get(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${itemId}/children`,
      { headers: { Authorization: `Bearer ${user.accessToken}` } }
    );
    res.render("library", {
      user,
      items: folderRes.data.value,
      siteId,
      driveId
    });
  }
);

// ——— Send Email ——————————————————————————————————————————————

app.get("/send-email", (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
  res.render("send-email", { user });
});

app.post("/send-email", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
  const { to, subject, body } = req.body;
  await axios.post(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }]
      }
    },
    {
      headers: {
        Authorization: `Bearer ${user.accessToken}`,
        "Content-Type": "application/json"
      }
    }
  );
  res.send('<p>Email sent! <a href="/send-email">Send another</a></p>');
});

// ——— Search / Conversation ——————————————————————————————————————

// app.get("/search-emails", (req, res) => {
//   const user = req.session.user;
//   if (!user?.accessToken) return res.redirect("/auth");
//   res.render("search-email", { user, results: null, query: "", subject: "" });
// });

//app.post("/search-emails", async (req, res) => {
app.get("/search-emails", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.redirect("/auth");
  const targetEmail = (req?.query?.email || "").toLowerCase();
  const subjectQuery = (req?.query?.subject || "").toLowerCase();
  //if (!targetEmail) return res.redirect("/search-emails");
  // render empty form if no email provided
  if (!targetEmail) {
    return res.render("search-email", {
      user,
      results: null,
      query: "",
      subject: ""
    });
  }

  // 1) initial 50
  const initialRes = await axios.get(MESSAGES_URL, {
    headers: { Authorization: `Bearer ${user.accessToken}` }
  });
  let msgs = initialRes.data.value;

  // 2) safe filter
  msgs = msgs.filter(m => {
    const fromAddr = m.from?.emailAddress?.address?.toLowerCase() || "";
    const toMatch = (m.toRecipients || []).some(r =>
      r.emailAddress?.address?.toLowerCase() === targetEmail
    );
    return fromAddr === targetEmail || toMatch;
  });
  if (subjectQuery) {
    msgs = msgs.filter(m =>
      m.subject?.toLowerCase().includes(subjectQuery)
    );
  }

  // 3) strip + map
  const results = msgs
    .sort((a, b) =>
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
    // echo back into form fields
    query: targetEmail,
    subject: subjectQuery
  });
});

app.post("/search-emails/expand", async (req, res) => {
  const user = req.session.user;
  if (!user?.accessToken) return res.status(401).json({ error: "Unauthorized" });
  //const targetEmail = (req.body.email || "").toLowerCase();
  //const subjectQuery = (req.body.subject || "").toLowerCase();
  const targetEmail = (req?.query?.email || "").toLowerCase();
  const subjectQuery = (req?.query?.subject || "").toLowerCase();

  // 1) page through all
  let all = await fetchAllMessages(MESSAGES_URL, user.accessToken);

  // 2) same safe filter
  all = all.filter(m => {
    const fromAddr = m.from?.emailAddress?.address?.toLowerCase() || "";
    const toMatch = (m.toRecipients || []).some(r =>
      r.emailAddress?.address?.toLowerCase() === targetEmail
    );
    return fromAddr === targetEmail || toMatch;
  });
  if (subjectQuery) {
    all = all.filter(m =>
      m.subject?.toLowerCase().includes(subjectQuery)
    );
  }

  // 3) strip + map
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

// ——— Start ——————————————————————————————————————————————

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
