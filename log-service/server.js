const express = require('express');
const Redis = require('ioredis');
const path = require('path');

const app = express();
app.use(express.json());

// Métricas em memória para o endpoint /metrics (Padrão Prometheus)
const metrics = {
  requestsTotal: {},
  requestDurations: [],
  logsRecorded: 0,
  logsQueried: 0,
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

// Conexão com Redis
const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = parseInt(process.env.REDIS_PORT) || 6379;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
  lazyConnect: false
});

redis.on('connect', () => console.log(`✅ [Log Service] Conectado ao Redis em ${REDIS_HOST}:${REDIS_PORT}`));
redis.on('error', (err) => console.error('❌ [Log Service] Erro no Redis:', err.message));

// 1. Gravar Evento de Auditoria no Redis Streams (XADD)
app.post('/logs', async (req, res) => {
  const { usuario_id, usuario_nome, usuario_email, acao, detalhes, ip, timestamp } = req.body;

  if (!acao) {
    return res.status(400).json({ error: 'O campo "acao" é obrigatório para o log de auditoria.' });
  }

  const logTimestamp = timestamp || new Date().toISOString();
  const clientIp = ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const detalhesStr = typeof detalhes === 'object' ? JSON.stringify(detalhes) : String(detalhes || '');

  try {
    const streamId = await redis.xadd(
      'audit_logs',
      '*',
      'usuario_id', String(usuario_id || 'anonimo'),
      'usuario_nome', String(usuario_nome || 'Anônimo'),
      'usuario_email', String(usuario_email || 'N/A'),
      'acao', String(acao),
      'detalhes', detalhesStr,
      'ip', String(clientIp),
      'timestamp', logTimestamp
    );

    metrics.logsRecorded++;
    res.status(200).json({
      success: true,
      message: 'Evento registrado com sucesso no Redis Stream.',
      streamId,
      timestamp: logTimestamp
    });
  } catch (err) {
    console.error('Erro ao gravar log no Redis:', err);
    res.status(500).json({ error: 'Erro ao persistir evento no Redis Stream.', details: err.message });
  }
});

// 2. Consultar Logs Recentes no Redis Streams (XREVRANGE)
app.get('/logs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const filtroAcao = req.query.acao;

  try {
    const rawLogs = await redis.xrevrange('audit_logs', '+', '-', 'COUNT', limit);
    metrics.logsQueried++;

    let logs = rawLogs.map(([id, fields]) => {
      const obj = { id };
      for (let i = 0; i < fields.length; i += 2) {
        const key = fields[i];
        const val = fields[i + 1];
        if (key === 'detalhes') {
          try {
            obj[key] = JSON.parse(val);
          } catch (e) {
            obj[key] = val;
          }
        } else if (key === 'usuario_id' && val !== 'anonimo') {
          obj[key] = isNaN(val) ? val : Number(val);
        } else {
          obj[key] = val;
        }
      }
      return obj;
    });

    if (filtroAcao) {
      logs = logs.filter(l => l.acao && l.acao.toLowerCase() === filtroAcao.toLowerCase());
    }

    res.json(logs);
  } catch (err) {
    console.error('Erro ao consultar logs no Redis:', err);
    res.status(500).json({ error: 'Erro ao consultar eventos no Redis Stream.', details: err.message });
  }
});

