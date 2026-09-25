# 🎬 Catálogo de Filmes — Tom Hanks
> **ISW055 · Introdução à Computação em Nuvem**  
> Professor: [@siriani](https://github.com/siriani) — [github.com/siriani](https://github.com/siriani)  
> Aplicação em Produção: [https://amabili-flor-isw055.lapps.studio/](https://amabili-flor-isw055.lapps.studio/)

---

## 📑 Sumário das Implementações
1. [Documentação Swagger / OpenAPI 3.0](#-1-documentação-swagger--openapi-30)
2. [CI/CD com GitHub Actions](#-2-cicd-com-github-actions)
3. [Observabilidade: Health Checks e Métricas Prometheus](#-3-observabilidade-health-checks-e-métricas)
4. [Controle de Acesso por Papel (RBAC)](#-4-controle-de-acesso-por-papel-rbac)
5. [Como Executar Localmente](#-5-como-executar-localmente)

---

## 📄 1. Documentação Swagger / OpenAPI 3.0

Todos os endpoints dos serviços estão especificados e documentados sob o padrão **OpenAPI 3.0**, permitindo a visualização interativa e execução de chamadas reais com **"Try it out"** direto pelo navegador.

### Links das Interfaces Swagger UI:
- **Catálogo API (Catalog Service):** [`/apidocs`](https://amabili-flor-isw055.lapps.studio/apidocs) ou [`/docs`](https://amabili-flor-isw055.lapps.studio/docs)
- **Arquivo da Especificação:** [`catalog-service/openapi.json`](./catalog-service/openapi.json)
- **Auth Service API:** [`auth-service/openapi.json`](./auth-service/openapi.json) (acessível internamente em `/apidocs`)

### O que está documentado em cada endpoint:
- **Método HTTP e Rota** (ex: `POST /api/register`, `GET /api/movies`, `DELETE /api/comments/{id}`).
- **Parâmetros e Corpo da Requisição** com schemas JSON e validações.
- **Códigos de Resposta:** `200 OK`, `400 Bad Request`, `401 Unauthorized`, `403 Forbidden` (RBAC) e `500 Internal Server Error`.

---

## 🤖 2. CI/CD com GitHub Actions

O repositório possui um pipeline automatizado de Integração e Entrega Contínua em [`.github/workflows/ci-cd.yml`](./.github/workflows/ci-cd.yml), acionado a cada `push` ou `pull_request` na branch `main`.

### Etapas do Pipeline:
1. **CI (Continuous Integration):**
   - Faz checkout do código e configura Node.js 18.x com cache de dependências.
   - Executa a suíte de testes automatizados ([`auth-service/test.js`](./auth-service/test.js) e [`catalog-service/test.js`](./catalog-service/test.js)).
   - Valida a integridade do contrato OpenAPI 3.0, módulos e regras de autorização RBAC.
2. **CD (Continuous Delivery & Packaging):**
   - Configura o Docker Buildx.
   - Gera tags rastreáveis atreladas ao commit SHA (ex: `sha-abc1234`) além da tag `latest`.
   - Constrói as imagens Docker de `auth-service` e `catalog-service`.
   - Valida a integridade da stack no `docker compose build`.

### Gestão Segura de Segredos:
- Nenhuma credencial (senhas de banco de dados, API keys do TMDB, credenciais SMTP) fica gravada no código, YAMLs ou Dockerfiles.
- As variáveis são injetadas estritamente em tempo de execução através do ambiente do **Portainer** ou **GitHub Secrets**.

---

## 🩺 3. Observabilidade: Health Checks e Métricas

### Health Checks (`/health` com Liveness & Readiness de Verdade)
Ambos os microsserviços expõem o endpoint `/health` que realiza testes reais em suas dependências:
- **`auth-service`:** Testa conectividade ativa executando query no banco MariaDB/MySQL.
- **`catalog-service`:** Testa a conectividade com o banco MariaDB e a comunicação de rede interna com o `auth-service`.
- **Status de Resposta:**
  - `HTTP 200 OK`: Serviço saudável (`"status": "UP"`).
  - `HTTP 503 Service Unavailable`: Falha em dependência crítica (`"status": "DOWN"`).

### Monitoramento no Docker (`HEALTHCHECK`)
Os contêineres possuem `healthcheck` configurado no [`docker-compose.yml`](./docker-compose.yml), permitindo que o Docker e o Portainer reportem o status do contêiner como `(healthy)` automaticamente via `docker ps`:
```yaml
healthcheck:
  test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => { if (r.statusCode !== 200) process.exit(1); })"]
  interval: 15s
  timeout: 5s
  retries: 3
  start_period: 10s
```

### Métricas Prometheus (`/metrics`)
O endpoint `/metrics` expõe métricas em formato padrão consumível pelo **Prometheus**:
- `http_requests_total{method, path, status}`: Contagem total de requisições por rota e código de status.
- `http_request_duration_seconds`: Latência média das requisições.
- `process_uptime_seconds`: Tempo de atividade do processo.
- `process_resident_memory_bytes` / `process_heap_bytes`: Consumo de memória da aplicação.

---

## 🔐 4. Controle de Acesso por Papel (RBAC)

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

---

## 🚀 5. Como Executar Localmente

```bash
# 1. Clonar o repositório
git clone https://github.com/glaffamabili/catalogo-tom-hanks.git
cd catalogo-tom-hanks

# 2. Executar testes automatizados
cd auth-service && npm test && cd ../catalog-service && npm test && cd ..

# 3. Subir os serviços com Docker Compose
docker compose up -d --build
```
- Aplicação Web: `http://localhost:8200`
- Swagger UI: `http://localhost:8200/apidocs`
- Health Check: `http://localhost:8200/health`
- Métricas: `http://localhost:8200/metrics`