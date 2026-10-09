const express = require('express');
const mysql = require('mysql2/promise');
const cookieSession = require('cookie-session');
const fetch = require('node-fetch');
const path = require('path');
const Minio = require('minio');
const multer = require('multer');
const Stripe = require('stripe');

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

// Configuração do Stripe SDK (Atividade 7 — Modo de Teste)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

let stripe = null;
if (STRIPE_SECRET_KEY) {
  try {
    stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    console.log('[Stripe] SDK inicializado em modo:', STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TESTE (Test Mode)' : 'PRODUÇÃO');
  } catch (err) {
    console.warn('[Stripe] Erro ao instanciar Stripe SDK:', err.message);
  }
}

// O Webhook do Stripe precisa receber o payload como Buffer bruto para validação de assinatura HMAC
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.static('public'));

app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'segredo_super_seguro_da_sessao_tom_hanks'],
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

// Configuração do Cliente MinIO (Object Storage)
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'minio';
const MINIO_PORT = parseInt(process.env.MINIO_PORT, 10) || 9000;
const MINIO_ROOT_USER = process.env.MINIO_ROOT_USER || 'minioadmin';
const MINIO_ROOT_PASSWORD = process.env.MINIO_ROOT_PASSWORD || 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'perfil-fotos';

const minioClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: false,
  accessKey: MINIO_ROOT_USER,
  secretKey: MINIO_ROOT_PASSWORD
});

// Configuração do Multer para upload em memória
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // Limite máximo de 5MB
  },
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (tiposPermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato de arquivo inválido. Apenas imagens JPEG, PNG, WEBP ou GIF são aceitas.'));
    }
  }
});

