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

// Endpoint /health (Liveness & Readiness com Painel Visual & JSON)
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
    const authRes = await fetch(`${AUTH_SERVICE_URL}/health?format=json`, { timeout: 3000 });
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
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeFormatted = `${hours}h ${minutes}m ${seconds}s`;

  const payload = {
    status: isHealthy ? 'UP' : 'DOWN',
    service: 'catalog-service',
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    responseTimeMs,
    checks: {
      database: {
        status: dbStatus,
        host: process.env.DB_HOST || '35.226.64.52',
        ...(dbError && { error: dbError })
      },
      authService: {
        status: authStatus,
        url: AUTH_SERVICE_URL,
        ...(authError && { error: authError })
      }
    }
  };

  // Se a requisição pedir explicitamente JSON ou for do Docker / Script
  const wantsJson = req.query.format === 'json' || req.headers.accept?.includes('application/json') || !req.headers.accept?.includes('text/html');

  if (wantsJson) {
    return res.status(isHealthy ? 200 : 503).json(payload);
  }

  // Renderiza Dashboard Visual Moderno
  res.status(isHealthy ? 200 : 503).send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Health Check & Status | Catálogo Tom Hanks</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; display: flex; justify-content: center; align-items: center; background: radial-gradient(circle at top, #1e1b4b 0%, #0b0f19 70%); }
    .container { width: 100%; max-width: 800px; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid #263352; padding-bottom: 20px; }
    .title-group { display: flex; align-items: center; gap: 12px; }
    .brand-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #e50914, #b91c1c); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #fff; }
    h1 { font-size: 22px; font-weight: 800; }
    .status-badge { padding: 8px 18px; border-radius: 50px; font-size: 13px; font-weight: 800; display: inline-flex; align-items: center; gap: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-badge.healthy { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); }
    .status-badge.unhealthy { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.2); } }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .stat-box { background: #0f172a; border: 1px solid #263352; border-radius: 12px; padding: 18px; }
    .stat-label { font-size: 12px; color: #94a3b8; font-weight: 600; text-transform: uppercase; margin-bottom: 6px; }
    .stat-val { font-size: 20px; font-weight: 800; color: #fff; }
    .service-card { background: #0f172a; border: 1px solid #263352; border-radius: 12px; padding: 20px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .service-info { display: flex; align-items: center; gap: 14px; }
    .service-icon { width: 40px; height: 40px; background: #1e293b; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
    .actions { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
    .btn { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; transition: all 0.2s; border: none; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-outline { background: #0f172a; color: #94a3b8; border: 1px solid #263352; }
    .btn-outline:hover { color: #fff; border-color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="title-group">
          <div class="brand-icon"><i class="fa-solid fa-heart-pulse"></i></div>
          <div>
            <h1>Observabilidade & Health Check</h1>
            <p style="font-size: 13px; color: #94a3b8;">Monitoramento em Tempo Real das Dependências</p>
          </div>
        </div>
        <div class="status-badge ${isHealthy ? 'healthy' : 'unhealthy'}">
          <div class="pulse"></div> ${isHealthy ? 'SISTEMA OPERACIONAL' : 'INSTABILIDADE'}
        </div>
      </div>

      <div class="grid">
        <div class="stat-box">
          <div class="stat-label"><i class="fa-regular fa-clock"></i> Tempo Ativo (Uptime)</div>
          <div class="stat-val">${uptimeFormatted}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label"><i class="fa-solid fa-bolt"></i> Latência dos Checks</div>
          <div class="stat-val">${responseTimeMs} ms</div>
        </div>
        <div class="stat-box">
          <div class="stat-label"><i class="fa-solid fa-server"></i> Microsserviço</div>
          <div class="stat-val" style="font-size: 16px; color: #3b82f6;">catalog-service:3000</div>
        </div>
      </div>

      <h3 style="font-size: 15px; margin-bottom: 12px; color: #cbd5e1; font-weight: 700;">Diagnóstico de Dependências (Readiness)</h3>
      
      <div class="service-card">
        <div class="service-info">
          <div class="service-icon" style="color: #f59e0b;"><i class="fa-solid fa-database"></i></div>
          <div>
            <h4 style="font-size: 14px; font-weight: 700;">Banco de Dados MariaDB / MySQL</h4>
            <p style="font-size: 12px; color: #64748b;">Host: ${process.env.DB_HOST || '35.226.64.52:3306'} • Consulta SELECT 1 ping</p>
          </div>
        </div>
        <span class="status-badge ${dbStatus === 'UP' ? 'healthy' : 'unhealthy'}" style="padding: 4px 12px; font-size: 11px;">
          ${dbStatus}
        </span>
      </div>

      <div class="service-card">
        <div class="service-info">
          <div class="service-icon" style="color: #3b82f6;"><i class="fa-solid fa-shield-halved"></i></div>
          <div>
            <h4 style="font-size: 14px; font-weight: 700;">Microsserviço de Autenticação (Auth Service)</h4>
            <p style="font-size: 12px; color: #64748b;">Comunicação interna: ${AUTH_SERVICE_URL}</p>
          </div>
        </div>
        <span class="status-badge ${authStatus === 'UP' ? 'healthy' : 'unhealthy'}" style="padding: 4px 12px; font-size: 11px;">
          ${authStatus}
        </span>
      </div>

      <div class="actions">
        <button onclick="location.reload()" class="btn btn-primary"><i class="fa-solid fa-rotate"></i> Atualizar Status</button>
        <a href="/health?format=json" class="btn btn-outline" target="_blank"><i class="fa-solid fa-code"></i> Ver JSON Bruto</a>
        <a href="/metrics" class="btn btn-outline"><i class="fa-solid fa-chart-line"></i> Ver Métricas Prometheus</a>
        <a href="/" class="btn btn-outline"><i class="fa-solid fa-arrow-left"></i> Voltar ao Catálogo</a>
      </div>
    </div>
  </div>
</body>
</html>`);
});

// Endpoint /metrics (Padrão Prometheus com Painel Visual & Raw)
app.get('/metrics', (req, res) => {
  const uptime = (Date.now() - metrics.startTime) / 1000;
  const mem = process.memoryUsage();
  const uptimeHours = (uptime / 3600).toFixed(1);

  let totalReqs = 0;
  for (const count of Object.values(metrics.requestsTotal)) {
    totalReqs += count;
  }

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

  // Se a requisição pedir Prometheus puro (Scraper ou ?format=raw)
  const wantsRaw = req.query.format === 'raw' || !req.headers.accept?.includes('text/html');
  if (wantsRaw) {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(prom);
  }

  // Gera linhas da tabela de tráfego
  const routesRows = Object.entries(metrics.requestsTotal).map(([key, count]) => {
    const [method, routePath, status] = key.split('|');
    const isSuccess = status.startsWith('2');
    const isWarn = status.startsWith('4');
    const badgeColor = isSuccess ? '#10b981' : isWarn ? '#f59e0b' : '#ef4444';
    return `<tr>
      <td><span style="background: #1e293b; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 11px;">${method}</span></td>
      <td style="font-weight: 600; font-family: monospace; color: #93c5fd;">${routePath}</td>
      <td><span style="color: ${badgeColor}; font-weight: 700; background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 4px;">${status}</span></td>
      <td style="font-weight: 700; text-align: right;">${count}</td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Métricas Prometheus & Telemetria | Catálogo Tom Hanks</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; background: radial-gradient(circle at top, #1e1b4b 0%, #0b0f19 70%); }
    .container { width: 100%; max-width: 900px; margin: 0 auto; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); margin-bottom: 24px; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid #263352; padding-bottom: 20px; }
    .title-group { display: flex; align-items: center; gap: 12px; }
    .brand-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #fff; }
    h1 { font-size: 22px; font-weight: 800; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .stat-box { background: #0f172a; border: 1px solid #263352; border-radius: 12px; padding: 18px; }
    .stat-label { font-size: 12px; color: #94a3b8; font-weight: 600; text-transform: uppercase; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .stat-val { font-size: 22px; font-weight: 800; color: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th { padding: 12px 14px; background: #0f172a; color: #94a3b8; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; border-bottom: 1px solid #263352; }
    td { padding: 12px 14px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
    tr:last-child td { border-bottom: none; }
    pre { background: #0a0e17; border: 1px solid #263352; border-radius: 10px; padding: 16px; font-family: monospace; font-size: 12px; color: #38bdf8; overflow-x: auto; max-height: 250px; }
    .actions { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
    .btn { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; transition: all 0.2s; border: none; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-primary:hover { background: #2563eb; }
    .btn-outline { background: #0f172a; color: #94a3b8; border: 1px solid #263352; }
    .btn-outline:hover { color: #fff; border-color: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="title-group">
          <div class="brand-icon"><i class="fa-solid fa-chart-line"></i></div>
          <div>
            <h1>Telemetria & Métricas do Sistema</h1>
            <p style="font-size: 13px; color: #94a3b8;">Métricas no Formato Padrão Prometheus (OpenMetrics)</p>
          </div>
        </div>
      </div>

      <div class="grid">
        <div class="stat-box">
          <div class="stat-label"><i class="fa-solid fa-arrow-pointer" style="color: #38bdf8;"></i> Total de Requisições</div>
          <div class="stat-val">${totalReqs}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label"><i class="fa-solid fa-gauge-high" style="color: #f59e0b;"></i> Latência Média</div>
          <div class="stat-val">${(avgDuration * 1000).toFixed(1)} ms</div>
        </div>
        <div class="stat-box">
          <div class="stat-label"><i class="fa-solid fa-memory" style="color: #a855f7;"></i> Memória Heap</div>
          <div class="stat-val">${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB</div>
        </div>
        <div class="stat-box">
          <div class="stat-label"><i class="fa-solid fa-microchip" style="color: #10b981;"></i> RAM Residente (RSS)</div>
          <div class="stat-val">${(mem.rss / 1024 / 1024).toFixed(1)} MB</div>
        </div>
      </div>

      <h3 style="font-size: 15px; margin-bottom: 12px; color: #cbd5e1; font-weight: 700;">Tráfego por Rota & Código de Status HTTP</h3>
      <div style="background: #0f172a; border: 1px solid #263352; border-radius: 12px; overflow: hidden; margin-bottom: 24px;">
        <table>
          <thead>
            <tr>
              <th>Método</th>
              <th>Rota / Endpoint</th>
              <th>Status HTTP</th>
              <th style="text-align: right;">Total de Chamadas</th>
            </tr>
          </thead>
          <tbody>
            ${routesRows || '<tr><td colspan="4" style="text-align: center; padding: 18px; color: #64748b;">Nenhuma requisição registrada ainda.</td></tr>'}
          </tbody>
        </table>
      </div>

      <h3 style="font-size: 15px; margin-bottom: 12px; color: #cbd5e1; font-weight: 700;">Saída de Coleta do Prometheus (Raw Exporter)</h3>
      <pre><code>${prom}</code></pre>

      <div class="actions">
        <button onclick="location.reload()" class="btn btn-primary"><i class="fa-solid fa-rotate"></i> Atualizar Métricas</button>
        <a href="/metrics?format=raw" class="btn btn-outline" target="_blank"><i class="fa-solid fa-code"></i> Ver Formato Prometheus Puro</a>
        <a href="/health" class="btn btn-outline"><i class="fa-solid fa-heart-pulse"></i> Ver Health Check</a>
        <a href="/" class="btn btn-outline"><i class="fa-solid fa-arrow-left"></i> Voltar ao Catálogo</a>
      </div>
    </div>
  </div>
</body>
</html>`);
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