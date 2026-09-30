const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const path = require('path');

const app = express();
app.use(express.json());

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

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// Helper para envio de logs de auditoria para o Log Service (Redis Streams)
async function registrarLogAuditoria(dados) {
  try {
    const logHost = process.env.LOG_SERVICE_HOST || 'log-service';
    const logPort = process.env.LOG_SERVICE_PORT || 3000;
    const logUrl = process.env.LOG_SERVICE_URL || `http://${logHost}:${logPort}`;
    
    // Fallback nativo com http/fetch
    const http = require('http');
    const postData = JSON.stringify(dados);
    const options = {
      hostname: logHost,
      port: logPort,
      path: '/logs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 2000
    };

    const req = http.request(options, () => {});
    req.on('error', () => {});
    req.write(postData);
    req.end();
  } catch (err) {
    console.warn('[Log-Service] Falha ao despachar log de auditoria:', err.message);
  }
}

// Inicialização automática e idempotente das tabelas do banco de dados
async function initDb() {
  try {
    // Tabela de tokens de redefinição de senha
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reset_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        token VARCHAR(255) NOT NULL,
        usuario_id INT NOT NULL,
        criado_em DATETIME NOT NULL,
        expira_em DATETIME NOT NULL,
        usado TINYINT(1) DEFAULT 0,
        INDEX (token)
      ) ENGINE=InnoDB;
    `);

    // Tabela para Códigos de Autenticação (Ativação de Conta e 2FA)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS codigos_autenticacao (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        codigo VARCHAR(10) NOT NULL,
        expira_em DATETIME NOT NULL,
        usado TINYINT(1) DEFAULT 0,
        tentativas INT DEFAULT 0,
        criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (email, tipo, codigo),
        INDEX (usuario_id)
      ) ENGINE=InnoDB;
    `);

    // Verifica e adiciona colunas na tabela usuarios
    const [colsRole] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'role'");
    if (colsRole.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN role VARCHAR(50) DEFAULT 'usuario'");
    }

    const [colsBio] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'bio'");
    if (colsBio.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN bio TEXT NULL");
    }

    const [colsFoto] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'foto_chave'");
    if (colsFoto.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN foto_chave VARCHAR(255) NULL");
    }

    const [colsVerif] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'email_verificado'");
    if (colsVerif.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN email_verificado TINYINT(1) DEFAULT 0");
      // Marca contas já existentes como verificadas para evitar bloqueio acidental
      await pool.query("UPDATE usuarios SET email_verificado = 1 WHERE email_verificado = 0");
    }

    console.log('Banco de dados do Auth Service inicializado com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas do banco no Auth Service:', err);
  }
}
initDb();

function getTransporter() {
  const host = process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io';
  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: (user && pass) ? { user, pass } : undefined,
    tls: {
      rejectUnauthorized: false
    }
  });
}

function getSenderAddress() {
  const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@catalogo.com';
  return `"Catálogo Tom Hanks" <${fromEmail}>`;
}

// Validação Estrita de E-mail Real (Formato + Domínios Falsos + Resolução DNS MX)
async function validarEmailReal(email) {
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  if (!email || !emailRegex.test(email.trim())) {
    return { valido: false, erro: 'Formato de e-mail inválido. Utilize um endereço no padrão nome@dominio.com.' };
  }

  const partes = email.trim().toLowerCase().split('@');
  const dominio = partes[1];

  // Domínios fictícios ou de teste comumente usados que não recebem e-mails
  const dominiosFalsos = [
    'teste.com', 'test.com', 'fake.com', 'exemplo.com', 'example.com', 
    'asdf.com', 'naoexiste.com', 'email.com', 'teste.com.br', 'abc.com', 'temp.com'
  ];

  if (dominiosFalsos.includes(dominio)) {
    return { valido: false, erro: `O domínio "@${dominio}" não é aceito. Por favor, utilize seu endereço de e-mail real.` };
  }

  // Validação em Tempo Real via DNS MX (Mail Exchange)
  try {
    const mxRecords = await dns.resolveMx(dominio);
    if (!mxRecords || mxRecords.length === 0) {
      return { valido: false, erro: `O domínio "@${dominio}" não possui servidores de e-mail válidos (sem registros MX).` };
    }
  } catch (dnsErr) {
    if (dnsErr.code === 'ENOTFOUND' || dnsErr.code === 'ENODATA' || dnsErr.code === 'SERVFAIL') {
      return { valido: false, erro: `O domínio "@${dominio}" não existe ou não pode receber mensagens de e-mail.` };
    }
    // Caso ocorra erro de rede temporário no DNS, domínios consolidados são tolerados
    const dominiosConfiaveis = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'uol.com.br', 'bol.com.br', 'live.com', 'lapps.studio'];
    if (!dominiosConfiaveis.includes(dominio)) {
      return { valido: false, erro: `Não foi possível validar o domínio "@${dominio}". Por favor, informe um e-mail válido.` };
    }
  }

  return { valido: true };
}