// Inicialização automática do banco e bucket MinIO
async function initStorageAndDb() {
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

    // Migração de colunas do Plano Premium na tabela usuarios (Atividade 7)
    const [colsPrem] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'is_premium'");
    if (colsPrem.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN is_premium TINYINT(1) DEFAULT 0");
    }

    const [colsCust] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'stripe_customer_id'");
    if (colsCust.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN stripe_customer_id VARCHAR(255) NULL");
    }

    const [colsSub] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'stripe_subscription_id'");
    if (colsSub.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN stripe_subscription_id VARCHAR(255) NULL");
    }

    const [colsSince] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'premium_since'");
    if (colsSince.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN premium_since DATETIME NULL");
    }

    console.log('Tabelas do Catálogo verificadas/inicializadas com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas no catálogo:', err);
  }

  // Inicializa bucket do MinIO
  try {
    const bucketExiste = await minioClient.bucketExists(MINIO_BUCKET);
    if (!bucketExiste) {
      await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
      console.log(`Bucket MinIO "${MINIO_BUCKET}" criado com sucesso.`);
    } else {
      console.log(`Bucket MinIO "${MINIO_BUCKET}" já existe e está pronto para uso.`);
    }
  } catch (err) {
    console.warn(`Aviso na inicialização do MinIO (tentará novamente durante requisições):`, err.message);
  }
}
initStorageAndDb();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
const LOG_SERVICE_URL = process.env.LOG_SERVICE_URL || 'http://log-service:3000';
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Helper para registro de logs de auditoria no Redis Streams
async function registrarLogAuditoria(dados) {
  try {
    await fetch(`${LOG_SERVICE_URL}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
      timeout: 2000
    });
  } catch (err) {
    console.warn('[Log-Service] Não foi possível registrar evento de auditoria:', err.message);
  }
}

// Middleware de Autenticação (Quem é você?)
const exigeLogin = (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Sessão expirada ou não autorizada. Faça login novamente.' });
  }
  next();
};

// Middleware de Autorização RBAC Centralizado (O que você pode fazer?)
const exigeAdmin = async (req, res, next) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Sessão expirada ou não autorizada.' });
  }
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!response.ok) {
      return res.status(401).json({ error: 'Erro ao validar perfil no Auth Service.' });
    }
    const user = await response.json();
    if (user.role !== 'admin') {
      registrarLogAuditoria({
        usuario_id: req.session.userId,
        usuario_nome: user.nome,
        usuario_email: user.email,
        acao: 'ACESSO_NEGADO_403_ADMIN',
        detalhes: { rota: req.originalUrl, metodo: req.method },
        ip: req.ip
      });

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

// ==========================================
// ROTAS DE AUTENTICAÇÃO, 2FA E ATIVAÇÃO
// ==========================================

// Cadastro de Conta (com e-mail real e código de ativação)
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
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy register:', err);
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

// Ativação de Conta com Código de 6 Dígitos
app.post('/api/verify-email', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy verify-email:', err);
    res.status(500).json({ error: 'Erro ao validar código de ativação.' });
  }
});

// Login com Verificação em Duas Etapas (2FA)
app.post('/api/login', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    // Se não exigir 2FA (legado) estabelece sessão; se exigir 2FA, aguarda endpoint verify-2fa
    if (response.ok && data.userId && !data.require2FA) {
      req.session.userId = data.userId;
    }
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy login:', err);
    res.status(500).json({ error: 'Erro de comunicação com o serviço de Autenticação.' });
  }
});

// Validação do Código 2FA e Efetivação da Sessão Segura
app.post('/api/verify-2fa', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (response.ok && data.userId) {
      req.session.userId = data.userId;
    }
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy verify-2fa:', err);
    res.status(500).json({ error: 'Erro ao validar código em duas etapas.' });
  }
});

// Reenvio de Códigos (Ativação de Conta ou 2FA)
app.post('/api/resend-code', async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/resend-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro no proxy resend-code:', err);
    res.status(500).json({ error: 'Erro ao solicitar reenvio de código.' });
  }
});

// Recuperação de Senha
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

// Redefinição de Senha
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

// Logout Seguro
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
});

// Dados do Usuário Autenticado
app.get('/api/me', exigeLogin, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    const user = await response.json();
    if (!response.ok) return res.status(response.status).json(user);

    const fotoUrl = user.foto_chave ? `/api/profile/avatar/${user.foto_chave}` : null;
    const isPremium = user.is_premium === 1 || user.is_premium === true;

    res.json({
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role || 'usuario',
      bio: user.bio || '',
      foto_chave: user.foto_chave,
      foto_url: fotoUrl,
      is_premium: isPremium,
      stripe_customer_id: user.stripe_customer_id,
      premium_since: user.premium_since
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao validar perfil no Auth Service.' });
  }
});

// ==========================================
// ROTAS DE PERFIL SOCIAL E MINIO OBJECT STORAGE
// ==========================================

// 1. Obter Perfil Social Completo do Usuário Logado
app.get('/api/profile', exigeLogin, async (req, res) => {
  try {
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!authRes.ok) return res.status(authRes.status).json({ error: 'Erro ao buscar dados do usuário.' });
    const user = await authRes.json();

    // Contadores de estatísticas sociais
    const [[favCount]] = await pool.query('SELECT COUNT(*) AS total FROM favoritos WHERE usuario_id = ?', [req.session.userId]);
    const [[commCount]] = await pool.query('SELECT COUNT(*) AS total FROM comentarios WHERE usuario_id = ?', [req.session.userId]);
    const [favRows] = await pool.query('SELECT * FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC', [req.session.userId]);

    const fotoUrl = user.foto_chave ? `/api/profile/avatar/${user.foto_chave}` : null;
    const isPremium = user.is_premium === 1 || user.is_premium === true;

    res.json({
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role || 'usuario',
      bio: user.bio || 'Adorador de cinema e dos grandes clássicos de Tom Hanks!',
      foto_url: fotoUrl,
      foto_chave: user.foto_chave,
      is_premium: isPremium,
      stripe_customer_id: user.stripe_customer_id,
      stripe_subscription_id: user.stripe_subscription_id,
      premium_since: user.premium_since,
      limite_favoritos: isPremium || user.role === 'admin' ? 'Ilimitado (VIP)' : 'Máx. 3 filmes',
      total_favoritos: favCount.total,
      total_comentarios: commCount.total,
      favoritos: favRows
    });
  } catch (err) {
    console.error('Erro ao carregar perfil:', err);
    res.status(500).json({ error: 'Erro ao carregar perfil do usuário.' });
  }
});

// 2. Obter Perfil Público de Outro Usuário (Privacidade: NÃO expõe e-mails ou senhas de terceiros)
app.get('/api/profile/:id', exigeLogin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${targetId}`);
    if (!authRes.ok) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const user = await authRes.json();

    const [[favCount]] = await pool.query('SELECT COUNT(*) AS total FROM favoritos WHERE usuario_id = ?', [targetId]);
    const [[commCount]] = await pool.query('SELECT COUNT(*) AS total FROM comentarios WHERE usuario_id = ?', [targetId]);
    const [favRows] = await pool.query('SELECT tmdb_movie_id, titulo, poster_path FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 10', [targetId]);

    const fotoUrl = user.foto_chave ? `/api/profile/avatar/${user.foto_chave}` : null;
    const isPremium = user.is_premium === 1 || user.is_premium === true;

    // Retorna apenas dados públicos seguros (Privacidade LGPD)
    res.json({
      id: user.id,
      nome: user.nome,
      role: user.role || 'usuario',
      bio: user.bio || 'Membro da comunidade do Catálogo Tom Hanks.',
      foto_url: fotoUrl,
      is_premium: isPremium,
      total_favoritos: favCount.total,
      total_comentarios: commCount.total,
      favoritos: favRows
    });
  } catch (err) {
    console.error('Erro ao buscar perfil público:', err);
    res.status(500).json({ error: 'Erro ao buscar perfil de usuário.' });
  }
});

