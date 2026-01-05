const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabaseClient = createClient(supabaseUrl, supabaseKey);

// Google OAuth
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.NODE_ENV === 'production' ? 'https://assistflow-backend.vercel.app' : 'http://localhost:3000'}/api/calendars/callback`
);

// AES-256
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted += decipher.final();
  return decrypted;
}

// 1️⃣ START OAUTH
app.get('/api/calendars/connect/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar.readonly'],
    state: req.query.state || 'user123' // userId
  });
  res.json({ authUrl });
});

// 2️⃣ CALLBACK
app.get('/api/calendars/callback', async (req, res) => {
  const { code, state } = req.query;
  const userId = state;

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const encryptedAccess = encrypt(tokens.access_token);
    const encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    await supabaseClient
      .from('calendar_connections')
      .upsert({
        user_id: userId,
        provider: 'google',
        access_token: encryptedAccess,
        refresh_token: encryptedRefresh,
        expires_at: new Date(tokens.expiry_date).toISOString(),
        updated_at: new Date().toISOString()
      });

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?status=connected&userId=${userId}`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?status=error`);
  }
});

// 3️⃣ SYNC
app.post('/api/calendars/sync', async (req, res) => {
  const { userId } = req.body;

  try {
    const { data } = await supabaseClient
      .from('calendar_connections')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (!data) return res.status(404).json({ error: 'Not connected' });

    const accessToken = decrypt(data.access_token);
    oauth2Client.setCredentials({ access_token: accessToken });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date().toISOString(),
      maxResults: 50,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];

    // Clear old events
    await supabaseClient
      .from('external_events')
      .delete()
      .eq('user_id', userId)
      .eq('provider', 'google');

    // Insert new
    for (const event of events) {
      await supabaseClient.from('external_events').insert({
        user_id: userId,
        provider: 'google',
        title: event.summary || 'No title',
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        color: '#4285f4', // Google Blue
        event_id: event.id,
        description: event.description || ''
      });
    }

    res.json({ success: true, count: events.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4️⃣ DISCONNECT
app.post('/api/calendars/disconnect', async (req, res) => {
  const { userId } = req.body;

  await supabaseClient
    .from('calendar_connections')
    .delete()
    .eq('user_id', userId);

  await supabaseClient
    .from('external_events')
    .delete()
    .eq('user_id', userId);

  res.json({ success: true });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'Backend OK' }));

app.listen(PORT, () => {
  console.log(`🚀 Backend on port ${PORT}`);
});

module.exports = app;
