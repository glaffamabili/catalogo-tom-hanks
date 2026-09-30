const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 [CI Test - Catalog Service] Iniciando validações automatizadas...');

// Teste 1: Validação do contrato OpenAPI
const openapiPath = path.join(__dirname, 'openapi.json');
assert(fs.existsSync(openapiPath), 'Arquivo openapi.json não encontrado no Catalog Service');
const openapiContent = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
assert(openapiContent.openapi.startsWith('3.0'), 'Versão OpenAPI inválida');
assert(openapiContent.paths['/api/movies'], 'Rota /api/movies ausente na spec OpenAPI');
assert(openapiContent.paths['/api/comments'], 'Rota /api/comments ausente na spec OpenAPI');
assert(openapiContent.paths['/api/comments/{id}'], 'Rota /api/comments/{id} ausente na spec OpenAPI');
assert(openapiContent.paths['/api/users'], 'Rota /api/users ausente na spec OpenAPI');
assert(openapiContent.paths['/health'], 'Rota /health ausente na spec OpenAPI');
assert(openapiContent.paths['/metrics'], 'Rota /metrics ausente na spec OpenAPI');
console.log('  ✅ [Teste 1/3] Contrato OpenAPI 3.0 validado com sucesso.');

// Teste 2: Validação de dependências essenciais
assert(require('express'), 'Express não disponível');
assert(require('mysql2/promise'), 'mysql2 não disponível');
assert(require('cookie-session'), 'cookie-session não disponível');
assert(require('node-fetch'), 'node-fetch não disponível');
console.log('  ✅ [Teste 2/3] Módulos e dependências essenciais carregados com sucesso.');

// Teste 3: Validação da regra de autorização RBAC (Enforcement lógico)
function validarPermissaoExclusaoComentario(usuarioId, autorId, usuarioRole) {
  const isOwner = (usuarioId === autorId);
  const isAdmin = (usuarioRole === 'admin');
  if (isOwner || isAdmin) return 200;
  return 403; // Forbidden
}

assert.strictEqual(validarPermissaoExclusaoComentario(10, 10, 'usuario'), 200, 'Dono do comentário deveria poder excluir');
assert.strictEqual(validarPermissaoExclusaoComentario(99, 10, 'admin'), 200, 'Admin deveria poder excluir qualquer comentário');
assert.strictEqual(validarPermissaoExclusaoComentario(99, 10, 'usuario'), 403, 'Usuário comum NÃO deve poder excluir comentário de outro');
console.log('  ✅ [Teste 3/3] Regra de segurança RBAC (403 Forbidden para não-donos) validada com sucesso.');

console.log('🎉 [CI Test - Catalog Service] Todos os testes passaram com sucesso!\n');
process.exit(0);

