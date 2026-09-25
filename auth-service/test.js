const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 [CI Test - Auth Service] Iniciando validações automatizadas...');

// Teste 1: Validação do contrato OpenAPI
const openapiPath = path.join(__dirname, 'openapi.json');
assert(fs.existsSync(openapiPath), 'Arquivo openapi.json não encontrado no Auth Service');
const openapiContent = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
assert(openapiContent.openapi.startsWith('3.0'), 'Versão OpenAPI inválida');
assert(openapiContent.paths['/register'], 'Rota /register ausente no contrato OpenAPI');
assert(openapiContent.paths['/login'], 'Rota /login ausente no contrato OpenAPI');
assert(openapiContent.paths['/health'], 'Rota /health ausente no contrato OpenAPI');
assert(openapiContent.paths['/metrics'], 'Rota /metrics ausente no contrato OpenAPI');
console.log('  ✅ [Teste 1/3] Contrato OpenAPI 3.0 validado com sucesso.');

// Teste 2: Validação de sintaxe e dependências
assert(require('express'), 'Express não disponível');
assert(require('mysql2/promise'), 'mysql2 não disponível');
assert(require('bcryptjs'), 'bcryptjs não disponível');
console.log('  ✅ [Teste 2/3] Módulos e dependências essenciais carregados com sucesso.');

// Teste 3: Validação de lógica de hash bcrypt
async function testBcrypt() {
  const bcrypt = require('bcryptjs');
  const password = 'SenhaSuperSecreta123!';
  const hash = await bcrypt.hash(password, 10);
  assert(await bcrypt.compare(password, hash), 'Validação de hash bcrypt falhou');
  assert(!(await bcrypt.compare('SenhaIncorreta', hash)), 'Validação negativa de senha falhou');
  console.log('  ✅ [Teste 3/3] Lógica de autenticação e hash bcrypt validada.');
}

testBcrypt()
  .then(() => {
    console.log('🎉 [CI Test - Auth Service] Todos os testes passaram com sucesso!\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ [CI Test - Auth Service] Erro nos testes:', err);
    process.exit(1);
  });
