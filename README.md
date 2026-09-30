# 🎬 Catálogo de Filmes & Rede Social — Tom Hanks
> **ISW055 · Introdução à Computação em Nuvem**  
> Professor: [@siriani](https://github.com/siriani) — [github.com/siriani](https://github.com/siriani)  
> Aplicação em Produção: [https://amabili-flor-isw055.lapps.studio/](https://amabili-flor-isw055.lapps.studio/)

---

## 📑 Sumário das Atividades & Arquitetura

1. [Atividade 6 · Armazenamento de Objetos (MinIO) & Perfil de Usuário](#-1-atividade-6--armazenamento-de-objetos-minio--perfil-de-usuário)
2. [Atividade 5 · Logs e Auditoria com Redis Streams (`log-service`)](#-2-atividade-5--logs-e-auditoria-com-redis-streams)
3. [Atividade 4 · Controle de Acesso por Papel (RBAC de Verdade)](#-3-atividade-4--controle-de-acesso-por-papel-rbac)
4. [Documentação OpenAPI / Swagger UI](#-4-documentação-openapi--swagger-ui)
5. [CI/CD com GitHub Actions](#-5-cicd-com-github-actions)
6. [Observabilidade: Health Checks e Métricas Prometheus](#-6-observabilidade-health-checks-e-métricas)
7. [Como Executar Localmente](#-7-como-executar-localmente)

---

## 📦 1. Atividade 6 · Armazenamento de Objetos (MinIO) & Perfil de Usuário

Nesta atividade, o catálogo evolui para uma **rede social de cinéfilos**, permitindo que cada usuário tenha uma página de perfil completa com foto de avatar, biografia personalizada, estatísticas de uso e a lista dos seus filmes favoritos salvos.

### 🏛️ Arquitetura: Por que a imagem NÃO mora no Banco Relacional?

Salvar arquivos binários diretamente em colunas do tipo `BLOB` no MariaDB/MySQL é uma má prática de engenharia em sistemas modernos:
- **Sobrecarga e Inchaço do Banco:** Imagens de alguns megabytes inflam o arquivo de dados das tabelas, degradando o buffer pool e a memória cache do banco de dados.
- **Backups e Replicação Lentos:** Realizar `mysqldump` ou sincronizar réplicas contendo gigabytes de dados binários torna operações de rotina demoradas e arriscadas.
- **Desempenho de I/O:** Bancos relacionais são otimizados para consultas estruturadas de linhas pequenas, enquanto o **Object Storage (MinIO / S3 / GCS)** foi projetado especificamente para armazenamento e recuperação de alta taxa de transferência de arquivos binários não estruturados.

```
[ Usuário ] ──( 1. Envia Imagem multipart/form-data )──► [ Catalog Service ]
                                                              │          │
                     ┌────────────────────────────────────────┘          │
   ( 2. Grava binário no Bucket "perfil-fotos" )                         │ ( 3. Grava apenas a CHAVE
                     │                                                   │      da foto e a bio )
                     ▼                                                   ▼
          ┌─────────────────────┐                             ┌────────────────────┐
          │  MinIO Storage S3   │                             │  MariaDB / MySQL   │
          │ (Objeto: avatar_*)  │                             │ (foto_chave, bio)  │
          └─────────────────────┘                             └────────────────────┘
                     ▲                                                   ▲
                     │ ( 4. Lê Stream com Cache HTTP )                   │
                     └───────────────────────────────────────────────────┘
```

### 🎯 Decisão Arquitetural de Entrega da Imagem (Requisito 3)

Para a entrega das imagens de volta ao navegador, analisamos as abordagens possíveis:

1. **Bucket com Leitura Pública:** Exporia a porta 9000 do MinIO diretamente à internet aberta, exigindo expor múltiplos serviços ou configurar regras de subdomínio e TLS adicionais.
2. **URLs Pré-assinadas Temporárias:** Excelente para arquivos estritamente privados com expiração curta, porém gera URLs longas com tokens temporários que quebram o cache HTTP padrão dos navegadores em fotos de perfil e comentários.
3. **Decisão Adotada — Reverse Proxy com Streaming Seguro e Cache HTTP (`GET /api/profile/avatar/:key`):**
   - O MinIO permanece **completamente isolado** na rede interna do Docker (`networks: app-network`), sem portas públicas abertas ao host.
   - O Catálogo atua como proxy via streaming (`minioClient.getObject`), transmitindo o arquivo binário diretamente ao cliente com o header `Cache-Control: public, max-age=86400`.
   - **Vantagens:** Segurança total de rede, compatibilidade nativa com o domínio reverso em produção ([`*.lapps.studio`](https://amabili-flor-isw055.lapps.studio/)), sem risco de CORS ou mismatch de portas, e aceleração via cache no cliente.

### 🛡️ Enforcement de Segurança no Servidor (Requisito 4)

- **Edição Restrita ao Dono:** As rotas `PUT /api/profile` e `POST /api/profile/upload-photo` utilizam **exclusivamente** o `req.session.userId` recuperado da sessão segura validada no servidor. Qualquer tentativa de forjar identificadores no corpo da requisição é ignorada.
- **Validação de Uploads com Multer:** Validação rigorosa de MIME type (`image/jpeg`, `image/png`, `image/webp`, `image/gif`) e limite rígido de **5MB por imagem**. Arquivos inválidos ou executáveis são rejeitados com código `400 Bad Request`.

---

## 📋 2. Atividade 5 · Logs e Auditoria com Redis Streams

Toda ação relevante do sistema gera um evento rastreável no microsserviço dedicado `log-service`, persistido em **Redis Streams** (`audit_logs`) com ordenação temporal imutável (`XADD` e `XREVRANGE`).

### Eventos Auditados no Stream:
- `LOGIN_SUCESSO`: Identificador do usuário e papel.
- `CADASTRO_USUARIO`: Criação de conta e perfil RBAC atribuído.
- `UPLOAD_FOTO_PERFIL`: Chave do objeto no MinIO, bucket, tamanho em bytes e MIME type.
- `ATUALIZAR_PERFIL`: Alterações de nome e biografia.
- `ALTERACAO_PAPEL_RBAC`: Promoções e rebaixamentos de permissão realizados por administradores.
- `MODERACAO_COMENTARIO`: Remoções de comentários realizadas pela moderação.

A consulta de logs é restrita a administradores através de `GET /api/admin/logs`, protegida pelo middleware RBAC do servidor.

---

## 🔐 3. Atividade 4 · Controle de Acesso por Papel (RBAC)

O sistema implementa **RBAC (Role-Based Access Control)** com validação no backend:

| Recurso / Rota | Método | Papel `usuario` | Papel `admin` | Regra de Autorização |
| :--- | :---: | :---: | :---: | :--- |
| **Perfil Próprio** | `GET, PUT /api/profile` | ✅ | ✅ | Gerencia apenas o próprio perfil (`req.session.userId`). |
| **Upload de Foto** | `POST /api/profile/upload-photo` | ✅ | ✅ | Salva avatar no MinIO e atualiza `foto_chave`. |
| **Catálogo & Favoritos** | `GET /api/movies`<br>`GET, POST /api/favorites` | ✅ | ✅ | Consulta e favoritamento de filmes. |
| **Comunidade** | `GET, POST /api/comments` | ✅ | ✅ | Posta e lê comentários com foto de avatar. |
| **Excluir Próprio Comentário** | `DELETE /api/comments/:id` | ✅ | ✅ | Autor pode remover seu comentário. |
| **Moderação Comunitária** | `DELETE /api/comments/:id` | ❌ **403** | ✅ | **Admin:** Modera qualquer comentário. |
| **Gestão de Usuários** | `GET /api/users` | ❌ **403** | ✅ | **Admin:** Visualiza usuários cadastrados. |
| **Alteração de Papéis** | `PATCH /api/users/:id/role` | ❌ **403** | ✅ | **Admin:** Promove ou rebaixa usuários. |
| **Auditoria Redis** | `GET /api/admin/logs` | ❌ **403** | ✅ | **Admin:** Consulta trilha de auditoria. |

---

## 📄 4. Documentação OpenAPI / Swagger UI

Todos os microsserviços possuem especificações **OpenAPI 3.0** completas com interface interativa Swagger UI:
- **Swagger UI Catálogo:** [`/apidocs`](https://amabili-flor-isw055.lapps.studio/apidocs) ou [`/docs`](https://amabili-flor-isw055.lapps.studio/docs)
- **JSON da Spec:** [`catalog-service/openapi.json`](./catalog-service/openapi.json)

---

## 🤖 5. CI/CD com GitHub Actions

Pipeline automatizado em [`.github/workflows/ci-cd.yml`](./.github/workflows/ci-cd.yml) disparado a cada `push` na branch `main`:
1. **CI:** Executa suíte automatizada em todos os serviços (`auth-service/test.js`, `catalog-service/test.js`, `log-service/test.js`).
2. **CD:** Constrói as imagens Docker multi-stage com tags SHA e `latest`.

---

## 🩺 6. Observabilidade: Health Checks e Métricas

### Health Checks (`/health`)
Testa conectividade real com as dependências do sistema:
- MariaDB / MySQL (`SELECT 1`)
- Auth Service (HTTP Interno)
- Log Service & Redis Streams (`PING -> PONG`)
- Object Storage MinIO (`bucketExists('perfil-fotos')`)

### Métricas Prometheus (`/metrics`)
Métricas de telemetria no padrão OpenMetrics (requisições, latências, memória RSS/Heap, contagem de uploads e eventos de auditoria).

---

## 🚀 7. Como Executar Localmente

### Pré-requisitos
- Docker e Docker Compose instalados.
- Node.js 18+ (para execução dos testes).

```bash
# 1. Clonar o repositório
git clone https://github.com/glaffamabili/catalogo-tom-hanks.git
cd catalogo-tom-hanks

# 2. Executar suíte de testes de todos os microsserviços
cd auth-service && npm test && cd ../log-service && npm test && cd ../catalog-service && npm test && cd ..

# 3. Subir toda a infraestrutura com Docker Compose
docker compose up -d --build
```

### URLs Locais
- **Aplicação Web & Perfil:** `http://localhost:8200`
- **Swagger UI:** `http://localhost:8200/apidocs`
- **Dashboard Health:** `http://localhost:8200/health`
- **Telemetria / Métricas:** `http://localhost:8200/metrics`