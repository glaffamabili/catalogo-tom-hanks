const express = require('express');
const mysql = require('mysql2/promise');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

// Métricas em memória para o endpoint /metrics (Padrão Prometheus)
const metrics = {
  requestsTotal: {},
  requestDurations: [],
  startTime: Date.now()
};

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route ? req.route.path : req.path;
    const key = `${req.method}|${route}|${res.statusCode}`;
    metrics.requestsTotal[key] = (metrics.requestsTotal[key] || 0) + 1;
    metrics.requestDurations.push(duration);
    if (metrics.requestDurations.length > 500) metrics.requestDurations.shift();
  });
  next();
});

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

// Inicialização automática das tabelas
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS favoritos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        tmdb_movie_id INT NOT NULL,
        titulo VARCHAR(255),
        poster_path VARCHAR(255),
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY user_fav (usuario_id, tmdb_movie_id)
      ) ENGINE=InnoDB;
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comentarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        tmdb_movie_id INT NOT NULL,
        texto TEXT NOT NULL,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (usuario_id),
        INDEX (tmdb_movie_id)
      ) ENGINE=InnoDB;
    `);
    console.log('Tabelas do Catálogo verificadas/inicializadas com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas no catálogo:', err);
  }
}
initDb();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Middleware de Autenticação (Quem é você?)
const exigeLogin = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sessão expirada ou não autorizada. Faça login novamente.' });
  }
  next();
};

// Middleware de Autorização RBAC - Padrão A Centralizado (O que você pode fazer?)
const exigeAdmin = async (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Sessão expirada ou não autorizada.' });
  }
  try {
    // Consulta centralizada no Auth Service em tempo real
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!response.ok) {
      return res.status(401).json({ error: 'Erro ao validar perfil no Auth Service.' });
    }
    const user = await response.json();
    if (user.role !== 'admin') {
      // Enforcement no Backend: Retorna 403 Forbidden
      return res.status(403).json({ 
        error: 'Acesso negado (403 Forbidden): Esta ação é restrita a administradores.' 
      });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('Erro na validação de papel de admin:', err);
    res.status(500).json({ error: 'Erro de comunicação ao verificar permissões de acesso.' });
  }
};

// Proxies para o Microsserviço de Autenticação
app.post('/api/register', async (req, res) => {
  try {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const appUrl = process.env.APP_URL || `${proto}://${host}`;

    const response = await fetch(`${AUTH_SERVICE_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, appUrl })
    });
    const data = await response.json();
    if (response.ok) req.session.userId = data.userId;
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy register:', err);
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
    console.error('Erro no proxy login:', err);
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

app.post('/api/forgot-password', async (req, res) => {
  try {
    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const appUrl = process.env.APP_URL || `${proto}://${host}`;

    const response = await fetch(`${AUTH_SERVICE_URL}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, appUrl })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy forgot-password:', err);
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

// Listar comentários (Comunidade de cinéfilos)
app.get('/api/comments', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.usuario_id, c.tmdb_movie_id, c.texto, c.criado_em,
             u.nome AS autor_nome, u.email AS autor_email, u.role AS autor_role
      FROM comentarios c
      LEFT JOIN usuarios u ON c.usuario_id = u.id
      ORDER BY c.criado_em DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Erro ao carregar comentários:', err);
    res.status(500).json({ error: 'Erro ao carregar comentários.' });
  }
});

// Criar novo comentário
app.post('/api/comments', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Comentário vazio.' });
  try {
    await pool.query(
      'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)',
      [req.session.userId, tmdb_movie_id, texto.trim()]
    );
    res.json({ success: true, message: 'Comentário registrado com sucesso.' });
  } catch (err) {
    console.error('Erro ao comentar:', err);
    res.status(500).json({ error: 'Erro ao comentar.' });
  }
});

// Excluir Comentário (RBAC: Dono do comentário OU Admin para moderação)
app.delete('/api/comments/:id', exigeLogin, async (req, res) => {
  const commentId = req.params.id;
  try {
    const [rows] = await pool.query('SELECT * FROM comentarios WHERE id = ?', [commentId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Comentário não encontrado.' });
    }
    const comment = rows[0];

    // Padrão A: consulta centralizada no Auth Service para pegar o papel mais recente
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!authRes.ok) {
      return res.status(401).json({ error: 'Falha ao validar papel no serviço de autenticação.' });
    }
    const user = await authRes.json();

    const isOwner = (comment.usuario_id === req.session.userId);
    const isAdmin = (user.role === 'admin');

    // Validação de Autorização (Enforcement no Servidor)
    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        error: 'Acesso negado (403 Forbidden): Apenas o autor do comentário ou um administrador podem excluir este comentário.'
      });
    }

    await pool.query('DELETE FROM comentarios WHERE id = ?', [commentId]);
    res.json({
      success: true,
      message: isAdmin && !isOwner
        ? 'Comentário moderado e excluído com sucesso (Ação de Administrador).'
        : 'Comentário excluído com sucesso.'
    });
  } catch (err) {
    console.error('Erro ao excluir comentário:', err);
    res.status(500).json({ error: 'Erro interno ao excluir comentário.' });
  }
});

// Rotas Administrativas (Protegidas pelo middleware exigeAdmin)
app.get('/api/users', exigeAdmin, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/users`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar usuários no Auth Service.' });
  }
});