// 3. Atualizar Biografia e Nome do Perfil
app.put('/api/profile', exigeLogin, async (req, res) => {
  const { nome, bio } = req.body;
  try {
    const authRes = await fetch(`${AUTH_SERVICE_URL}/profile/${req.session.userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome, bio })
    });

    const data = await authRes.json();
    if (!authRes.ok) return res.status(authRes.status).json(data);

    registrarLogAuditoria({
      usuario_id: req.session.userId,
      usuario_nome: nome,
      acao: 'ATUALIZAR_PERFIL',
      detalhes: { bio_atualizada: !!bio },
      ip: req.ip
    });

    res.json({ success: true, message: 'Perfil atualizado com sucesso!' });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});

// 4. Upload de Foto de Perfil para o MinIO Object Storage
app.post('/api/profile/upload-photo', exigeLogin, (req, res) => {
  upload.single('foto')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Erro no processamento da imagem.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo de imagem foi enviado.' });
    }

    const userId = req.session.userId;
    const extensao = path.extname(req.file.originalname) || '.jpg';
    const objectKey = `avatar_user_${userId}_${Date.now()}${extensao}`;

    try {
      // Garante que o bucket existe no MinIO
      const bucketExiste = await minioClient.bucketExists(MINIO_BUCKET);
      if (!bucketExiste) {
        await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
      }

      // Envia o buffer binário para o MinIO
      await minioClient.putObject(
        MINIO_BUCKET,
        objectKey,
        req.file.buffer,
        req.file.size,
        { 'Content-Type': req.file.mimetype }
      );

      // Salva apenas a chave de referência do MinIO no MariaDB
      await pool.query('UPDATE usuarios SET foto_chave = ? WHERE id = ?', [objectKey, userId]);

      const fotoUrl = `/api/profile/avatar/${objectKey}`;

      registrarLogAuditoria({
        usuario_id: userId,
        acao: 'UPLOAD_FOTO_PERFIL',
        detalhes: {
          tamanho_bytes: req.file.size,
          mimetype: req.file.mimetype,
          objeto_chave: objectKey
        },
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Foto de perfil enviada e salva no MinIO com sucesso!',
        foto_chave: objectKey,
        foto_url: fotoUrl
      });
    } catch (uploadErr) {
      console.error('Erro ao salvar imagem no MinIO:', uploadErr);
      res.status(500).json({ error: 'Erro ao salvar arquivo no Object Storage: ' + uploadErr.message });
    }
  });
});

// 5. Servir Foto do MinIO via Streaming Proxy com Cache HTTP
app.get('/api/profile/avatar/:key', async (req, res) => {
  const objectKey = req.params.key;

  try {
    const stat = await minioClient.statObject(MINIO_BUCKET, objectKey);
    res.setHeader('Content-Type', stat.metaData['content-type'] || 'image/jpeg');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache de 24h

    const dataStream = await minioClient.getObject(MINIO_BUCKET, objectKey);
    dataStream.pipe(res);
  } catch (err) {
    if (err.code === 'NotFound' || err.code === 'NoSuchKey') {
      return res.status(404).json({ error: 'Imagem de perfil não encontrada.' });
    }
    console.error('Erro ao buscar imagem no MinIO:', err);
    res.status(500).json({ error: 'Erro ao carregar imagem do armazenamento.' });
  }
});

// ==========================================
// ROTAS DO PLANO PREMIUM (STRIPE PAGAMENTOS & WEBHOOKS) - ATIVIDADE 7
// ==========================================

// 1. Webhook Oficial do Stripe (Recebe confirmações assíncronas do Stripe com validação de assinatura)
app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  if (stripe && STRIPE_WEBHOOK_SECRET && sig) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('⚠️ [Stripe Webhook] Falha na validação da assinatura HMAC:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // Modo de fallback / teste / simulação
    try {
      event = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    } catch (e) {
      return res.status(400).send('Invalid JSON payload');
    }
  }

  console.log(`[Stripe Webhook] Evento recebido: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const usuarioId = session.client_reference_id || (session.metadata && session.metadata.usuario_id);
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        if (usuarioId) {
          // Atualiza usuário para Premium no banco de dados
          await pool.query(
            'UPDATE usuarios SET is_premium = 1, stripe_customer_id = ?, stripe_subscription_id = ?, premium_since = NOW() WHERE id = ?',
            [customerId || null, subscriptionId || null, usuarioId]
          );

          // Notifica Auth Service
          try {
            await fetch(`${AUTH_SERVICE_URL}/users/${usuarioId}/premium`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                is_premium: 1,
                stripe_customer_id: customerId,
                stripe_subscription_id: subscriptionId
              })
            });
          } catch (syncErr) {
            console.warn('[Stripe Sync] Auth Service sincronização secundária:', syncErr.message);
          }

          registrarLogAuditoria({
            usuario_id: parseInt(usuarioId, 10),
            acao: 'PLANO_PREMIUM_ASSINADO',
            detalhes: {
              stripe_session_id: session.id,
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              valor_pago: session.amount_total ? (session.amount_total / 100) : 9.90,
              moeda: session.currency || 'brl',
              modo: session.mode || 'subscription'
            },
            ip: req.ip
          });

          console.log(`✅ [Stripe] Usuário ID ${usuarioId} ativado como PREMIUM com sucesso!`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        if (customerId) {
          await pool.query(
            'UPDATE usuarios SET is_premium = 0 WHERE stripe_customer_id = ? OR stripe_subscription_id = ?',
            [customerId, subscription.id]
          );

          registrarLogAuditoria({
            acao: 'PLANO_PREMIUM_CANCELADO',
            detalhes: { stripe_subscription_id: subscription.id, stripe_customer_id: customerId },
            ip: req.ip
          });
          console.log(`ℹ️ [Stripe] Assinatura ${subscription.id} cancelada no banco de dados.`);
        }
        break;
      }

      default:
        console.log(`[Stripe Webhook] Evento informativo: ${event.type}`);
    }

    res.json({ received: true, event_type: event.type });
  } catch (err) {
    console.error('[Stripe Webhook] Erro ao processar:', err);
    res.status(500).json({ error: 'Erro interno ao processar webhook do Stripe.' });
  }
});