// 1. Cadastro com Validação de E-mail Real e Envio de Código de Ativação
app.post('/register', async (req, res) => {
  const { nome, email, senha, role, appUrl } = req.body;
  if (!nome || !email || !senha) {
    return res.status(400).json({ error: 'Por favor, preencha todos os campos obrigatórios.' });
  }

  if (senha.length < 6) {
    return res.status(400).json({ error: 'A senha deve conter no mínimo 6 caracteres para sua segurança.' });
  }

  // Validação estrita de e-mail real
  const checagemEmail = await validarEmailReal(email);
  if (!checagemEmail.valido) {
    return res.status(400).json({ error: checagemEmail.erro });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    // Verifica se o e-mail já existe
    const [existentes] = await pool.query('SELECT id, email_verificado FROM usuarios WHERE email = ?', [cleanEmail]);
    if (existentes.length > 0) {
      const userExistente = existentes[0];
      if (userExistente.email_verificado === 1) {
        return res.status(400).json({ error: 'Este endereço de e-mail já está cadastrado. Faça login ou recupere sua senha.' });
      } else {
        // Usuário iniciou cadastro mas ainda não ativou o e-mail -> Atualiza senha e reenvia código
        const hash = await bcrypt.hash(senha, 10);
        await pool.query('UPDATE usuarios SET nome = ?, senha_hash = ?, role = ? WHERE id = ?', [nome.trim(), hash, role || 'usuario', userExistente.id]);
        
        // Gera código de 6 dígitos
        const codigoAtivacao = String(Math.floor(100000 + Math.random() * 900000));
        const expiraEm = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

        await pool.query('DELETE FROM codigos_autenticacao WHERE email = ? AND tipo = ?', [cleanEmail, 'EMAIL_VERIFICACAO']);
        await pool.query(
          'INSERT INTO codigos_autenticacao (usuario_id, email, tipo, codigo, expira_em) VALUES (?, ?, ?, ?, ?)',
          [userExistente.id, cleanEmail, 'EMAIL_VERIFICACAO', codigoAtivacao, expiraEm]
        );

        await enviarEmailCodigo({
          to: cleanEmail,
          nome: nome.trim(),
          codigo: codigoAtivacao,
          tipo: 'EMAIL_VERIFICACAO'
        });

        registrarLogAuditoria({
          usuario_id: userExistente.id,
          usuario_nome: nome.trim(),
          usuario_email: cleanEmail,
          acao: 'CADASTRO_REENVIADO_CODIGO',
          detalhes: { motivo: 'Reenvio de código para conta pendente de ativação' },
          ip: req.ip
        });

        return res.json({
          success: true,
          requireVerification: true,
          email: cleanEmail,
          message: 'Código de ativação enviado para o seu e-mail!'
        });
      }
    }

    const hash = await bcrypt.hash(senha, 10);
    const userRole = role || 'usuario';

    // Cria o usuário com status email_verificado = 0 (Pendente de Validação)
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role, email_verificado) VALUES (?, ?, ?, ?, 0)',
      [nome.trim(), cleanEmail, hash, userRole]
    );
    const newUserId = result.insertId;

    // Gera Código de Ativação de 6 dígitos
    const codigoAtivacao = String(Math.floor(100000 + Math.random() * 900000));
    const expiraEm = new Date(Date.now() + 15 * 60 * 1000); // 15 min

    await pool.query(
      'INSERT INTO codigos_autenticacao (usuario_id, email, tipo, codigo, expira_em) VALUES (?, ?, ?, ?, ?)',
      [newUserId, cleanEmail, 'EMAIL_VERIFICACAO', codigoAtivacao, expiraEm]
    );

    // Envia o e-mail com o código de 6 dígitos
    await enviarEmailCodigo({
      to: cleanEmail,
      nome: nome.trim(),
      codigo: codigoAtivacao,
      tipo: 'EMAIL_VERIFICACAO'
    });

    registrarLogAuditoria({
      usuario_id: newUserId,
      usuario_nome: nome.trim(),
      usuario_email: cleanEmail,
      acao: 'CADASTRO_SOLICITADO',
      detalhes: { role: userRole, status: 'pendente_verificacao_email' },
      ip: req.ip
    });

    res.json({
      success: true,
      requireVerification: true,
      email: cleanEmail,
      message: 'Cadastro realizado com sucesso! Digite o código de 6 dígitos enviado para seu e-mail para ativar sua conta.'
    });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Este e-mail já está em uso.' });
    res.status(500).json({ error: 'Erro ao processar cadastro: ' + (err.sqlMessage || err.message) });
  }
});