app.patch('/api/users/:id/role', exigeAdmin, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/users/${req.params.id}/role`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar papel do usuário no Auth Service.' });
  }
});

// Endpoint /health (Liveness & Readiness de Verdade)
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  let dbStatus = 'DOWN';
  let dbError = null;
  let authStatus = 'DOWN';
  let authError = null;

  // 1. Testa conectividade com MariaDB / MySQL
  try {
    const [rows] = await pool.query('SELECT 1 AS alive');
    if (rows && rows.length > 0) dbStatus = 'UP';
  } catch (err) {
    dbError = err.message;
  }

  // 2. Testa comunicação interna com o Auth Service
  try {
    const authRes = await fetch(`${AUTH_SERVICE_URL}/health`, { timeout: 3000 });
    if (authRes.ok) {
      authStatus = 'UP';
    } else {
      authError = `Auth Service respondeu com status ${authRes.status}`;
    }
  } catch (err) {
    authError = err.message;
  }

  const isHealthy = (dbStatus === 'UP' && authStatus === 'UP');
  const responseTimeMs = Date.now() - startTime;

  const payload = {
    status: isHealthy ? 'UP' : 'DOWN',
    service: 'catalog-service',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    responseTimeMs,
    checks: {
      database: {
        status: dbStatus,
        ...(dbError && { error: dbError })
      },
      authService: {
        status: authStatus,
        url: AUTH_SERVICE_URL,
        ...(authError && { error: authError })
      }
    }
  };

  res.status(isHealthy ? 200 : 503).json(payload);
});

// Endpoint /metrics (Padrão Prometheus)
app.get('/metrics', (req, res) => {
  const uptime = (Date.now() - metrics.startTime) / 1000;
  const mem = process.memoryUsage();

  let prom = `# HELP process_uptime_seconds Process uptime in seconds\n`;
  prom += `# TYPE process_uptime_seconds gauge\n`;
  prom += `process_uptime_seconds ${uptime.toFixed(2)}\n\n`;

  prom += `# HELP process_resident_memory_bytes Resident memory size in bytes\n`;
  prom += `# TYPE process_resident_memory_bytes gauge\n`;
  prom += `process_resident_memory_bytes ${mem.rss}\n\n`;

  prom += `# HELP process_heap_bytes Process heap bytes\n`;
  prom += `# TYPE process_heap_bytes gauge\n`;
  prom += `process_heap_bytes ${mem.heapUsed}\n\n`;

  prom += `# HELP http_requests_total Total number of HTTP requests\n`;
  prom += `# TYPE http_requests_total counter\n`;
  for (const [key, count] of Object.entries(metrics.requestsTotal)) {
    const [method, routePath, status] = key.split('|');
    prom += `http_requests_total{method="${method}",path="${routePath}",status="${status}"} ${count}\n`;
  }

  const avgDuration = metrics.requestDurations.length > 0
    ? (metrics.requestDurations.reduce((a, b) => a + b, 0) / metrics.requestDurations.length).toFixed(4)
    : 0;

  prom += `\n# HELP http_request_duration_seconds Average HTTP request duration in seconds\n`;
  prom += `# TYPE http_request_duration_seconds gauge\n`;
  prom += `http_request_duration_seconds ${avgDuration}\n`;

  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(prom);
});

// Documentação Swagger UI / OpenAPI
const openapiPath = path.join(__dirname, 'openapi.json');
app.get('/openapi.json', (req, res) => {
  res.sendFile(openapiPath);
});

app.get(['/apidocs', '/docs'], (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Swagger UI — Catalog Service API</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
  <style>
    body { margin: 0; background: #fafafa; font-family: sans-serif; }
    .swagger-ui .topbar { background-color: #0b0f19; }
    .swagger-ui .topbar-wrapper .link { color: #e50914; font-weight: bold; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.min.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Catálogo rodando na porta ${PORT}`));