// 2. Criar Checkout Session do Stripe (Redirecionamento para pagamento)
app.post('/api/premium/checkout', exigeLogin, async (req, res) => {
  try {
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!authRes.ok) return res.status(401).json({ error: 'Usuário não autenticado.' });
    const user = await authRes.json();

    const host = req.get('x-forwarded-host') || req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const baseUrl = process.env.APP_URL || `${proto}://${host}`;

    // Se Stripe SDK e chave estiverem configurados, cria sessão oficial no Stripe
    if (stripe && STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.includes('placeholder')) {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        line_items: [
          {
            price_data: {
              currency: 'brl',
              product_data: {
                name: 'Plano Premium — Catálogo Tom Hanks',
                description: 'Favoritos Ilimitados, Selo VIP [PREMIUM 👑] e Recursos Exclusivos',
              },
              unit_amount: 990, // R$ 9,90/mês
              recurring: { interval: 'month' }
            },
            quantity: 1
          }
        ],
        customer_email: user.email,
        client_reference_id: String(user.id),
        metadata: {
          usuario_id: String(user.id),
          usuario_nome: user.nome,
          usuario_email: user.email
        },
        success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}&premium_success=true`,
        cancel_url: `${baseUrl}/?premium_canceled=true`
      });

      registrarLogAuditoria({
        usuario_id: user.id,
        usuario_nome: user.nome,
        usuario_email: user.email,
        acao: 'CHECKOUT_STRIPE_CRIADO',
        detalhes: { session_id: session.id, modo: 'subscription', valor: 'R$ 9,90/mês' },
        ip: req.ip
      });

      return res.json({ url: session.url, sessionId: session.id, isLiveStripe: true });
    } else {
      // Modo de Teste / Simulador Integrado para demonstração sem chave externa
      const mockSessionId = 'cs_test_' + require('crypto').randomBytes(12).toString('hex');
      const checkoutUrl = `/stripe-checkout.html?session_id=${mockSessionId}&user_id=${user.id}&nome=${encodeURIComponent(user.nome)}&email=${encodeURIComponent(user.email)}`;

      registrarLogAuditoria({
        usuario_id: user.id,
        usuario_nome: user.nome,
        usuario_email: user.email,
        acao: 'CHECKOUT_STRIPE_SIMULADOR_CRIADO',
        detalhes: { session_id: mockSessionId, valor: 'R$ 9,90/mês', modo: 'test_simulation' },
        ip: req.ip
      });

      return res.json({ url: checkoutUrl, sessionId: mockSessionId, isSimulated: true });
    }
  } catch (err) {
    console.error('Erro ao gerar checkout session no Stripe:', err);
    res.status(500).json({ error: 'Erro ao conectar com o serviço Stripe: ' + err.message });
  }
});

// 3. Simulação de Webhook (Para demonstração prática e testes em ambiente isolado)
app.post('/api/premium/simulate-webhook', exigeLogin, async (req, res) => {
  const { session_id, user_id, email } = req.body;
  const targetUserId = user_id || req.session.userId;

  try {
    const customerId = 'cus_test_' + require('crypto').randomBytes(8).toString('hex');
    const subscriptionId = 'sub_test_' + require('crypto').randomBytes(8).toString('hex');

    await pool.query(
      'UPDATE usuarios SET is_premium = 1, stripe_customer_id = ?, stripe_subscription_id = ?, premium_since = NOW() WHERE id = ?',
      [customerId, subscriptionId, targetUserId]
    );

    // Notifica Auth Service
    try {
      await fetch(`${AUTH_SERVICE_URL}/users/${targetUserId}/premium`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_premium: 1,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId
        })
      });
    } catch (e) {}

    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${targetUserId}`);
    const user = authRes.ok ? await authRes.json() : { nome: 'Usuário', email };

    registrarLogAuditoria({
      usuario_id: parseInt(targetUserId, 10),
      usuario_nome: user.nome,
      usuario_email: user.email,
      acao: 'PLANO_PREMIUM_ASSINADO',
      detalhes: {
        stripe_session_id: session_id || 'cs_test_manual',
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        valor_pago: 9.90,
        moeda: 'brl',
        modo: 'simulado_stripe_test'
      },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Plano Premium ativado com sucesso! Webhook processado.',
      is_premium: true,
      stripe_customer_id: customerId
    });
  } catch (err) {
    console.error('Erro na simulação do webhook:', err);
    res.status(500).json({ error: 'Erro ao processar ativação: ' + err.message });
  }
});