// 3. Endpoint /health (Liveness & Readiness testando o Redis)
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  let redisStatus = 'DOWN';
  let redisError = null;

  try {
    const ping = await redis.ping();
    if (ping === 'PONG') {
      redisStatus = 'UP';
    }
  } catch (err) {
    redisError = err.message;
  }

  const isHealthy = (redisStatus === 'UP');
  const responseTimeMs = Date.now() - startTime;
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeFormatted = `${hours}h ${minutes}m ${seconds}s`;

  const payload = {
    status: isHealthy ? 'UP' : 'DOWN',
    service: 'log-service',
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    responseTimeMs,
    checks: {
      redis: {
        status: redisStatus,
        host: `${REDIS_HOST}:${REDIS_PORT}`,
        stream: 'audit_logs',
        ...(redisError && { error: redisError })
      }
    }
  };

  const wantsJson = req.query.format === 'json' || req.headers.accept?.includes('application/json') || !req.headers.accept?.includes('text/html');
  if (wantsJson) {
    return res.status(isHealthy ? 200 : 503).json(payload);
  }

  res.status(isHealthy ? 200 : 503).send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Health Check | Log Service (Redis)</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; display: flex; justify-content: center; align-items: center; background: radial-gradient(circle at top, #1e1b4b 0%, #0b0f19 70%); }
    .container { width: 100%; max-width: 700px; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid #263352; padding-bottom: 20px; }
    .title-group { display: flex; align-items: center; gap: 12px; }
    .brand-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #dc2626, #991b1b); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #fff; }
    h1 { font-size: 22px; font-weight: 800; }
    .status-badge { padding: 8px 18px; border-radius: 50px; font-size: 13px; font-weight: 800; display: inline-flex; align-items: center; gap: 8px; text-transform: uppercase; }
    .status-badge.healthy { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); }
    .status-badge.unhealthy { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.2); } }
    .service-card { background: #0f172a; border: 1px solid #263352; border-radius: 12px; padding: 20px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
    .btn { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border: none; }
    .btn-primary { background: #dc2626; color: #fff; }
    .btn-outline { background: #0f172a; color: #94a3b8; border: 1px solid #263352; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="header">
        <div class="title-group">
          <div class="brand-icon"><i class="fa-solid fa-list-check"></i></div>
          <div>
            <h1>Log Service — Health Check</h1>
            <p style="font-size: 13px; color: #94a3b8;">Auditoria & Telemetria Redis Streams</p>
          </div>
        </div>
        <div class="status-badge ${isHealthy ? 'healthy' : 'unhealthy'}">
          <div class="pulse"></div> ${isHealthy ? 'REDIS ONLINE' : 'REDIS FORA DO AR'}
        </div>
      </div>

      <div class="service-card">
        <div>
          <h4 style="font-size: 14px; font-weight: 700;"><i class="fa-solid fa-server" style="color: #dc2626; margin-right: 8px;"></i>Servidor Redis (Stream: audit_logs)</h4>
          <p style="font-size: 12px; color: #64748b; margin-top: 4px;">Host: ${REDIS_HOST}:${REDIS_PORT} • Uptime: ${uptimeFormatted} • Ping: ${responseTimeMs}ms</p>
        </div>
        <span class="status-badge ${redisStatus === 'UP' ? 'healthy' : 'unhealthy'}" style="padding: 4px 12px; font-size: 11px;">
          ${redisStatus}
        </span>
      </div>

      <div style="display: flex; gap: 12px; margin-top: 24px;">
        <button onclick="location.reload()" class="btn btn-primary"><i class="fa-solid fa-rotate"></i> Atualizar</button>
        <a href="/health?format=json" class="btn btn-outline" target="_blank"><i class="fa-solid fa-code"></i> JSON Bruto</a>
        <a href="/metrics" class="btn btn-outline"><i class="fa-solid fa-chart-line"></i> Métricas</a>
      </div>
    </div>
  </div>
</body>
</html>`);
});

// 4. Endpoint /metrics (Padrão Prometheus)
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

  prom += `# HELP audit_logs_recorded_total Total audit events recorded to Redis\n`;
  prom += `# TYPE audit_logs_recorded_total counter\n`;
  prom += `audit_logs_recorded_total ${metrics.logsRecorded}\n\n`;

  prom += `# HELP audit_logs_queried_total Total audit logs query operations\n`;
  prom += `# TYPE audit_logs_queried_total counter\n`;
  prom += `audit_logs_queried_total ${metrics.logsQueried}\n\n`;

  prom += `# HELP http_requests_total Total number of HTTP requests\n`;
  prom += `# TYPE http_requests_total counter\n`;
  for (const [key, count] of Object.entries(metrics.requestsTotal)) {
    const [method, routePath, status] = key.split('|');
    prom += `http_requests_total{method="${method}",path="${routePath}",status="${status}"} ${count}\n`;
  }

  const wantsRaw = req.query.format === 'raw' || !req.headers.accept?.includes('text/html');
  if (wantsRaw) {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(prom);
  }

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Métricas Log Service | Prometheus</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; display: flex; justify-content: center; align-items: center; }
    .container { width: 100%; max-width: 800px; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    pre { background: #0a0e17; border: 1px solid #263352; border-radius: 10px; padding: 16px; font-family: monospace; font-size: 12px; color: #38bdf8; overflow-x: auto; max-height: 350px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1 style="font-size: 22px; font-weight: 800; margin-bottom: 8px;">📊 Métricas Log Service (Redis Stream)</h1>
      <pre><code>${prom}</code></pre>
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
  <title>Swagger UI — Log Service API</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
  <style>
    body { margin: 0; background: #fafafa; font-family: sans-serif; }
    .swagger-ui .topbar { background-color: #0b0f19; }
    .swagger-ui .topbar-wrapper .link { color: #dc2626; font-weight: bold; }
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
app.listen(PORT, () => console.log(`🚀 [Log Service] Rodando na porta interna ${PORT}`));
