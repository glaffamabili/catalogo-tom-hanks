# 🎬 Catálogo de Filmes & Rede Social — Tom Hanks
> **ISW055 · Introdução à Computação em Nuvem**  
> Professor: [@siriani](https://github.com/siriani) — [github.com/siriani](https://github.com/siriani)  
> Aplicação em Produção: [https://amabili-flor-isw055.lapps.studio/](https://amabili-flor-isw055.lapps.studio/)

---

## 📑 Sumário das Implementações
1. [Perfil de Usuário Social & Object Storage MinIO (Atividade 6)](#-1-perfil-social--object-storage-minio-atividade-6)
2. [Segurança Avançada: 2FA, E-mails Reais e Privacidade de Dados](#-2-seguran%C3%A7a-avan%C3%A7ada-2fa-e-mails-reais-e-privacidade)
3. [Logs e Auditoria com Redis Streams (Atividade 5)](#-3-logs-e-auditoria-com-redis-streams-atividade-5)
4. [Controle de Acesso por Papel (RBAC de Verdade - Atividade 4)](#-4-controle-de-acesso-por-papel-rbac)
5. [Documentação Swagger / OpenAPI 3.0](#-5-documenta%C3%A7%C3%A3o-swagger--openapi-30)
6. [CI/CD com GitHub Actions](#-6-cicd-com-github-actions)
7. [Observabilidade: Health Checks e Métricas Prometheus](#-7-observabilidade-health-checks-e-m%C3%A9tricas)
8. [Como Executar Localmente](#-8-como-executar-localmente)

---

## 📸 1. Perfil Social & Object Storage MinIO (Atividade 6)

O catálogo foi transformado em uma **rede social de cinema**, onde cada usuário tem uma página de perfil rica com foto de perfil personalizada, biografia, estatísticas sociais (total de favoritos, comentários e data de cadastro) e vitrine de filmes favoritos.

### Arquitetura de Armazenamento de Arquivos:
- **Por que a foto não mora no banco de dados:** Guardar binários como BLOB no MariaDB infla o banco relacional, tornando backups e queries pesadas e lentas.
- **Solução Implementada:** O arquivo binário é armazenado diretamente no **MinIO Object Storage** (imagem `cgr.dev/chainguard/minio:latest`), e o MariaDB armazena apenas a referência da chave do objeto (`foto_chave`).
- **Validação de Upload:** O backend valida estritamente o tipo MIME (`image/jpeg`, `image/png`, `image/webp`, `image/gif`) e o tamanho máximo de **5MB**.
- **Entrega Segura das Imagens:** As fotos são servidas pelo endpoint de streaming reverso `/api/profile/avatar/:key` com cabeçalho `Cache-Control: public, max-age=86400`, isolando a porta do MinIO na rede interna Docker e oferecendo cache de 24h.

---

## 🛡️ 2. Segurança Avançada: 2FA, E-mails Reais e Privacidade

### 🔐 Verificação em Duas Etapas (2FA - Two-Factor Authentication):
- Ao realizar o login com e-mail e senha, o servidor gera um código numérico de 6 dígitos (OTP) de uso único com expiração de 10 minutos e o envia para o e-mail do usuário via Nodemailer/Mailtrap.
- A sessão só é autenticada e concedida após a validação correta do código de 2 etapas no endpoint `POST /api/verify-2fa`.

### 📩 Validação Obrigatória de E-mail Real (DNS MX Record):
- Ao criar a conta, o backend executa validação de formato e consulta em tempo real aos servidores de DNS com `dns.resolveMx(domain)` para assegurar que o domínio existe na internet e possui servidores de e-mail válidos (bloqueando endereços e domínios falsos).
- A conta inicia com `email_verificado = 0` e só é ativada quando o usuário digita o código de 6 dígitos enviado para sua caixa de entrada no endpoint `POST /api/verify-email`.

### 🔒 Privacidade e Proteção de Dados (LGPD & Security Best Practices):
- **Zero exposição de credenciais:** Senhas, hashes bcrypt e tokens de redefinição/2FA nunca são enviados em respostas de API nem expostos no código-fonte.
- **Ocultação de e-mails de terceiros:** Nos comentários e perfis públicos de outros membros da comunidade, apenas o nome e o avatar são exibidos. O e-mail privado nunca é divulgado para outros usuários.

---

## 🪵 3. Logs e Auditoria com Redis Streams (Atividade 5)

Todas as ações críticas e relevantes do sistema deixam um rastro cronológico imutável armazenado no **Redis Streams** via microsserviço dedicado `log-service`:
- **Comandos Utilizados:** `XADD` para inserção de alta performance e `XRANGE` para consulta e auditoria.
- **Eventos Auditados:** `LOGIN_SUCESSO`, `LOGIN_2FA_SOLICITADO`, `CADASTRO_SOLICITADO`, `EMAIL_VERIFICADO_SUCESSO`, `FAVORITAR_FILME`, `COMENTAR_FILME`, `EXCLUIR_COMENTARIO_PROPRIO`, `MODERACAO_EXCLUIR_COMENTARIO`, `ALTERACAO_PAPEL_RBAC`, `UPLOAD_FOTO_PERFIL`, `ACESSO_NEGADO_403`.
- **Painel de Auditoria:** Rota exclusiva para administradores em `GET /api/admin/logs`.

---

## 🔐 4. Controle de Acesso por Papel (RBAC)

Enforcement de autorização no servidor com validação centralizada em tempo real (Padrão A).

| Recurso / Ação | Endpoint / Método | Papel `usuario` | Papel `admin` | Regra de Autorização |
| :--- | :--- | :---: | :---: | :--- |
| **Autenticação & 2FA** | `/api/login`<br>`/api/verify-2fa`<br>`/api/register` | ✅ Permitido | ✅ Permitido | Acesso e cadastro com verificação em duas etapas. |
| **Perfil Social & Upload** | `GET /api/profile`<br>`POST /api/profile/upload-photo` | ✅ Permitido | ✅ Permitido | Upload de fotos no MinIO e edição de biografia. |
| **Catálogo & Favoritos** | `GET /api/movies`<br>`GET /api/favorites` | ✅ Permitido | ✅ Permitido | Listar e favoritar títulos de Tom Hanks. |
| **Comentários Próprios** | `POST /api/comments`<br>`DELETE /api/comments/:id` | ✅ Permitido | ✅ Permitido | Postar e excluir seus próprios comentários. |
| **Moderação de Comentários** | `DELETE /api/comments/:id` | ❌ **403 Forbidden** | ✅ Permitido | **Admin:** Excluir comentários de terceiros. |
| **Gerenciamento de Usuários** | `GET /api/users`<br>`PATCH /api/users/:id/role` | ❌ **403 Forbidden** | ✅ Permitido | **Admin:** Listar usuários e alterar papéis RBAC. |
| **Auditoria Redis Streams** | `GET /api/admin/logs` | ❌ **403 Forbidden** | ✅ Permitido | **Admin:** Consultar trilha de auditoria completa. |

---

## 📄 5. Documentação Swagger / OpenAPI 3.0

- **Swagger UI Interativo:** [`/apidocs`](https://amabili-flor-isw055.lapps.studio/apidocs) ou [`/docs`](https://amabili-flor-isw055.lapps.studio/docs)
- **Arquivo da Especificação:** [`catalog-service/openapi.json`](./catalog-service/openapi.json)

---

## 🤖 6. CI/CD com GitHub Actions

Pipeline automatizado em [`.github/workflows/ci-cd.yml`](./.github/workflows/ci-cd.yml):
1. **CI:** Execução de testes automatizados de unidade e contrato OpenAPI 3.0.
2. **CD:** Build de contêineres Docker multi-estágio e validação da integridade da stack.

---

## 🩺 7. Observabilidade: Health Checks e Métricas

- **Health Check Geral:** [`/health`](https://amabili-flor-isw055.lapps.studio/health) (Diagnóstico em tempo real de MariaDB, Auth Service, Log Service / Redis e MinIO Object Storage).
- **Métricas Prometheus:** [`/metrics`](https://amabili-flor-isw055.lapps.studio/metrics) (Exportador OpenMetrics para monitoramento de latência, tráfego por rota e consumo de memória heap/RSS).

---

## 🚀 8. Como Executar Localmente

```bash
# 1. Clonar o repositório
git clone https://github.com/glaffamabili/catalogo-tom-hanks.git
cd catalogo-tom-hanks

# 2. Executar suíte de testes
npm test --prefix catalog-service

# 3. Subir todos os serviços (Catálogo, Auth, MinIO, Log Service, Redis)
docker compose up -d --build
```
- Aplicação Web: `http://localhost:8200`
- Swagger UI: `http://localhost:8200/apidocs`
- Painel Health Check: `http://localhost:8200/health`
- Métricas Prometheus: `http://localhost:8200/metrics`