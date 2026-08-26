const express = require('express');
const mysql = require('mysql2/promise');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use(cookieSession({
  name: 'session',
  keys: ['segredo_super_seguro_da_sessao'],
  maxAge: 24 * 60 * 60 * 1000
}));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const exigeLogin = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sessão expirada ou não autorizada.' });
  }
  next();
};

// Proxies para o Microsserviço de Autenticação
app.post('/api/register', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (response.ok) req.session.userId = data.userId;
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (response.ok) req.session.userId = data.userId;
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const appUrl = `${req.protocol}://${req.get('host')}`;
    const response = await fetch(`${AUTH_SERVICE_URL}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, appUrl })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/me', exigeLogin, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao validar perfil no Auth Service.' });
  }
});

// Rotas de Domínio (Catálogo, Favoritos e Comentários)
app.get('/api/movies', exigeLogin, async (req, res) => {
  try {
    const searchRes = await fetch(`https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=Tom+Hanks`);
    const searchData = await searchRes.json();
    if (!searchData.results || searchData.results.length === 0) return res.status(404).json({ error: 'Pessoa não encontrada.' });
    
    const personId = searchData.results[0].id;
    const moviesRes = await fetch(`https://api.themoviedb.org/3/person/${personId}/movie_credits?api_key=${TMDB_API_KEY}`);
    const moviesData = await moviesRes.json();
    res.json(moviesData.cast || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro na API TMDB.' });
  }
});

app.get('/api/favorites', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC', [req.session.userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar favoritos.' });
  }
});

app.post('/api/favorites', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, titulo, poster_path } = req.body;
  try {
    await pool.query('INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)', 
      [req.session.userId, tmdb_movie_id, titulo, poster_path]);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Filme já favoritado.' });
    res.status(500).json({ error: 'Erro ao favoritar.' });
  }
});

app.get('/api/comments', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM comentarios WHERE usuario_id = ? ORDER BY criado_em DESC', [req.session.userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar comentários.' });
  }
});

app.post('/api/comments', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Comentário vazio.' });
  try {
    await pool.query('INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)', [req.session.userId, tmdb_movie_id, texto]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao comentar.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Catálogo rodando na porta ${PORT}`));