// 2. Validação do Código de Ativação do E-mail
app.post('/verify-email', async (req, res) => {
  const { email, codigo } = req.body;
  if (!email || !codigo) {
    return res.status(400).json({ error: 'E-mail e código de ativação são obrigatórios.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanCodigo = String(codigo).trim();

  try {
    const [rows] = await pool.query(
      `SELECT * FROM codigos_autenticacao 
       WHERE email = ? AND tipo = 'EMAIL_VERIFICACAO' AND usado = 0 
       ORDER BY id DESC LIMIT 1`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Nenhum código de ativação pendente para este e-mail. Solicite um novo código.' });
    }

    const regCodigo = rows[0];
    const agora = new Date();

    if (agora > new Date(regCodigo.expira_em)) {
      return res.status(400).json({ error: 'Código de ativação expirado. Clique em "Reenviar Código".' });
    }

    if (regCodigo.codigo !== cleanCodigo) {
      await pool.query('UPDATE codigos_autenticacao SET tentativas = tentativas + 1 WHERE id = ?', [regCodigo.id]);
      return res.status(400).json({ error: 'Código de ativação incorreto. Verifique o número recebido no seu e-mail.' });
    }

    // Marca o código como usado e ativa o usuário
    await pool.query('UPDATE codigos_autenticacao SET usado = 1 WHERE id = ?', [regCodigo.id]);
    await pool.query('UPDATE usuarios SET email_verificado = 1 WHERE id = ?', [regCodigo.usuario_id]);

    const [userRows] = await pool.query('SELECT id, nome, email, role FROM usuarios WHERE id = ?', [regCodigo.usuario_id]);
    const user = userRows[0];

    // Envia e-mail de boas-vindas definitivo
    await enviarEmailBoasVindas(user.email, user.nome);

    registrarLogAuditoria({
      usuario_id: user.id,
      usuario_nome: user.nome,
      usuario_email: user.email,
      acao: 'EMAIL_VERIFICADO_SUCESSO',
      detalhes: { status: 'conta_ativada' },
      ip: req.ip
    });

    res.json({
      success: true,
      message: 'Conta ativada com sucesso! Você já pode realizar seu login.'
    });
  } catch (err) {
    console.error('Erro na validação de e-mail:', err);
    res.status(500).json({ error: 'Erro ao validar e-mail: ' + err.message });
  }
});

// 3. Login com Verificação em Duas Etapas (2FA via E-mail OTP)
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });

  const cleanEmail = email.trim().toLowerCase();

  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [cleanEmail]);
    if (rows.length === 0) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

    const user = rows[0];
    const match = await bcrypt.compare(senha, user.senha_hash);
    if (!match) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });

    // Verifica se a conta já foi ativada
    if (user.email_verificado === 0) {
      // Reenvia código de ativação caso necessário
      const codigoAtivacao = String(Math.floor(100000 + Math.random() * 900000));
      const expiraEm = new Date(Date.now() + 15 * 60 * 1000);

      await pool.query('DELETE FROM codigos_autenticacao WHERE email = ? AND tipo = ?', [cleanEmail, 'EMAIL_VERIFICACAO']);
      await pool.query(
        'INSERT INTO codigos_autenticacao (usuario_id, email, tipo, codigo, expira_em) VALUES (?, ?, ?, ?, ?)',
        [user.id, cleanEmail, 'EMAIL_VERIFICACAO', codigoAtivacao, expiraEm]
      );

      await enviarEmailCodigo({
        to: cleanEmail,
        nome: user.nome,
        codigo: codigoAtivacao,
        tipo: 'EMAIL_VERIFICACAO'
      });

      return res.status(403).json({
        error: 'Sua conta ainda não foi ativada. Enviamos um novo código para seu e-mail.',
        requireVerification: true,
        email: cleanEmail
      });
    }

    // Gera Código de Verificação em Duas Etapas (2FA) de 6 dígitos
    const codigo2FA = String(Math.floor(100000 + Math.random() * 900000));
    const expiraEm = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await pool.query('DELETE FROM codigos_autenticacao WHERE email = ? AND tipo = ?', [cleanEmail, 'LOGIN_2FA']);
    await pool.query(
      'INSERT INTO codigos_autenticacao (usuario_id, email, tipo, codigo, expira_em) VALUES (?, ?, ?, ?, ?)',
      [user.id, cleanEmail, 'LOGIN_2FA', codigo2FA, expiraEm]
    );

    // Envia o código 2FA por e-mail
    await enviarEmailCodigo({
      to: cleanEmail,
      nome: user.nome,
      codigo: codigo2FA,
      tipo: 'LOGIN_2FA'
    });

    registrarLogAuditoria({
      usuario_id: user.id,
      usuario_nome: user.nome,
      usuario_email: cleanEmail,
      acao: 'LOGIN_2FA_SOLICITADO',
      detalhes: { ip: req.ip, metodo: 'email_otp' },
      ip: req.ip
    });

    res.json({
      success: true,
      require2FA: true,
      email: cleanEmail,
      message: 'Código de verificação em 2 etapas enviado para o seu e-mail!'
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro no login: ' + (err.sqlMessage || err.message) });
  }
});

