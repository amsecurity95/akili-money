const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database ───
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function initDB() {
  if (!pool) { console.log('No DATABASE_URL — running without database'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      sender_name VARCHAR(255),
      sender_phone VARCHAR(50),
      receiver_name VARCHAR(255),
      receiver_phone VARCHAR(50),
      amount_usd DECIMAL(12,2),
      amount_cdf DECIMAL(16,2),
      fee_usd DECIMAL(8,2),
      fx_rate DECIMAL(12,4),
      payout_method VARCHAR(50),
      status VARCHAR(30) DEFAULT 'pending',
      thunes_transaction_id VARCHAR(255),
      thunes_external_id VARCHAR(255),
      kyc_verified BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database initialized');
}
initDB().catch(err => console.error('DB init error:', err.message));

// ─── Thunes API Helper ───
const THUNES_KEY = process.env.THUNES_API_KEY || '';
const THUNES_SECRET = process.env.THUNES_API_SECRET || '';
const THUNES_BASE = process.env.THUNES_BASE_URL || 'https://api-mt.pre.thunes.com';

function thunesAuth() {
  const credentials = Buffer.from(`${THUNES_KEY}:${THUNES_SECRET}`).toString('base64');
  return { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' };
}

async function thunesRequest(method, endpoint, data = null) {
  const url = `${THUNES_BASE}${endpoint}`;
  const config = { method, url, headers: thunesAuth() };
  if (data) config.data = data;
  const res = await axios(config);
  return res.data;
}

// ─── Payer IDs (Thunes payer config) ───
const PAYERS = {
  airtel: { id: process.env.THUNES_PAYER_AIRTEL || '1', name: 'Airtel Money Congo' },
  mpesa:  { id: process.env.THUNES_PAYER_MPESA || '2', name: 'M-Pesa Congo' }
};

// ─── API Routes ───

// GET /api/transfer/payers — list available payout methods
app.get('/api/transfer/payers', (req, res) => {
  res.json({ payers: [
    { key: 'airtel', name: 'Airtel Money', logo: 'ri-phone-fill' },
    { key: 'mpesa', name: 'M-Pesa', logo: 'ri-phone-fill' }
  ]});
});

// POST /api/transfer/quote — get FX rate + fee estimate
app.post('/api/transfer/quote', async (req, res) => {
  try {
    const { amount, payout_method } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!payout_method || !PAYERS[payout_method]) return res.status(400).json({ error: 'Invalid payout method' });

    const payer = PAYERS[payout_method];

    // Create quotation via Thunes
    const quote = await thunesRequest('POST', '/v2/money-transfer/quotations', {
      source: { amount: String(amount), currency: 'USD', country_iso_code: 'USA' },
      destination: { currency: 'CDF', country_iso_code: 'COD' },
      payer_id: payer.id
    });

    res.json({
      quote_id: quote.id,
      send_amount: parseFloat(amount),
      receive_amount: parseFloat(quote.destination?.amount || 0),
      fee: parseFloat(quote.fee?.amount || 0),
      fx_rate: parseFloat(quote.wholesale_fx_rate || 0),
      currency_send: 'USD',
      currency_receive: 'CDF',
      payout_method: payout_method,
      expires_at: quote.expiration_date
    });
  } catch (err) {
    console.error('Quote error:', err.response?.data || err.message);
    // Fallback mock quote for sandbox/demo
    const amount = parseFloat(req.body.amount) || 0;
    const mockRate = 2750;
    const mockFee = amount < 50 ? 2.99 : amount < 200 ? 4.99 : 7.99;
    res.json({
      quote_id: 'demo_' + Date.now(),
      send_amount: amount,
      receive_amount: Math.round(amount * mockRate),
      fee: mockFee,
      fx_rate: mockRate,
      currency_send: 'USD',
      currency_receive: 'CDF',
      payout_method: req.body.payout_method || 'airtel',
      expires_at: new Date(Date.now() + 30 * 60000).toISOString(),
      demo: true
    });
  }
});

// POST /api/transfer/create — create a transfer
app.post('/api/transfer/create', async (req, res) => {
  try {
    const { quote_id, sender_name, sender_phone, receiver_name, receiver_phone, amount, payout_method } = req.body;
    if (!receiver_phone || !receiver_phone.startsWith('+243')) {
      return res.status(400).json({ error: 'Phone must start with +243' });
    }
    if (!receiver_name || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const externalId = 'AKM-' + Date.now();
    const payer = PAYERS[payout_method] || PAYERS.airtel;
    let thunesId = null;
    let receiveAmount = 0;
    let fee = 0;
    let fxRate = 0;

    try {
      // Create transaction via Thunes
      const txn = await thunesRequest('POST', `/v2/money-transfer/quotations/${quote_id}/transactions`, {
        external_id: externalId,
        payer_id: payer.id,
        sender: {
          firstname: sender_name?.split(' ')[0] || 'Akili',
          lastname: sender_name?.split(' ').slice(1).join(' ') || 'User',
          country_iso_code: 'USA'
        },
        beneficiary: {
          firstname: receiver_name.split(' ')[0],
          lastname: receiver_name.split(' ').slice(1).join(' ') || '',
          mobile_number: receiver_phone,
          country_iso_code: 'COD'
        },
        credit_party_identifier: { mobile_number: receiver_phone }
      });
      thunesId = txn.id;
      receiveAmount = parseFloat(txn.destination?.amount || 0);
      fee = parseFloat(txn.fee?.amount || 0);
      fxRate = parseFloat(txn.wholesale_fx_rate || 0);
    } catch (apiErr) {
      // Demo fallback
      thunesId = 'demo_txn_' + Date.now();
      fxRate = 2750;
      fee = parseFloat(amount) < 50 ? 2.99 : parseFloat(amount) < 200 ? 4.99 : 7.99;
      receiveAmount = Math.round(parseFloat(amount) * fxRate);
    }

    // Store in DB
    if (!pool) return res.json({ transfer: { id: Date.now(), receiver_name, receiver_phone, amount_usd: amount, amount_cdf: receiveAmount, fee_usd: fee, fx_rate: fxRate, payout_method: payout_method || 'airtel', status: 'created', thunes_transaction_id: thunesId } });
    const result = await pool.query(
      `INSERT INTO transfers (sender_name, sender_phone, receiver_name, receiver_phone, amount_usd, amount_cdf, fee_usd, fx_rate, payout_method, status, thunes_transaction_id, thunes_external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'created',$10,$11) RETURNING *`,
      [sender_name || 'Akili User', sender_phone || '', receiver_name, receiver_phone, amount, receiveAmount, fee, fxRate, payout_method || 'airtel', thunesId, externalId]
    );

    res.json({ transfer: result.rows[0] });
  } catch (err) {
    console.error('Create error:', err.message);
    res.status(500).json({ error: 'Failed to create transfer' });
  }
});

// POST /api/transfer/confirm — confirm and execute
app.post('/api/transfer/confirm', async (req, res) => {
  try {
    const { transfer_id } = req.body;
    if (!pool) return res.json({ status: 'processing', transfer_id, demo: true });

    const dbResult = await pool.query('SELECT * FROM transfers WHERE id = $1', [transfer_id]);
    if (!dbResult.rows.length) return res.status(404).json({ error: 'Transfer not found' });

    const transfer = dbResult.rows[0];

    try {
      // Confirm via Thunes
      await thunesRequest('POST', `/v2/money-transfer/transactions/${transfer.thunes_transaction_id}/confirm`);
    } catch (apiErr) {
      // Demo: just update status
    }

    await pool.query("UPDATE transfers SET status = 'processing', updated_at = NOW() WHERE id = $1", [transfer_id]);

    // Simulate completion after 5s in demo mode
    if (transfer.thunes_transaction_id?.startsWith('demo_')) {
      setTimeout(async () => {
        await pool.query("UPDATE transfers SET status = 'paid', updated_at = NOW() WHERE id = $1", [transfer_id]);
      }, 5000);
    }

    res.json({ status: 'processing', transfer_id });
  } catch (err) {
    console.error('Confirm error:', err.message);
    res.status(500).json({ error: 'Failed to confirm transfer' });
  }
});

// GET /api/transfer/status/:id — check status
app.get('/api/transfer/status/:id', async (req, res) => {
  try {
    if (!pool) return res.status(404).json({ error: 'No database configured' });
    const result = await pool.query('SELECT * FROM transfers WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Transfer not found' });
    res.json({ transfer: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// GET /api/transfer/history — list all transfers
app.get('/api/transfer/history', async (req, res) => {
  try {
    if (!pool) return res.json({ transfers: [] });
    const result = await pool.query('SELECT * FROM transfers ORDER BY created_at DESC LIMIT 50');
    res.json({ transfers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// POST /api/kyc/verify — trigger KYC check
app.post('/api/kyc/verify', async (req, res) => {
  try {
    const { user_id, first_name, last_name, email } = req.body;
    const SUMSUB_TOKEN = process.env.SUMSUB_APP_TOKEN;
    const SUMSUB_SECRET = process.env.SUMSUB_SECRET_KEY;

    if (!SUMSUB_TOKEN || !SUMSUB_SECRET) {
      return res.json({ verified: true, demo: true, message: 'KYC skipped (demo mode)' });
    }

    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', SUMSUB_SECRET)
      .update(ts + 'POST' + '/resources/applicants')
      .digest('hex');

    const response = await axios.post('https://api.sumsub.com/resources/applicants', {
      externalUserId: user_id || 'akili_' + Date.now(),
      info: { firstName: first_name, lastName: last_name, email }
    }, {
      headers: {
        'X-App-Token': SUMSUB_TOKEN,
        'X-App-Access-Sig': sig,
        'X-App-Access-Ts': ts,
        'Content-Type': 'application/json'
      }
    });

    res.json({ verified: false, applicant_id: response.data.id, status: 'pending' });
  } catch (err) {
    console.error('KYC error:', err.response?.data || err.message);
    res.json({ verified: true, demo: true, message: 'KYC skipped (demo mode)' });
  }
});

// POST /api/webhook/thunes — handle status updates from Thunes
app.post('/api/webhook/thunes', async (req, res) => {
  try {
    if (!pool) return res.json({ received: true, demo: true });
    const { id, status, external_id } = req.body;
    const statusMap = { '10000': 'paid', '20000': 'failed', '50000': 'cancelled' };
    const newStatus = statusMap[String(status)] || 'processing';

    await pool.query(
      "UPDATE transfers SET status = $1, updated_at = NOW() WHERE thunes_transaction_id = $2 OR thunes_external_id = $3",
      [newStatus, String(id), external_id]
    );
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Serve static files — fallback to index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Akili Money running on port ${PORT}`));
