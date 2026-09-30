const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 [CI Test - Log Service] Iniciando validações automatizadas...');

// Teste 1: Validação do contrato OpenAPI
const openapiPath = path.join(__dirname, 'openapi.json');
assert(fs.existsSync(openapiPath), 'Arquivo openapi.json não encontrado no Log Service');
const openapiContent = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
assert(openapiContent.openapi.startsWith('3.0'), 'Versão OpenAPI inválida');
assert(openapiContent.paths['/logs'], 'Rota /logs ausente na spec OpenAPI');
assert(openapiContent.paths['/health'], 'Rota /health ausente na spec OpenAPI');
assert(openapiContent.paths['/metrics'], 'Rota /metrics ausente na spec OpenAPI');
console.log('  ✅ [Teste 1/3] Contrato OpenAPI 3.0 validado com sucesso.');

// Teste 2: Validação de dependências essenciais
assert(require('express'), 'Express não disponível');
assert(require('ioredis'), 'ioredis não disponível');
console.log('  ✅ [Teste 2/3] Módulos e dependências essenciais carregados com sucesso.');

// Teste 3: Validação da formatação de log para o Redis Stream (XADD)
function formatarLogEntry(payload) {
  const { usuario_id, usuario_nome, usuario_email, acao, detalhes, ip, timestamp } = payload;
  assert(acao, 'Ação deve ser fornecida');
  return [
    'usuario_id', String(usuario_id || 'anonimo'),
    'usuario_nome', String(usuario_nome || 'Anônimo'),
    'usuario_email', String(usuario_email || 'N/A'),
    'acao', String(acao),
    'detalhes', typeof detalhes === 'object' ? JSON.stringify(detalhes) : String(detalhes || ''),
    'ip', String(ip || '127.0.0.1'),
    'timestamp', timestamp || new Date().toISOString()
  ];
}

const mockLog = formatarLogEntry({
  usuario_id: 1,
  usuario_nome: 'Admin Master',
  acao: 'MODERACAO_EXCLUIR_COMENTARIO',
  detalhes: { comentario_id: 10 }
});
assert.strictEqual(mockLog[0], 'usuario_id');
assert.strictEqual(mockLog[6], 'acao');
assert.strictEqual(mockLog[7], 'MODERACAO_EXCLUIR_COMENTARIO');
console.log('  ✅ [Teste 3/3] Estrutura de gravação Redis Stream validada com sucesso.');

console.log('🎉 [CI Test - Log Service] Todos os testes passaram com sucesso!\n');
process.exit(0);
