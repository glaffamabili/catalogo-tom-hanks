# 🎬 Catálogo de Filmes — Tom Hanks
> **ISW055 · Atividade 4 · Autorização — Controle de Acesso por Papel (RBAC de Verdade)**  
> Professor: [@siriani](https://github.com/siriani) — [github.com/siriani](https://github.com/siriani)

---

## 🔐 1. Permissões Documentadas por Papel (RBAC)

O sistema implementa o modelo **RBAC (Role-Based Access Control)** onde as permissões são associadas a papéis (*roles*) e atribuídas aos usuários no cadastro e no banco de dados.

| Recurso / Ação | Endpoint / Método | Papel `usuario` | Papel `admin` | Descrição & Regra de Autorização |
| :--- | :--- | :---: | :---: | :--- |
| **Autenticação** | `POST /api/register`<br>`POST /api/login`<br>`POST /api/forgot-password`<br>`POST /api/reset-password` | ✅ Permitido | ✅ Permitido | Cadastro, login com hash bcrypt e recuperação de senha via e-mail. |
| **Consultar Filmes** | `GET /api/movies` | ✅ Permitido | ✅ Permitido | Listagem de todos os filmes de Tom Hanks via API TMDB. |
| **Favoritos** | `GET /api/favorites`<br>`POST /api/favorites` | ✅ Permitido | ✅ Permitido | Visualizar e adicionar filmes aos próprios favoritos. |
| **Comentar em Filmes** | `POST /api/comments`<br>`GET /api/comments` | ✅ Permitido | ✅ Permitido | Criar e visualizar comentários da comunidade sobre os filmes. |
| **Excluir o Próprio Comentário** | `DELETE /api/comments/:id` | ✅ Permitido | ✅ Permitido | O usuário pode excluir apenas comentários criados por ele mesmo (`usuario_id == session.userId`). |
| **Moderação de Comentários (Qualquer Autor)** | `DELETE /api/comments/:id` | ❌ **Negado (403 Forbidden)** | ✅ Permitido | **Ação Exclusiva:** Administrador pode moderar e excluir comentários de qualquer usuário. |
| **Listar Todos os Usuários** | `GET /api/users` | ❌ **Negado (403 Forbidden)** | ✅ Permitido | **Ação Exclusiva:** Apenas administradores podem visualizar a lista completa de usuários cadastrados. |
| **Promover / Rebaixar Papel de Usuário** | `PATCH /api/users/:id/role` | ❌ **Negado (403 Forbidden)** | ✅ Permitido | **Ação Exclusiva:** Apenas administradores podem alterar o papel de um usuário entre `usuario` e `admin`. |

---

## 🛡️ 2. Ações Exclusivas de Administrador e Enforcement no Backend

A validação de autorização é executada **estritamente no servidor (backend)**, garantindo segurança mesmo se a requisição for disparada diretamente via Postman, cURL ou console de desenvolvedor.

### Regra de Exclusão de Comentários (`DELETE /api/comments/:id`)
1. O backend busca o comentário no banco de dados MySQL.
2. Consulta o `auth-service` em tempo real para verificar o papel do usuário autenticado.
3. **Decisão do Servidor**:
   - Se for o autor do comentário (`comment.usuario_id === req.session.userId`): **Permitido (200 OK)**.
   - Se for Administrador (`user.role === 'admin'`): **Permitido (200 OK - Moderação)**.
   - Se for outro usuário comum (`user.role === 'usuario'` e não é o dono): **Recusado com HTTP `403 Forbidden`** e mensagem explicativa.

---

## 🧪 3. Demonstração Prática (Cenários de Teste)

### Cenário 1: Usuário Comum tentando ação exclusiva
- **Usuário:** `Maria Silva` (`role: usuario`).
- **Ação:** Tenta excluir o comentário de outro usuário (`ID #10`).
- **Resultado:** O servidor recusa com **Status HTTP `403 Forbidden`**:
  ```json
  {
    "error": "Acesso negado (403 Forbidden): Apenas o autor do comentário ou um administrador podem excluir este comentário."
  }
  ```

### Cenário 2: Administrador executando moderação
- **Usuário:** `Admin Central` (`role: admin`).
- **Ação:** Executa a exclusão do mesmo comentário (`ID #10`).
- **Resultado:** O servidor valida o papel e executa a exclusão com sucesso **Status HTTP `200 OK`**:
  ```json
  {
    "success": true,
    "message": "Comentário moderado e excluído com sucesso (Ação de Administrador)."
  }
  ```

---

## 📐 4. Arquitetura: Padrão A ou Padrão B?

### Qual padrão este projeto utiliza hoje?
> **O projeto utiliza o PADRÃO A — Enforcement Centralizado.**

### Como funciona hoje (Padrão A):
A cada requisição sensível que exige checagem de permissão (por exemplo, na rota `DELETE /api/comments/:id` ou no middleware `exigeAdmin`), o `catalog-service` realiza uma chamada HTTP interna de rede para o `auth-service` (`GET /verify-user/:id`) para consultar o papel mais recente do usuário no banco de dados.

- **Vantagem:** Efeito imediato. Se um usuário for promovido ou rebaixado no banco de dados, sua nova permissão passa a valer na mesma hora para todas as próximas requisições.
- **Desvantagem:** Custo adicional de latência de rede (ida-e-volta ao `auth-service`) a cada ação protegida.

### O que mudaria se fosse para o Padrão B (Claims no JWT)?
1. **Sem chamada de rede extra:** Ao fazer login, o `auth-service` emitiria um token assinado (JWT) contendo o campo `role` nos *claims* (payload).
2. **Decisão autônoma do serviço:** O `catalog-service` apenas verificaria a assinatura criptográfica do token localmente com uma chave pública/secreta e leria o papel do usuário diretamente do token, **sem precisar fazer chamadas de rede para o `auth-service`**.
3. **Trade-off:** Mais rápido e desacoplado, porém se o papel do usuário for alterado ou revogado no banco de dados, a mudança só surtirá efeito quando o token atual expirar e for renovado.

---

## 🚀 Como Executar o Projeto

```bash
# 1. Clonar o repositório
git clone https://github.com/glaffamabili/catalogo-tom-hanks.git
cd catalogo-tom-hanks

# 2. Subir a stack com Docker Compose
docker-compose up -d --build
```
Acesse no navegador: `http://localhost:8200` (ou na porta configurada no seu Portainer / VPS).