// 4. Status e Benefícios do Plano Premium
app.get('/api/premium/status', exigeLogin, async (req, res) => {
  try {
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!authRes.ok) return res.status(401).json({ error: 'Usuário não autenticado.' });
    const user = await authRes.json();

    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM favoritos WHERE usuario_id = ?', [req.session.userId]);
    const isPremium = user.is_premium === 1 || user.is_premium === true;

    res.json({
      is_premium: isPremium,
      role: user.role,
      stripe_customer_id: user.stripe_customer_id,
      stripe_subscription_id: user.stripe_subscription_id,
      premium_since: user.premium_since,
      beneficios: {
        favoritos_usados: total,
        favoritos_limite: isPremium || user.role === 'admin' ? 'Ilimitado' : 3,
        selo_vip: isPremium || user.role === 'admin',
        acesso_prioritario: isPremium || user.role === 'admin'
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar status premium.' });
  }
});

// 5. Cancelamento do Plano Premium
app.post('/api/premium/cancel', exigeLogin, async (req, res) => {
  try {
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!authRes.ok) return res.status(401).json({ error: 'Usuário não autenticado.' });
    const user = await authRes.json();

    if (stripe && user.stripe_subscription_id && !user.stripe_subscription_id.startsWith('sub_test_')) {
      try {
        await stripe.subscriptions.cancel(user.stripe_subscription_id);
      } catch (stripeErr) {
        console.warn('[Stripe Cancel] Erro no Stripe API:', stripeErr.message);
      }
    }

    await pool.query('UPDATE usuarios SET is_premium = 0 WHERE id = ?', [req.session.userId]);

    registrarLogAuditoria({
      usuario_id: user.id,
      usuario_nome: user.nome,
      usuario_email: user.email,
      acao: 'PLANO_PREMIUM_CANCELADO',
      detalhes: { stripe_customer_id: user.stripe_customer_id },
      ip: req.ip
    });

    res.json({ success: true, message: 'Assinatura do Plano Premium cancelada com sucesso.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cancelar assinatura: ' + err.message });
  }
});

// ==========================================
// ROTAS DE DOMÍNIO (FILMES, FAVORITOS, COMENTÁRIOS)
// ==========================================

// Filmes do TMDB
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

// Meus Favoritos
app.get('/api/favorites', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM favoritos WHERE usuario_id = ? ORDER BY criado_em DESC', [req.session.userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar favoritos.' });
  }
});