// 4. Confirmação do Código de Duas Etapas (2FA) para Efetivar a Sessão
app.post('/verify-2fa', async (req, res) => {
  const { email, codigo } = req.body;
  if (!email || !codigo) {
    return res.status(400).json({ error: 'E-mail e código de autenticação são obrigatórios.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanCodigo = String(codigo).trim();

  try {
    const [rows] = await pool.query(
      `SELECT * FROM codigos_autenticacao 
       WHERE email = ? AND tipo = 'LOGIN_2FA' AND usado = 0 
       ORDER BY id DESC LIMIT 1`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Nenhuma sessão 2FA pendente para este e-mail. Faça login novamente.' });
    }

    const regCodigo = rows[0];
    const agora = new Date();

    if (agora > new Date(regCodigo.expira_em)) {
      return res.status(400).json({ error: 'O código de 2 etapas expirou. Solicite um novo código.' });
    }

    if (regCodigo.codigo !== cleanCodigo) {
      await pool.query('UPDATE codigos_autenticacao SET tentativas = tentativas + 1 WHERE id = ?', [regCodigo.id]);
      return res.status(400).json({ error: 'Código de 2 etapas incorreto. Verifique o número enviado por e-mail.' });
    }

    // Marca o código 2FA como usado
    await pool.query('UPDATE codigos_autenticacao SET usado = 1 WHERE id = ?', [regCodigo.id]);

    const [userRows] = await pool.query('SELECT id, nome, email, role, bio, foto_chave FROM usuarios WHERE id = ?', [regCodigo.usuario_id]);
    const user = userRows[0];

    registrarLogAuditoria({
      usuario_id: user.id,
      usuario_nome: user.nome,
      usuario_email: user.email,
      acao: 'LOGIN_SUCESSO',
      detalhes: { role: user.role, autenticado_2fa: true },
      ip: req.ip
    });

    res.json({
      success: true,
      userId: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role || 'usuario',
      bio: user.bio || '',
      foto_url: user.foto_chave ? `/api/profile/avatar/${user.foto_chave}` : null
    });
  } catch (err) {
    console.error('Erro na validação do 2FA:', err);
    res.status(500).json({ error: 'Erro ao validar código em duas etapas: ' + err.message });
  }
});

// 5. Reenvio de Códigos (Ativação ou 2FA)
app.post('/resend-code', async (req, res) => {
  const { email, tipo } = req.body;
  if (!email || !['EMAIL_VERIFICACAO', 'LOGIN_2FA'].includes(tipo)) {
    return res.status(400).json({ error: 'E-mail e tipo de código válidos são obrigatórios.' });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    const [userRows] = await pool.query('SELECT id, nome FROM usuarios WHERE email = ?', [cleanEmail]);
    if (userRows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const user = userRows[0];
    const novoCodigo = String(Math.floor(100000 + Math.random() * 900000));
    const expiraEm = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query('DELETE FROM codigos_autenticacao WHERE email = ? AND tipo = ?', [cleanEmail, tipo]);
    await pool.query(
      'INSERT INTO codigos_autenticacao (usuario_id, email, tipo, codigo, expira_em) VALUES (?, ?, ?, ?, ?)',
      [user.id, cleanEmail, tipo, novoCodigo, expiraEm]
    );

    await enviarEmailCodigo({
      to: cleanEmail,
      nome: user.nome,
      codigo: novoCodigo,
      tipo
    });

    res.json({ success: true, message: 'Novo código de segurança enviado para seu e-mail!' });
  } catch (err) {
    console.error('Erro ao reenviar código:', err);
    res.status(500).json({ error: 'Erro ao reenviar código.' });
  }
});

// 6. Solicitação de Recuperação de Senha (Expira em 30 min)
app.post('/forgot-password', async (req, res) => {
  const { email, appUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail não informado.' });

  const cleanEmail = email.trim().toLowerCase();

  try {
    const [rows] = await pool.query('SELECT id, nome FROM usuarios WHERE email = ?', [cleanEmail]);
    if (rows.length === 0) return res.status(404).json({ error: 'E-mail não encontrado no sistema.' });

    const user = rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + 30 * 60 * 1000); // +30 minutos

    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, criado_em, expira_em, usado) VALUES (?, ?, ?, ?, 0)',
      [token, user.id, agora, expiraEm]
    );

    const baseUrl = appUrl || process.env.APP_URL || 'http://localhost:8200';
    const resetLink = `${baseUrl}/reset-password.html?token=${token}`;

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn('AVISO: SMTP_USER e SMTP_PASS não configurados. Link gerado:', resetLink);
      return res.status(500).json({ 
        error: 'Serviço de e-mail não configurado. Configure SMTP_USER e SMTP_PASS nas variáveis de ambiente.' 
      });
    }

    const transporter = getTransporter();
    await transporter.sendMail({
      from: getSenderAddress(),
      to: cleanEmail,
      subject: '🔑 Recuperação de Senha - Catálogo Tom Hanks',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #0f172a; text-align: center;">🎬 Catálogo Tom Hanks</h2>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
          <h3 style="color: #1e293b;">Recuperação de Senha</h3>
          <p style="font-size: 15px; color: #475569; line-height: 1.6;">
            Olá, <strong>${user.nome}</strong>! Você solicitou a redefinição de senha para sua conta.
          </p>
          <p style="font-size: 14px; color: #475569; line-height: 1.6;">
            Clique no botão abaixo para criar uma nova senha (este link expira em 30 minutos):
          </p>
          <div style="text-align: center; margin: 28px 0;">
            <a href="${resetLink}" style="background-color: #e50914; color: #ffffff; padding: 14px 28px; text-decoration: none; font-size: 15px; font-weight: bold; border-radius: 8px; display: inline-block;">
              Redefinir Minha Senha
            </a>
          </div>
          <p style="font-size: 13px; color: #64748b;">
            Se o botão não abrir, copie e cole este link no seu navegador:<br/>
            <a href="${resetLink}" style="color: #3b82f6; word-break: break-all;">${resetLink}</a>
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">
            Se você não solicitou esta redefinição, fique tranquilo(a): sua conta permanece segura.
          </p>
        </div>
      `
    });

    registrarLogAuditoria({
      usuario_id: user.id,
      usuario_nome: user.nome,
      usuario_email: cleanEmail,
      acao: 'SOLICITACAO_RECUPERACAO_SENHA',
      detalhes: { ip: req.ip },
      ip: req.ip
    });

    res.json({ success: true, message: 'E-mail de recuperação enviado com sucesso!' });
  } catch (err) {
    console.error('Erro ao gerar recuperação de senha:', err);
    res.status(500).json({ error: 'Erro ao enviar e-mail de recuperação: ' + (err.message || err) });
  }
});

// 7. Troca de Senha com Validação de Token
app.post('/reset-password', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });

  if (novaSenha.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT * FROM reset_tokens WHERE token = ? AND usado = 0',
      [token]
    );

    if (rows.length === 0) return res.status(400).json({ error: 'Token de recuperação inválido ou já utilizado.' });

    const resetRecord = rows[0];
    const agora = new Date();

    if (agora > new Date(resetRecord.expira_em)) {
      return res.status(400).json({ error: 'Token expirado. Por favor, solicite um novo link de recuperação.' });
    }

    const hash = await bcrypt.hash(novaSenha, 10);
    
    await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hash, resetRecord.usuario_id]);
    await pool.query('UPDATE reset_tokens SET usado = 1 WHERE id = ?', [resetRecord.id]);

    registrarLogAuditoria({
      usuario_id: resetRecord.usuario_id,
      acao: 'REDEFINICAO_SENHA_SUCESSO',
      detalhes: { ip: req.ip },
      ip: req.ip
    });

    res.json({ success: true, message: 'Senha redefinida com sucesso!' });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err);
    res.status(500).json({ error: 'Erro ao redefinir a senha: ' + (err.message || err) });
  }
});

// 8. Consulta de Dados e Perfil do Usuário (Proteção: NUNCA expõe senha_hash)
app.get('/verify-user/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nome, email, role, bio, foto_chave, email_verificado FROM usuarios WHERE id = ?', 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao buscar usuário:', err);
    res.status(500).json({ error: 'Erro ao buscar dados do usuário.' });
  }
});

// 9. Atualizar perfil do usuário (Bio e Foto)
app.put('/profile/:id', async (req, res) => {
  const { nome, bio } = req.body;
  const userId = req.params.id;

  try {
    await pool.query(
      'UPDATE usuarios SET nome = COALESCE(?, nome), bio = COALESCE(?, bio) WHERE id = ?',
      [nome ? nome.trim() : null, bio !== undefined ? bio.trim() : null, userId]
    );

    const [rows] = await pool.query(
      'SELECT id, nome, email, role, bio, foto_chave FROM usuarios WHERE id = ?',
      [userId]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ error: 'Erro ao atualizar dados do perfil.' });
  }
});

// 10. Listar todos os usuários (Protegido para Administração - Não expõe senhas)
app.get('/users', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nome, email, role, email_verificado, foto_chave FROM usuarios ORDER BY id ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro ao listar usuários:', err);
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

// 11. Atualizar papel de usuário (promoção / rebaixamento RBAC)
app.patch('/users/:id/role', async (req, res) => {
  const { role } = req.body;
  if (!role || !['usuario', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Papel inválido. Deve ser "usuario" ou "admin".' });
  }
  try {
    const [result] = await pool.query('UPDATE usuarios SET role = ? WHERE id = ?', [role, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

    registrarLogAuditoria({
      usuario_id: req.params.id,
      acao: 'ALTERACAO_PAPEL_RBAC',
      detalhes: { novo_papel: role },
      ip: req.ip
    });

    res.json({ success: true, message: `Papel do usuário atualizado para "${role}".` });
  } catch (err) {
    console.error('Erro ao atualizar papel:', err);
    res.status(500).json({ error: 'Erro ao atualizar papel do usuário.' });
  }
});

// Helper de Envio de E-mails com Códigos (2FA e Ativação)
async function enviarEmailCodigo({ to, nome, codigo, tipo }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`[SMTP Não Configurado] Código para ${to} (${tipo}): ${codigo}`);
    return;
  }

  const is2FA = (tipo === 'LOGIN_2FA');
  const assunto = is2FA 
    ? `🔐 Seu Código de Verificação em 2 Etapas: ${codigo}` 
    : `📩 Ative sua conta no Catálogo Tom Hanks: ${codigo}`;

  const tituloCard = is2FA ? 'Verificação em Duas Etapas (2FA)' : 'Ativação de Conta';
  const descricao = is2FA 
    ? 'Você está realizando login no <strong>Catálogo Tom Hanks</strong>. Para confirmar que é realmente você, utilize o código de segurança abaixo:'
    : 'Obrigado por se cadastrar no <strong>Catálogo Tom Hanks</strong>! Para ativar seu acesso e validar seu e-mail, utilize o código abaixo:';

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: getSenderAddress(),
      to,
      subject: assunto,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 550px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; color: #1e293b;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h2 style="color: #0f172a; margin: 0;">🎬 Catálogo Tom Hanks</h2>
            <span style="display: inline-block; background-color: #eff6ff; color: #2563eb; font-size: 12px; font-weight: bold; padding: 4px 12px; border-radius: 20px; margin-top: 8px;">
              ${tituloCard}
            </span>
          </div>
          <p style="font-size: 15px; line-height: 1.6; color: #475569;">
            Olá, <strong>${nome}</strong>!
          </p>
          <p style="font-size: 14px; line-height: 1.6; color: #475569;">
            ${descricao}
          </p>
          <div style="text-align: center; margin: 28px 0;">
            <div style="display: inline-block; background-color: #0f172a; color: #38bdf8; font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 14px 28px; border-radius: 10px; border: 1px solid #334155;">
              ${codigo}
            </div>
            <p style="font-size: 12px; color: #94a3b8; margin-top: 8px;">Este código expira em 10 minutos.</p>
          </div>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.5;">
            Nunca compartilhe este código com ninguém. Se você não solicitou esta autenticação, ignore este e-mail.
          </p>
        </div>
      `
    });
    console.log(`[E-mail Enviado] Código ${tipo} enviado com sucesso para ${to}`);
  } catch (err) {
    console.error(`Erro ao enviar e-mail ${tipo} para ${to}:`, err);
  }
}

// Helper de Envio de Boas-Vindas Definitivo
async function enviarEmailBoasVindas(email, nome) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: getSenderAddress(),
      to: email,
      subject: '🎉 Sua conta no Catálogo Tom Hanks está ativa!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #0f172a; text-align: center;">🎬 Bem-vindo(a), ${nome}!</h2>
          <p style="font-size: 15px; color: #475569; line-height: 1.6;">
            Seu endereço de e-mail foi validado e sua conta no <strong>Catálogo Tom Hanks</strong> está 100% ativada!
          </p>
          <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; padding: 18px; border-radius: 8px; margin: 20px 0;">
            <h4 style="margin-top: 0; color: #0f172a;">Recursos Disponíveis:</h4>
            <ul style="color: #475569; padding-left: 20px; line-height: 1.8; font-size: 14px;">
              <li>⭐ <strong>Explorar filmes</strong> clássicos e sucessos de bilheteria</li>
              <li>❤️ <strong>Favoritar</strong> seus títulos prediletos</li>
              <li>💬 <strong>Comentar</strong> e compartilhar críticas com outros cinéfilos</li>
              <li>📸 <strong>Personalizar seu perfil</strong> com foto e biografia</li>
            </ul>
          </div>
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">
            Catálogo Tom Hanks • Plataforma Segura com Autenticação em Duas Etapas.
          </p>
        </div>
      `
    });
  } catch (err) {
    console.error('Erro ao enviar e-mail de boas-vindas:', err);
  }
}

// Endpoint /health (Liveness & Readiness com Painel Visual & JSON)
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  let dbStatus = 'DOWN';
  let dbError = null;

  try {
    const [rows] = await pool.query('SELECT 1 AS alive');
    if (rows && rows.length > 0) dbStatus = 'UP';
  } catch (err) {
    dbError = err.message;
  }

  const isHealthy = (dbStatus === 'UP');
  const responseTimeMs = Date.now() - startTime;
  const uptimeSeconds = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeFormatted = `${hours}h ${minutes}m ${seconds}s`;

  const payload = {
    status: isHealthy ? 'UP' : 'DOWN',
    service: 'auth-service',
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    responseTimeMs,
    checks: {
      database: {
        status: dbStatus,
        host: process.env.DB_HOST || '35.226.64.52',
        ...(dbError && { error: dbError })
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
  <title>Health Check | Auth Service</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; display: flex; justify-content: center; align-items: center; background: radial-gradient(circle at top, #1e1b4b 0%, #0b0f19 70%); }
    .container { width: 100%; max-width: 700px; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid #263352; padding-bottom: 20px; }
    .title-group { display: flex; align-items: center; gap: 12px; }
    .brand-icon { width: 44px; height: 44px; background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; color: #fff; }
    h1 { font-size: 22px; font-weight: 800; }
    .status-badge { padding: 8px 18px; border-radius: 50px; font-size: 13px; font-weight: 800; display: inline-flex; align-items: center; gap: 8px; text-transform: uppercase; }
    .status-badge.healthy { background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); }
    .status-badge.unhealthy { background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); }
    .pulse { width: 10px; height: 10px; border-radius: 50%; background: currentColor; box-shadow: 0 0 10px currentColor; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.2); } }
    .service-card { background: #0f172a; border: 1px solid #263352; border-radius: 12px; padding: 20px; margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between; }
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
          <div class="brand-icon"><i class="fa-solid fa-shield-halved"></i></div>
          <div>
            <h1>Auth Service — Health Check</h1>
            <p style="font-size: 13px; color: #94a3b8;">Status e Conectividade do Microsserviço de Autenticação</p>
          </div>
        </div>
        <div class="status-badge ${isHealthy ? 'healthy' : 'unhealthy'}">
          <div class="pulse"></div> ${isHealthy ? 'OPERACIONAL' : 'FALHA'}
        </div>
      </div>

      <div class="service-card">
        <div>
          <h4 style="font-size: 14px; font-weight: 700;"><i class="fa-solid fa-database" style="color: #f59e0b; margin-right: 8px;"></i>Conexão MariaDB / MySQL</h4>
          <p style="font-size: 12px; color: #64748b; margin-top: 4px;">Uptime: ${uptimeFormatted} • Latência: ${responseTimeMs}ms</p>
        </div>
        <span class="status-badge ${dbStatus === 'UP' ? 'healthy' : 'unhealthy'}" style="padding: 4px 12px; font-size: 11px;">
          ${dbStatus}
        </span>
      </div>

      <div style="display: flex; gap: 12px; margin-top: 24px;">
        <button onclick="location.reload()" class="btn btn-primary"><i class="fa-solid fa-rotate"></i> Atualizar</button>
        <a href="/health?format=json" class="btn btn-outline" target="_blank"><i class="fa-solid fa-code"></i> JSON Bruto</a>
        <a href="/apidocs" class="btn btn-outline"><i class="fa-solid fa-book"></i> Swagger UI</a>
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
  <title>Métricas Prometheus | Auth Service</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background-color: #0b0f19; color: #f8fafc; min-height: 100vh; padding: 40px 20px; display: flex; justify-content: center; align-items: center; background: radial-gradient(circle at top, #1e1b4b 0%, #0b0f19 70%); }
    .container { width: 100%; max-width: 800px; }
    .card { background: #151d30; border: 1px solid #263352; border-radius: 16px; padding: 36px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    pre { background: #0a0e17; border: 1px solid #263352; border-radius: 10px; padding: 16px; font-family: monospace; font-size: 12px; color: #38bdf8; overflow-x: auto; max-height: 350px; margin-top: 16px; }
    .btn { padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; border: none; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-outline { background: #0f172a; color: #94a3b8; border: 1px solid #263352; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1 style="font-size: 22px; font-weight: 800; margin-bottom: 8px;"><i class="fa-solid fa-chart-line" style="color: #3b82f6; margin-right: 10px;"></i>Métricas Auth Service</h1>
      <p style="font-size: 13px; color: #94a3b8;">Formato OpenMetrics / Prometheus Exporter</p>
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
  <title>Swagger UI — Auth Service API</title>
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
app.listen(PORT, () => console.log(`Auth Service rodando na porta interna ${PORT}`));