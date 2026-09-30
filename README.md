# 🎬 Catálogo de Filmes — Tom Hanks
> **ISW055 · Introdução à Computação em Nuvem**  
> Professor: [@siriani](https://github.com/siriani) — [github.com/siriani](https://github.com/siriani)  
> Aplicação em Produção: [https://amabili-flor-isw055.lapps.studio/](https://amabili-flor-isw055.lapps.studio/)

---

## 📑 Sumário das Implementações
1. [Atividade 5: Logs e Auditoria com Redis Streams](#-1-atividade-5-logs-e-auditoria-com-redis-streams)
2. [Atividade 4: Controle de Acesso por Papel (RBAC)](#-2-controle-de-acesso-por-papel-rbac)
3. [Documentação Swagger / OpenAPI 3.0](#-3-documentação-swagger--openapi-30)
4. [CI/CD com GitHub Actions](#-4-cicd-com-github-actions)
5. [Observabilidade: Health Checks e Métricas Prometheus](#-5-observabilidade-health-checks-e-métricas)
6. [Como Executar a Stack](#-6-como-executar-a-stack)

---

## 📋 1. Atividade 5: Logs e Auditoria com Redis Streams

Para garantir rastreabilidade completa das ações no sistema ("quem fez o quê, e quando"), foi construído um microsserviço dedicado de logs ([`log-service`](./log-service/)) desacoplado do banco relacional, utilizando **Redis Streams** como mecanismo de alta performance para armazenamento ordenado no tempo.

```
┌─────────────────┐       ┌─────────────────┐
│ Catalog Service │       │  Auth Service   │
└────────┬────────┘       └────────┬────────┘
         │ (POST /logs)            │ (POST /logs)
         └────────────┬────────────┘
                      ▼
             ┌─────────────────┐
             │   Log Service   │
             └────────┬────────┘
                      │ XADD audit_logs *
                      ▼
             ┌─────────────────┐
             │  Redis Stream   │ (audit_logs)
             └─────────────────┘
```

### 1.1 Por que Redis Streams?
- **Alto volume e baixa latência**: Logs de auditoria têm alta taxa de escrita e leitura esporádica.
- **Estrutura nativa de log**: O comando `XADD audit_logs * ...` gera IDs ordenados cronologicamente por milissegundo (`timestamp-sequence`), garantindo ordenação perfeita.
- **Consultas eficientes**: O comando `XREVRANGE audit_logs + - COUNT N` permite que a administração consulte os últimos eventos instantaneamente sem sobrecarregar o banco de dados da aplicação.

### 1.2 Eventos Capturados na Auditoria:
| Evento (`acao`) | Origem | Descrição & Detalhes |
| :--- | :--- | :--- |
| `CADASTRO_USUARIO` | `auth-service` | Registro de nova conta com o papel inicial atribuído. |
| `LOGIN_SUCESSO` | `auth-service` | Login autenticado com sucesso via hash bcrypt. |
| `LOGIN_FALHA` | `auth-service` | Tentativa de login incorreta (senha errada ou e-mail inexistente). |
| `SOLICITACAO_RECUPERACAO_SENHA` | `auth-service` | Disparo de e-mail com token de reset de senha. |
| `REDEFINICAO_SENHA` | `auth-service` | Conclusão da alteração de senha via token válido. |
| `ALTERACAO_PAPEL` | `auth-service` | Promoção ou rebaixamento de papel de usuário por um admin. |
| `LOGOUT` | `catalog-service` | Encerramento voluntário de sessão pelo usuário. |
| `FAVORITAR_FILME` | `catalog-service` | Filme adicionado à lista de favoritos (`tmdb_movie_id`, `titulo`). |
| `COMENTAR_FILME` | `catalog-service` | Publicação de comentário comunitário em um filme. |
| `EXCLUIR_COMENTARIO_PROPRIO` | `catalog-service` | Remoção de comentário feita pelo próprio autor. |
| `MODERACAO_EXCLUIR_COMENTARIO`| `catalog-service` | **Ação de Moderação:** Administrador exclui comentário de outro usuário. |
| `ACESSO_NEGADO_403` | `catalog-service` | **Auditoria de Segurança:** Tentativa de ação não autorizada (ex: usuário comum tentando excluir comentário de outro ou acessar rotas de admin). |

### 1.3 Estrutura de Cada Log (Schema):
```json
{
  "id": "1727710200000-0",
  "usuario_id": 42,
  "usuario_nome": "Maria Silva",
  "usuario_email": "maria@teste.com",
  "acao": "ACESSO_NEGADO_403",
  "detalhes": {
    "motivo": "Tentativa de exclusão de comentário pertencente a outro usuário",
    "comentario_id": 10,
    "autor_comentario_id": 2
  },
  "ip": "187.12.34.56",
  "timestamp": "2026-09-30T15:30:00.000Z"
}
```

### 1.4 Endpoint de Consulta e Visualização (Exclusivo Admin):
- **Endpoint Backend:** `GET /api/logs?limit=100` (Protegido por `exigeAdmin`, retorna `403 Forbidden` para usuários comuns).
- **Interface Web:** Aba dedicada **"📋 Auditoria de Logs"** no catálogo com filtros rápidos por categoria (Logins, Favoritos, Comentários, Moderações e Alertas 403).

---

## 🔐 2. Controle de Acesso por Papel (RBAC)

O sistema implementa o modelo **RBAC (Role-Based Access Control)** com enforcement centralizado no backend (Padrão A).

| Recurso / Ação | Endpoint / Método | Papel `usuario` | Papel `admin` | Regra de Autorização |
| :--- | :--- | :---: | :---: | :--- |
| **Autenticação** | `/api/register`<br>`/api/login`<br>`/api/forgot-password` | ✅ Permitido | ✅ Permitido | Login, cadastro e recuperação de senha. |
| **Catálogo de Filmes** | `GET /api/movies` | ✅ Permitido | ✅ Permitido | Listagem de filmes via TMDB API. |
| **Favoritos** | `GET /api/favorites`<br>`POST /api/favorites` | ✅ Permitido | ✅ Permitido | Gerenciar filmes favoritos próprios. |
| **Comentar em Filmes** | `POST /api/comments`<br>`GET /api/comments` | ✅ Permitido | ✅ Permitido | Postar e visualizar comentários da comunidade. |
| **Excluir Próprio Comentário** | `DELETE /api/comments/:id` | ✅ Permitido | ✅ Permitido | O usuário pode excluir apenas seu próprio comentário. |
| **Moderação de Comentários** | `DELETE /api/comments/:id` | ❌ **403 Forbidden** | ✅ Permitido | **Ação Exclusiva:** Administrador pode moderar/excluir qualquer comentário. |
| **Listar Todos os Usuários** | `GET /api/users` | ❌ **403 Forbidden** | ✅ Permitido | **Ação Exclusiva:** Painel restrito a administradores. |
| **Alterar Papel de Usuário** | `PATCH /api/users/:id/role` | ❌ **403 Forbidden** | ✅ Permitido | **Ação Exclusiva:** Promover/rebaixar papéis no sistema. |
| **Consultar Logs de Auditoria** | `GET /api/logs` | ❌ **403 Forbidden** | ✅ Permitido | **Ação Exclusiva:** Acesso restrito ao histórico de auditoria no Redis. |

---

## 📄 3. Documentação Swagger / OpenAPI 3.0

Todos os endpoints dos serviços estão documentados sob o padrão **OpenAPI 3.0** com interface interativa Swagger UI:
- **Catálogo API:** [`/apidocs`](https://amabili-flor-isw055.lapps.studio/apidocs) ou [`/docs`](https://amabili-flor-isw055.lapps.studio/docs)
- **Especificações OpenAPI:**
  - [`catalog-service/openapi.json`](./catalog-service/openapi.json)
  - [`auth-service/openapi.json`](./auth-service/openapi.json)
  - [`log-service/openapi.json`](./log-service/openapi.json)

---

## 🤖 4. CI/CD com GitHub Actions

O repositório possui pipeline de Integração e Entrega Contínua em [`.github/workflows/ci-cd.yml`](./.github/workflows/ci-cd.yml):
- **CI:** Executa testes automatizados ([`auth-service/test.js`](./auth-service/test.js), [`catalog-service/test.js`](./catalog-service/test.js) e [`log-service/test.js`](./log-service/test.js)).
- **CD:** Constrói imagens Docker com tags rastreáveis atreladas ao commit SHA (ex: `sha-abc1234`) e valida a stack com `docker compose build`.

---

## 🩺 5. Observabilidade: Health Checks e Métricas

- **Health Checks (`/health` com Liveness & Readiness):**
  - `catalog-service`: Testa conectividade com MariaDB, `auth-service` e `log-service`.
  - `auth-service`: Testa conectividade com MariaDB.
  - `log-service`: Testa conectividade com o Redis.
  - Suporta Dashboard visual no navegador e JSON para Docker.
- **Docker `HEALTHCHECK`:** Configurado no [`docker-compose.yml`](./docker-compose.yml) para todos os serviços.
- **Métricas Prometheus (`/metrics`):** Exposição em formato padrão OpenMetrics com dashboard interativo.

---

## 🚀 6. Como Executar a Stack

```bash
# 1. Clonar o repositório
git clone https://github.com/glaffamabili/catalogo-tom-hanks.git
cd catalogo-tom-hanks

# 2. Executar testes automatizados em todos os microsserviços
npm test --prefix log-service && npm test --prefix auth-service && npm test --prefix catalog-service

# 3. Subir todos os serviços com Docker Compose
docker compose up -d --build
```

### Portas e Endpoints:
- **Aplicação Principal:** `http://localhost:8200`
- **Swagger UI:** `http://localhost:8200/apidocs`
- **Painel de Health Check:** `http://localhost:8200/health`
- **Painel de Métricas Prometheus:** `http://localhost:8200/metrics`