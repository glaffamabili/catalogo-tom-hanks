const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Configuração de cookies e sessão do usuário
app.use(cookieSession({
  name: 'session',
  keys: ['segredo_super_seguro_da_sessao'],
  maxAge: 24 * 60 * 60 * 1000 // Validade de 24 horas
}));

// Conexão com o banco usando as Variáveis de Ambiente configuradas na nuvem
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Middleware de proteção: só avança se o usuário estiver logado
const exigeLogin = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sessão expirada ou não autorizada.' });
  }
  next();
};

// ==========================================
// ROTAS DE AUTENTICAÇÃO (CADASTRO / LOGIN)
// ==========================================

// 1. Cadastrar novo usuário
app.post('/api/register', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Preencha todos os campos!' });
  }

  try {
    const hash = await bcrypt.hash(senha, 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash) VALUES (?, ?, ?)',
      [nome, email, hash]
    );
    req.session.userId = result.insertId;
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Este e-mail já está em uso.' });
    }
    res.status(500).json({ error: 'Erro ao realizar cadastro.' });
  }
});

// 2. Fazer login
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) {
    return res.status(400).json({ error: 'Preencha e-mail e senha!' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }

    const usuario = rows[0];
    const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaValida) {
      return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }

    req.session.userId = usuario.id;
    res.json({ success: true, nome: usuario.nome });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno ao tentar logar.' });
  }
});

// 3. Fazer logout
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// 4. Retornar dados do usuário atual
app.get('/api/me', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nome, email FROM usuarios WHERE id = ?', [req.session.userId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar perfil.' });
  }
});

// ==========================================
// ROTAS DO TMDB (API EXTERNA DE FILMES)
// ==========================================

app.get('/api/movies', exigeLogin, async (req, res) => {
  try {
    // Busca o ID do Tom Hanks na API
    const searchRes = await fetch(`https://api.themoviedb.org/3/search/person?api_key=${TMDB_API_KEY}&query=Tom+Hanks`);
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      return res.status(404).json({ error: 'Pessoa não encontrada na TMDB.' });
    }

    const personId = searchData.results[0].id;

    // Busca a lista de filmes
    const moviesRes = await fetch(`https://api.themoviedb.org/3/person/${personId}/movie_credits?api_key=${TMDB_API_KEY}`);
    const moviesData = await moviesRes.json();

    res.json(moviesData.cast || []);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar a API TMDB.' });
  }
});

// ==========================================
// ROTAS DE FAVORITOS (SEGREGAÇÃO POR USUÁRIO)
// ==========================================

// Listar favoritos APENAS do usuário logado
app.get('/api/favorites', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC',
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar favoritos.' });
  }
});

// Adicionar filme aos favoritos
app.post('/api/favorites', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, titulo, poster_path } = req.body;
  try {
    await pool.query(
      'INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)',
      [req.session.userId, tmdb_movie_id, titulo, poster_path]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Você já favoritou este filme.' });
    }
    res.status(500).json({ error: 'Erro ao favoritar filme.' });
  }
});

// ==========================================
// ROTAS DE COMENTÁRIOS (SEGREGAÇÃO POR USUÁRIO)
// ==========================================

// Listar comentários APENAS do usuário logado
app.get('/api/comments', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM comentarios WHERE usuario_id = ? ORDER BY criado_em DESC',
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar comentários.' });
  }
});

// Salvar comentário
app.post('/api/comments', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, texto } = req.body;
  if (!texto || !texto.trim()) {
    return res.status(400).json({ error: 'O comentário não pode ser vazio.' });
  }

  try {
    await pool.query(
      'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)',
      [req.session.userId, tmdb_movie_id, texto]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar comentário.' });
  }
});

// Servidor escuta internamente na porta 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aplicação rodando na porta ${PORT}`));