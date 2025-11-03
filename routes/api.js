const express = require('express');
const db = require('../db'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticateToken, isAdmin } = require('../middleware/auth');

const router = express.Router();
router.post('/register', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const newUser = await db.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING user_id, username, is_admin, fake_money_balance',
      [username, passwordHash]
    );

    res.status(201).json(newUser.rows[0]);
  } catch (err) {
    if (err.code === '23505') { 
      return res.status(400).json({ error: 'Username already taken' });
    }
    next(err);
  }
});
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    
    const userResult = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }
    const payload = {
      userId: user.user_id,
      username: user.username,
      isAdmin: user.is_admin
    };
    
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1d' });

    res.json({
      token,
      user: {
        userId: user.user_id,
        username: user.username,
        isAdmin: user.is_admin,
        balance: user.fake_money_balance
      }
    });
  } catch (err) {
    next(err);
  }
});
router.get('/matches', async (req, res, next) => {
  try {
    const matchesRes = await db.query(`
      SELECT 
        m.match_id,
        m.match_time,
        m.match_status,
        m.player_one_id,
        m.player_two_id,
        p1.name AS player_one_name,
        p2.name AS player_two_name
      FROM matches m
      JOIN players p1 ON m.player_one_id = p1.player_id
      JOIN players p2 ON m.player_two_id = p2.player_id
      WHERE m.match_status = 'pending'
      ORDER BY m.match_time ASC
    `);

    const matches = matchesRes.rows;

    const oddsRes = await db.query(`
      SELECT odd_id, match_id, player_id, odd_type, odd_value, odd_line
      FROM odds
      WHERE is_active = true
    `);

    const oddsByMatch = {};
    for (const odd of oddsRes.rows) {
      if (!oddsByMatch[odd.match_id]) oddsByMatch[odd.match_id] = [];
      oddsByMatch[odd.match_id].push(odd);
    }

    const finalData = matches.map(m => ({
      ...m,
      odds: oddsByMatch[m.match_id] || []
    }));

    res.json({ success: true, data: finalData });
  } catch (err) {
    console.error('Error fetching matches:', err);
    next(err);
  }
});
router.get('/user/balance', authenticateToken, async (req, res, next) => {
  try {
    const { userId } = req.user;
    const result = await db.query(
      'SELECT fake_money_balance FROM users WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, balance: result.rows[0].fake_money_balance });
  } catch (err) {
    console.error('Error fetching user balance:', err);
    next(err);
  }
});


router.get('/players', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT player_id, name, country FROM players ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
router.get('/bets', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const { rows } = await db.query(
      `
      SELECT 
        b.bet_id,
        b.stake_amount,
        b.bet_status,
        b.payout,
        b.placed_at,
        o.odd_type,
        o.odd_value,
        o.odd_line,
        m.match_id,
        m.match_time,
        m.match_status,
        p1.name AS player_one_name,
        p2.name AS player_two_name
      FROM bets b
      JOIN odds o ON b.odd_id = o.odd_id
      JOIN matches m ON o.match_id = m.match_id
      JOIN players p1 ON m.player_one_id = p1.player_id
      JOIN players p2 ON m.player_two_id = p2.player_id
      WHERE b.user_id = $1
      ORDER BY b.placed_at DESC
      `,
      [userId]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Error fetching user bets:', err);
    next(err);
  }
});


router.post('/bets', authenticateToken, async (req, res, next) => {
  const { odd_id, stake_amount } = req.body;
  const userId = req.user.userId;

  if (!odd_id || !stake_amount || +stake_amount <= 0) {
    return res.status(400).json({ error: 'Invalid bet data' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN'); 
    const userResult = await client.query('SELECT fake_money_balance FROM users WHERE user_id = $1 FOR UPDATE', [userId]);
    const balance = userResult.rows[0].fake_money_balance;

    if (balance < stake_amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds' });
    }
    
    const oddResult = await client.query('SELECT is_active FROM odds WHERE odd_id = $1', [odd_id]);
    if (oddResult.rows.length === 0 || !oddResult.rows[0].is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Betting on this odd is no longer active' });
    }

    const newBalance = balance - stake_amount;
    await client.query('UPDATE users SET fake_money_balance = $1 WHERE user_id = $2', [newBalance, userId]);

    await client.query(
      'INSERT INTO bets (user_id, odd_id, stake_amount) VALUES ($1, $2, $3)',
      [userId, odd_id, stake_amount]
    );

    await client.query('COMMIT'); 
    res.status(201).json({ success: true, newBalance: newBalance });

  } catch (err) {
    await client.query('ROLLBACK'); 
    next(err);
  } finally {
    client.release();
  }
});

router.post('/admin/players', [authenticateToken, isAdmin], async (req, res, next) => {
    try {
        const { name, country } = req.body;
        const newPlayer = await db.query(
            'INSERT INTO players (name, country) VALUES ($1, $2) RETURNING *',
            [name, country]
        );
        res.status(201).json(newPlayer.rows[0]);
    } catch (err) {
        next(err);
    }
});
router.post('/admin/matches', [authenticateToken, isAdmin], async (req, res, next) => {
    try {
        const { player_one_id, player_two_id, match_time } = req.body;
        const newMatch = await db.query(
            'INSERT INTO matches (player_one_id, player_two_id, match_time) VALUES ($1, $2, $3) RETURNING *',
            [player_one_id, player_two_id, match_time]
        );
        res.status(201).json(newMatch.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.post('/admin/odds', [authenticateToken, isAdmin], async (req, res, next) => {
  try {
    const { match_id, player_id, odd_type, odd_value, odd_line } = req.body;

    if (!match_id || !odd_type || !odd_value) {
      return res.status(400).json({ error: 'Missing required fields: match_id, odd_type, odd_value' });
    }

    const numericOddValue = parseFloat(odd_value);
    const numericOddLine =
      odd_line === '' || odd_line === null || odd_line === undefined
        ? null
        : parseFloat(odd_line);

    if (isNaN(numericOddValue)) {
      return res.status(400).json({ error: 'odd_value must be a valid number' });
    }

    const newOdd = await db.query(
      `INSERT INTO odds (match_id, player_id, odd_type, odd_value, odd_line)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [match_id, player_id || null, odd_type, numericOddValue, numericOddLine]
    );

    res.status(201).json(newOdd.rows[0]);
  } catch (err) {
    console.error('Error creating odd:', err);
    next(err);
  }
});


router.post('/admin/settle/:matchId', [authenticateToken, isAdmin], async (req, res, next) => {
    const { matchId } = req.params;
    const results = req.body; 

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const resultEntries = Object.entries(results);
        const setClause = resultEntries.map(([key, _], i) => `${key} = $${i + 1}`).join(', ');
        const setValues = resultEntries.map(([_, value]) => value);
        
        const matchUpdateQuery = `UPDATE matches SET ${setClause}, match_status = 'finished' WHERE match_id = $${setValues.length + 1} RETURNING *`;
        const updatedMatchResult = await client.query(matchUpdateQuery, [...setValues, matchId]);
        
        if (updatedMatchResult.rows.length === 0) {
            throw new Error('Match not found');
        }
        const match = updatedMatchResult.rows[0];

        const betsToSettle = await client.query(
            `SELECT b.*, o.odd_type, o.odd_value, o.odd_line, o.player_id 
             FROM bets b
             JOIN odds o ON b.odd_id = o.odd_id
             WHERE o.match_id = $1 AND b.bet_status = 'pending'`,
            [matchId]
        );

        for (const bet of betsToSettle.rows) {
            let isWinner = false;
            
            switch (bet.odd_type) {
                case 'to_win':
                    isWinner = (bet.player_id === match.winner_id);
                    break;
                case 'first_scorer':
                    isWinner = (bet.player_id === match.first_scorer_id);
                    break;
                case 'total_points_over':
                    isWinner = (match.total_points > bet.odd_line);
                    break;
                case 'total_points_under':
                    isWinner = (match.total_points < bet.odd_line);
                    break;
                case 'games_played_3_yes':
                    isWinner = (match.games_played === 3);
                    break;
                case 'games_played_3_no':
                    isWinner = (match.games_played !== 3);
                    break;
                case 'highest_lead_over':
                    isWinner = (match.highest_lead_amount > bet.odd_line);
                    break;
                case 'highest_lead_under':
                    isWinner = (match.highest_lead_amount < bet.odd_line);
                    break;
                case 'first_tilt':
                    isWinner = (bet.player_id === match.first_tilt_player_id);
                    break;
                case 'first_abuse':
                    isWinner = (bet.player_id === match.first_abuse_player_id);
                    break;
            }

            if (isWinner) {
                const payout = bet.stake_amount * bet.odd_value;
                await client.query('UPDATE bets SET bet_status = $1, payout = $2 WHERE bet_id = $3', ['won', payout, bet.bet_id]);
              
                await client.query('UPDATE users SET fake_money_balance = fake_money_balance + $1 WHERE user_id = $2', [payout, bet.user_id]);
            } else {
                await client.query('UPDATE bets SET bet_status = $1, payout = 0 WHERE bet_id = $2', ['lost', bet.bet_id]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `Match ${matchId} settled. ${betsToSettle.rows.length} bets processed.` });

    } catch (err) {
        await client.query('ROLLBACK'); 
        next(err);
    } finally {
        client.release();
    }
});

router.post('/admin/revoke-bet/:betId', [authenticateToken, isAdmin], async (req, res, next) => {
    const { betId } = req.params;
    
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const betResult = await client.query('SELECT * FROM bets WHERE bet_id = $1 FOR UPDATE', [betId]);
        if (betResult.rows.length === 0) {
            throw new Error('Bet not found');
        }
        
        const bet = betResult.rows[0];
        if (bet.bet_status !== 'pending') {
             return res.status(400).json({ error: `Cannot revoke a bet that is already ${bet.bet_status}`});
        }
        await client.query('UPDATE bets SET bet_status = $1 WHERE bet_id = $2', ['revoked', betId]);

        await client.query('UPDATE users SET fake_money_balance = fake_money_balance + $1 WHERE user_id = $2', [bet.stake_amount, bet.user_id]);
        
        await client.query('COMMIT');
        res.json({ success: true, message: 'Bet revoked and stake refunded.'});

    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
});


module.exports = router;