// Adicionar aos Favoritos (Enforcement de Limite: 3 filmes para Grátis, Ilimitado para Premium)
app.post('/api/favorites', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, titulo, poster_path } = req.body;
  try {
    // 1. Obter informações de papel e premium do usuário
    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    const user = authRes.ok ? await authRes.json() : { role: 'usuario', is_premium: 0 };
    
    const isVip = user.role === 'admin' || user.is_premium === 1 || user.is_premium === true;

    // 2. Contar quantos favoritos o usuário já possui
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM favoritos WHERE usuario_id = ?', [req.session.userId]);

    // Limite da regra de negócio: usuários comuns podem favoritar no máximo 3 filmes
    const LIMITE_FAVORITOS_GRATIS = 3;
    if (!isVip && total >= LIMITE_FAVORITOS_GRATIS) {
      registrarLogAuditoria({
        usuario_id: req.session.userId,
        usuario_nome: user.nome,
        usuario_email: user.email,
        acao: 'LIMITE_FAVORITOS_BLOQUEADO_403',
        detalhes: {
          total_atual: total,
          limite: LIMITE_FAVORITOS_GRATIS,
          filme_tentado: titulo,
          motivo: 'upgrade_premium_necessario'
        },
        ip: req.ip
      });

      return res.status(403).json({
        error: `Limite de favoritos atingido (${total}/${LIMITE_FAVORITOS_GRATIS} filmes). Assine o Plano Premium por R$ 9,90/mês para ter favoritos ilimitados e selo VIP!`,
        limitReached: true,
        currentTotal: total,
        maxLimit: LIMITE_FAVORITOS_GRATIS,
        code: 'UPGRADE_REQUIRED'
      });
    }

    await pool.query('INSERT INTO favoritos (usuario_id, tmdb_movie_id, titulo, poster_path) VALUES (?, ?, ?, ?)', 
      [req.session.userId, tmdb_movie_id, titulo, poster_path]);
    
    registrarLogAuditoria({
      usuario_id: req.session.userId,
      acao: 'FAVORITAR_FILME',
      detalhes: { tmdb_movie_id, titulo, is_premium: isVip, total_atual: total + 1 },
      ip: req.ip
    });

    res.json({ success: true, is_premium: isVip, total_favoritos: total + 1 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Filme já favoritado.' });
    console.error('Erro ao favoritar:', err);
    res.status(500).json({ error: 'Erro ao favoritar filme.' });
  }
});

