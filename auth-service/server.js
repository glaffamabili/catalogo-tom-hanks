const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10
});

// Inicialização automática das tabelas e colunas necessárias
async function initDb() {
  try {
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
    const [cols] = await pool.query("SHOW COLUMNS FROM usuarios LIKE 'role'");
    if (cols.length === 0) {
      await pool.query("ALTER TABLE usuarios ADD COLUMN role VARCHAR(50) DEFAULT 'usuario'");
    }
    console.log('Banco de dados verificado e inicializado com sucesso.');
  } catch (err) {
    console.error('Erro ao inicializar tabelas do banco:', err);
  }
}
initDb();

function getTransporter() {
  const host = process.env.SMTP_HOST || 'sandbox.smtp.mailtrap.io';
  const port = parseInt(process.env.SMTP_PORT, 10) || 2525;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  return nodemailer.createTransport({
    host,
    port,
    auth: (user && pass) ? { user, pass } : undefined
  });
}

// Cadastro com Hash de Senha (bcrypt)
app.post('/register', async (req, res) => {
  const { nome, email, senha, role } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Dados incompletos.' });

  try {
    const hash = await bcrypt.hash(senha, 10);
    const userRole = role || 'usuario';
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)',
      [nome, email, hash, userRole]
    );
    res.json({ success: true, userId: result.insertId, role: userRole });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'E-mail em uso.' });
    res.status(500).json({ error: 'Erro no cadastro: ' + (err.sqlMessage || err.message) });
  }
});

// Login com Validação de Hash
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas.' });

    const user = rows[0];
    const match = await bcrypt.compare(senha, user.senha_hash);
    if (!match) return res.status(401).json({ error: 'Credenciais inválidas.' });

    res.json({ success: true, userId: user.id, nome: user.nome, role: user.role || 'usuario' });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro no login: ' + (err.sqlMessage || err.message) });
  }
});

// Solicitação de Recuperação de Senha (Expira em 30 min)
app.post('/forgot-password', async (req, res) => {
  const { email, appUrl } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail não informado.' });

  try {
    const [rows] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(404).json({ error: 'E-mail não encontrado.' });

    const userId = rows[0].id;
    const token = crypto.randomBytes(32).toString('hex');
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + 30 * 60 * 1000); // +30 minutos

    await pool.query(
      'INSERT INTO reset_tokens (token, usuario_id, criado_em, expira_em, usado) VALUES (?, ?, ?, ?, 0)',
      [token, userId, agora, expiraEm]
    );

    const baseUrl = appUrl || process.env.APP_URL || 'http://localhost:8200';
    const resetLink = `${baseUrl}/reset-password.html?token=${token}`;

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn('AVISO: SMTP_USER e SMTP_PASS não configurados. Link gerado:', resetLink);
      return res.status(500).json({ 
        error: 'Serviço de e-mail não configurado no Portainer/ambiente. Configure SMTP_USER e SMTP_PASS.' 
      });
    }

    const transporter = getTransporter();
    await transporter.sendMail({
      from: '"Catálogo Tom Hanks" <no-reply@catalogo.com>',
      to: email,
      subject: 'Recuperação de Senha - Catálogo Tom Hanks',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
          <h2>Recuperação de Senha</h2>
          <p>Você solicitou a redefinição de senha da sua conta no <strong>Catálogo Tom Hanks</strong>.</p>
          <p>Clique no link abaixo para cadastrar uma nova senha (válido por 30 minutos):</p>
          <p style="margin: 20px 0;">
            <a href="${resetLink}" style="background-color: #007bff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; display: inline-block;">
              Redefinir Minha Senha
            </a>
          </p>
          <p>Se o botão acima não funcionar, copie e cole este link no seu navegador:</p>
          <p><a href="${resetLink}">${resetLink}</a></p>
          <hr style="margin-top: 30px; border: none; border-top: 1px solid #ccc;" />
          <p style="font-size: 12px; color: #777;">Se você não solicitou essa alteração, ignore este e-mail.</p>
        </div>
      `
    });

    res.json({ success: true, message: 'E-mail de recuperação enviado com sucesso!' });
  } catch (err) {
    console.error('Erro ao gerar recuperação de senha:', err);
    res.status(500).json({ error: 'Erro ao enviar e-mail de recuperação: ' + (err.message || err) });
  }
});

// Troca de Senha com Validação de Token
app.post('/reset-password', async (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha) return res.status(400).json({ error: 'Dados incompletos.' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM reset_tokens WHERE token = ? AND usado = 0',
      [token]
    );

    if (rows.length === 0) return res.status(400).json({ error: 'Token inválido ou já utilizado.' });

    const resetRecord = rows[0];
    const agora = new Date();

    if (agora > new Date(resetRecord.expira_em)) {
      return res.status(400).json({ error: 'Token expirado. Solicite um novo link.' });
    }

    const hash = await bcrypt.hash(novaSenha, 10);
    
    await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hash, resetRecord.usuario_id]);
    await pool.query('UPDATE reset_tokens SET usado = 1 WHERE id = ?', [resetRecord.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err);
    res.status(500).json({ error: 'Erro ao redefinir a senha: ' + (err.message || err) });
  }
});

// Consulta de Dados e Papéis do Usuário
app.get('/verify-user/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nome, email, role FROM usuarios WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro ao buscar usuário:', err);
    res.status(500).json({ error: 'Erro ao buscar dados.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Auth Service rodando na porta interna ${PORT}`));