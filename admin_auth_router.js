// admin_auth_router.js
const express = require('express');
const { getMessage } = require('./messageUtil');
const router = express.Router();

// POST /admin/login
// body: { username, password }
// Returns: { token: "<ADMIN_API_KEY>" } on success
router.post('/login', express.json(), (req, res) => {
  try {
    const { username, password } = req.body || {};
    const expectedUser = process.env.ADMIN_USERNAME || 'admin';
    const expectedPass = process.env.ADMIN_PASSWORD || null; // must be set in .env for login to work
    const adminToken = process.env.ADMIN_API_KEY || null;

    if (!expectedPass || !adminToken) {
      return res.status(503).json({ error: getMessage('loginAuth', 'accountBlocked') });
    }

    if (String(username) === String(expectedUser) && String(password) === String(expectedPass)) {
      return res.json({ token: adminToken });
    } else {
      return res.status(401).json({ error: getMessage('loginAuth', 'invalidCredentials') });
    }
  } catch (err) {
    console.error('[admin_auth_router] login error:', err);
    return res.status(500).json({ error: getMessage('generalNetwork', 'unknownError') });
  }
});

module.exports = router;