// Remover dos Favoritos
app.delete('/api/favorites/:tmdbId', exigeLogin, async (req, res) => {
  try {
    await pool.query('DELETE FROM favoritos WHERE usuario_id = ? AND tmdb_movie_id = ?', [req.session.userId, req.params.tmdbId]);
    res.json({ success: true, message: 'Filme removido dos favoritos.' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desfavoritar.' });
  }
});

// Listar Comentários da Comunidade (com Selo VIP Premium para assinantes)
app.get('/api/comments', exigeLogin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.usuario_id, c.tmdb_movie_id, c.texto, c.criado_em,
             u.nome AS autor_nome, u.role AS autor_role, u.is_premium AS autor_is_premium,
             u.foto_chave AS autor_foto_chave, u.bio AS autor_bio
      FROM comentarios c
      LEFT JOIN usuarios u ON c.usuario_id = u.id
      ORDER BY c.criado_em DESC
    `);

    const commentsWithAvatars = rows.map(c => ({
      id: c.id,
      usuario_id: c.usuario_id,
      tmdb_movie_id: c.tmdb_movie_id,
      texto: c.texto,
      criado_em: c.criado_em,
      autor_nome: c.autor_nome || 'Usuário',
      autor_role: c.autor_role || 'usuario',
      autor_is_premium: c.autor_is_premium === 1 || c.autor_is_premium === true,
      autor_bio: c.autor_bio || '',
      autor_foto_url: c.autor_foto_chave ? `/api/profile/avatar/${c.autor_foto_chave}` : null
    }));

    res.json(commentsWithAvatars);
  } catch (err) {
    console.error('Erro ao carregar comentários:', err);
    res.status(500).json({ error: 'Erro ao carregar comentários.' });
  }
});

// Criar Comentário
app.post('/api/comments', exigeLogin, async (req, res) => {
  const { tmdb_movie_id, texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: 'Comentário vazio.' });
  try {
    const [result] = await pool.query(
      'INSERT INTO comentarios (usuario_id, tmdb_movie_id, texto) VALUES (?, ?, ?)',
      [req.session.userId, tmdb_movie_id, texto.trim()]
    );

    registrarLogAuditoria({
      usuario_id: req.session.userId,
      acao: 'COMENTAR_FILME',
      detalhes: { comentario_id: result.insertId, tmdb_movie_id, preview: texto.trim().substring(0, 60) },
      ip: req.ip
    });

    res.json({ success: true, message: 'Comentário registrado com sucesso.' });
  } catch (err) {
    console.error('Erro ao comentar:', err);
    res.status(500).json({ error: 'Erro ao comentar.' });
  }
});

// Excluir Comentário (RBAC: Dono ou Admin)
app.delete('/api/comments/:id', exigeLogin, async (req, res) => {
  const commentId = req.params.id;
  try {
    const [rows] = await pool.query('SELECT * FROM comentarios WHERE id = ?', [commentId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Comentário não encontrado.' });
    }
    const comment = rows[0];

    const authRes = await fetch(`${AUTH_SERVICE_URL}/verify-user/${req.session.userId}`);
    if (!authRes.ok) {
      return res.status(401).json({ error: 'Falha ao validar papel no serviço de autenticação.' });
    }
    const user = await authRes.json();

    const isOwner = (comment.usuario_id === req.session.userId);
    const isAdmin = (user.role === 'admin');

    if (!isOwner && !isAdmin) {
      registrarLogAuditoria({
        usuario_id: req.session.userId,
        usuario_nome: user.nome,
        usuario_email: user.email,
        acao: 'ACESSO_NEGADO_403_COMENTARIO',
        detalhes: {
          motivo: 'Tentativa de exclusão de comentário pertencente a outro usuário',
          comentario_id: commentId,
          autor_comentario_id: comment.usuario_id
        },
        ip: req.ip
      });

      return res.status(403).json({
        error: 'Acesso negado (403 Forbidden): Apenas o autor do comentário ou um administrador podem excluir este comentário.'
      });
    }

    await pool.query('DELETE FROM comentarios WHERE id = ?', [commentId]);

    registrarLogAuditoria({
      usuario_id: req.session.userId,
      usuario_nome: user.nome,
      usuario_email: user.email,
      acao: isAdmin && !isOwner ? 'MODERACAO_EXCLUIR_COMENTARIO' : 'EXCLUIR_COMENTARIO_PROPRIO',
      detalhes: {
        comentario_id: commentId,
        autor_original_id: comment.usuario_id,
        acao_por: isAdmin && !isOwner ? 'admin (moderação)' : 'autor'
      },
      ip: req.ip
    });

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

// ==========================================
// ROTAS ADMINISTRATIVAS & AUDITORIA REDIS
// ==========================================

// Listar Usuários (Exclusivo Admin)
app.get('/api/users', exigeAdmin, async (req, res) => {
  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/users`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar usuários no Auth Service.' });
  }
});

// Alterar Papel de Usuário (Exclusivo Admin)
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

// Consultar Logs de Auditoria do Redis Streams (Exclusivo Admin)
app.get('/api/admin/logs', exigeAdmin, async (req, res) => {
  try {
    const limit = req.query.limit || 100;
    const acao = req.query.acao || '';
    const query = new URLSearchParams({ limit, ...(acao ? { acao } : {}) }).toString();
    const response = await fetch(`${LOG_SERVICE_URL}/logs?${query}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Erro ao buscar logs de auditoria:', err);
    res.status(500).json({ error: 'Erro ao consultar logs de auditoria no Log Service.' });
  }
});

// ==========================================
// OBSERVABILIDADE (HEALTH CHECKS & PROMETHEUS METRICS)
// ==========================================

app.get('/health', async (req, res) => {
  const startTime = Date.now();
  let dbStatus = 'DOWN';
  let dbError = null;
  let authStatus = 'DOWN';
  let authError = null;
  let logStatus = 'DOWN';
  let logError = null;
  let minioStatus = 'DOWN';
  let minioError = null;

  // 1. Testa conectividade com MariaDB / MySQL
  try {
    const [rows] = await pool.query('SELECT 1 AS alive');
    if (rows && rows.length > 0) dbStatus = 'UP';
  } catch (err) {
    dbError = err.message;
  }

  // 2. Testa comunicação com o Auth Service
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

  // 3. Testa comunicação com o Log Service (Redis Streams)
  try {
    const logRes = await fetch(`${LOG_SERVICE_URL}/health?format=json`, { timeout: 3000 });
    if (logRes.ok) {
      logStatus = 'UP';
    } else {
      logError = `Log Service respondeu com status ${logRes.status}`;
    }
  } catch (err) {
    logError = err.message;
  }

  // 4. Testa conectividade com o MinIO Object Storage
  try {
    const minioBucketCheck = await minioClient.bucketExists(MINIO_BUCKET);
    if (minioBucketCheck !== undefined) {
      minioStatus = 'UP';
    }
  } catch (err) {
    minioError = err.message;
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
      },
      logService: {
        status: logStatus,
        url: LOG_SERVICE_URL,
        ...(logError && { error: logError })
      },
      minioStorage: {
        status: minioStatus,
        endpoint: `${MINIO_ENDPOINT}:${MINIO_PORT}`,
        bucket: MINIO_BUCKET,
        ...(minioError && { error: minioError })
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Health Check & Observabilidade | Catálogo Tom Hanks</title>
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
    .status-badge { padding: 8px 18px; border-radius: 50px; font-size: 13px; font-weight: 800; display: inline-flex; align-items: center; gap: 8px; text-transform: uppercase; }
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
    .btn { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border: none; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-outline { background: #0f172a; color: #94a3b8; border: 1px solid #263352; }
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
            <p style="font-size: 13px; color: #94a3b8;">Monitoramento em Tempo Real das Dependências do Sistema</p>
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

      <div class="service-card">
        <div class="service-info">
          <div class="service-icon" style="color: #f59e0b;"><i class="fa-solid fa-database"></i></div>
          <div>
            <h4 style="font-size: 14px; font-weight: 700;">Banco de Dados MariaDB / MySQL</h4>
            <p style="font-size: 12px; color: #64748b;">Host: ${process.env.DB_HOST || '35.226.64.52:3306'}</p>
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

      <div class="service-card">
        <div class="service-info">
          <div class="service-icon" style="color: #ef4444;"><i class="fa-solid fa-list-check"></i></div>
          <div>
            <h4 style="font-size: 14px; font-weight: 700;">Microsserviço de Logs & Auditoria (Redis Streams)</h4>
            <p style="font-size: 12px; color: #64748b;">Comunicação interna: ${LOG_SERVICE_URL}</p>
          </div>
        </div>
        <span class="status-badge ${logStatus === 'UP' ? 'healthy' : 'unhealthy'}" style="padding: 4px 12px; font-size: 11px;">
          ${logStatus}
        </span>
      </div>

      <div class="service-card">
        <div class="service-info">
          <div class="service-icon" style="color: #10b981;"><i class="fa-solid fa-cloud-arrow-up"></i></div>
          <div>
            <h4 style="font-size: 14px; font-weight: 700;">Object Storage MinIO (Fotos de Perfil)</h4>
            <p style="font-size: 12px; color: #64748b;">Host: ${MINIO_ENDPOINT}:${MINIO_PORT} • Bucket: ${MINIO_BUCKET}</p>
          </div>
        </div>
        <span class="status-badge ${minioStatus === 'UP' ? 'healthy' : 'unhealthy'}" style="padding: 4px 12px; font-size: 11px;">
          ${minioStatus}
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

  const wantsRaw = req.query.format === 'raw' || !req.headers.accept?.includes('text/html');
  if (wantsRaw) {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(prom);
  }

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Métricas Prometheus | Catálogo Tom Hanks</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; display: flex; justify-content: center; align-items: center; background: radial-gradient(circle at top, #1e1b4b 0%, #0b0f19 70%); }
    .container { width: 100%; max-width: 900px; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    pre { background: #0a0e17; border: 1px solid #263352; border-radius: 10px; padding: 16px; font-family: monospace; font-size: 12px; color: #38bdf8; overflow-x: auto; max-height: 300px; margin-top: 16px; }
    .btn { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border: none; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-outline { background: #0f172a; color: #94a3b8; border: 1px solid #263352; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1 style="font-size: 22px; font-weight: 800; margin-bottom: 8px;"><i class="fa-solid fa-chart-line" style="color: #3b82f6; margin-right: 10px;"></i>Métricas do Sistema (Catalog Service)</h1>
      <pre><code>${prom}</code></pre>
      <div style="display: flex; gap: 12px; margin-top: 20px;">
        <button onclick="location.reload()" class="btn btn-primary"><i class="fa-solid fa-rotate"></i> Atualizar</button>
        <a href="/metrics?format=raw" class="btn btn-outline" target="_blank"><i class="fa-solid fa-code"></i> Prometheus Raw</a>
        <a href="/health" class="btn btn-outline"><i class="fa-solid fa-heart-pulse"></i> Health Check</a>
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