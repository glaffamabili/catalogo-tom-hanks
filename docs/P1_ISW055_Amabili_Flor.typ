// ============================================================
//  P1 — Relatório bimestral de atividades (entrega INDIVIDUAL)
//  ISW055 · Introdução à Computação em Nuvem · Fatec Pompeia · 2026.2
// ============================================================

// ---------- DADOS DO ALUNO ----------
#let aluno = "Amabili Flor"
#let turma = "161_SIST. INTELIGENTES_N"
#let data-relatorio = "07/10/2026"

// ---------- CONFIGURAÇÃO DA DISCIPLINA ----------
#let disciplina = "Introdução à Computação em Nuvem"
#let codigo = "ISW055"
#let professor = "Prof. Allan Lincoln Rodrigues Siriani"
#let accent = rgb("#b96f1f")

#set document(title: "P1 — " + codigo + " — " + aluno, author: aluno)
#set page(paper: "a4", margin: (top: 2.5cm, bottom: 2.5cm, left: 2.5cm, right: 2cm))
#set text(size: 11pt, lang: "pt", region: "BR")
#set par(justify: true, leading: 0.7em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => { v(0.6em); text(size: 16pt, it); v(0.2em) }
#show heading.where(level: 2): it => { v(0.5em); text(size: 13pt, it); v(0.1em) }
#show link: set text(fill: accent)
#show figure.caption: set text(size: 9pt, fill: luma(90))
#set table(stroke: 0.5pt + luma(200), inset: 6pt)
#show table: set text(hyphenate: false)
#show table: set par(justify: false)

// ---------- REGISTRO DE ATIVIDADES ----------
#let registro = state("registro", ())

#let evidencia(legenda, arquivo: none) = figure(
  if arquivo == none {
    rect(width: 100%, height: 4.5cm, radius: 4pt, stroke: (paint: luma(170), dash: "dashed"))[
      #align(center + horizon)[
        #text(fill: luma(110), size: 9.5pt)[
          #strong[Evidência Visual] \
          Repositório: #link("https://github.com/glaffamabili/catalogo-tom-hanks")
        ]
      ]
    ]
  } else {
    image(arquivo, width: 100%)
  },
  kind: image,
  supplement: [Figura],
  caption: legenda,
)

#let atividade(
  numero, titulo,
  descricao: "",
  planejada: "",
  realizada: "—",
  situacao: "entregue",
  evidencia-desc: "",
  url: "",
  corpo,
) = {
  registro.update(l => l + ((
    numero: numero, titulo: titulo, descricao: descricao,
    planejada: planejada, realizada: realizada, situacao: situacao,
  ),))
  heading(level: 2, [Atividade #numero — #titulo])
  table(
    columns: (3.4cm, 1fr),
    fill: (x, y) => if x == 0 { luma(245) } else { none },
    [*Descrição*], [#descricao],
    [*Data planejada*], [#planejada],
    [*Data realizada*], [#realizada],
    [*Situação*], [#situacao],
    [*Evidência*], [#evidencia-desc],
    [*Link direto*], [#if url == "" [—] else [#link(url)]],
  )
  corpo
}

// ============================================================
//  CAPA
// ============================================================

#align(center)[
  #v(2.5cm)
  #text(size: 12pt, tracking: 0.12em)[FATEC POMPEIA — SHUNJI NISHIMURA]
  #v(0.4em)
  #text(size: 10.5pt, fill: luma(110))[#disciplina · #codigo · #turma]
  #v(4.5cm)
  #text(size: 28pt, weight: "bold")[P1]
  #v(0.3em)
  #text(size: 18pt, weight: "bold")[Relatório Bimestral de Atividades]
  #v(0.8em)
  #text(size: 11pt, fill: luma(110))[Avaliação Individual · 2026.2]
  #v(5cm)
  #text(size: 14pt, weight: "bold")[#aluno]
  #v(1fr)
  #text(size: 10.5pt)[#professor \ Pompeia, #data-relatorio]
]

#set page(
  numbering: "1",
  number-align: right,
  header: context {
    set text(size: 8pt, fill: luma(120))
    [#codigo · P1 — Relatório bimestral #h(1fr) #aluno]
    line(length: 100%, stroke: 0.4pt + luma(200))
  },
)

#pagebreak()

// ============================================================
= Introdução
// ============================================================

A disciplina de *Introdução à Computação em Nuvem (ISW055)*, ministrada na Fatec Pompeia pelo Prof. Allan Siriani, tem como objetivo capacitar os estudantes nos fundamentos práticos e arquiteturais de sistemas distribuídos modernos, migração de monólitos para microsserviços conteinerizados, persistência poliglota, controle de acesso e observabilidade em nuvem.

O projeto prático estruturante do primeiro bimestre consistiu no desenvolvimento evolutivo do *Catálogo de Filmes de Tom Hanks*, transformado ao longo das semanas em uma completa rede social de cinema. A aplicação partiu de um consumo básico de API externa até uma robusta arquitetura de microsserviços isolados com Docker Compose, contendo autenticação desacoplada, controle de acesso baseado em papel (RBAC), logs de auditoria em Redis Streams, armazenamento de objetos binários com MinIO S3, autenticação em duas etapas (2FA via e-mail OTP) e validação de e-mails reais com consulta DNS MX.

Este relatório reúne a prestação de contas integral de todas as atividades realizadas no bimestre, apresentando o quadro comparativo de datas planejadas versus realizadas, as decisões de engenharia adotadas, os links auditáveis no GitHub e a comprovação funcional dos serviços em produção no ambiente de nuvem da instituição.

// ============================================================
= Metodologia
// ============================================================

Todas as atividades foram desenvolvidas em um único repositório público no GitHub (#link("https://github.com/glaffamabili/catalogo-tom-hanks")), utilizando *Node.js (Express)* para a construção dos serviços de backend e frontend, *Docker & Docker Compose* para a orquestração e isolamento de redes, *MariaDB/MySQL* hospedado no Google Cloud Platform (GCP) para dados estruturados, *Redis Streams* para mensageria de auditoria e *MinIO* para o armazenamento de objetos binários (fotos de perfil).

A coleta de evidências e aferição cronológica foi realizada a partir do histórico formal de commits do Git (`git log`), com datas e horas registradas no servidor do GitHub no fuso horário oficial de Brasília (BRT). A verificação funcional foi conduzida no ambiente de produção na nuvem (#link("https://amabili-flor-isw055.lapps.studio/")), além de testes automatizados com Node.js assert e validação de contratos OpenAPI 3.0 no pipeline de CI/CD do GitHub Actions.

// ============================================================
= Quadro de entregas
// ============================================================

A tabela a seguir sintetiza as atividades desenvolvidas ao longo do bimestre, comparando os prazos planejados originalmente com as datas e horários exatos de realização e commit.

#context {
  let l = registro.final()
  table(
    columns: (auto, 1.4fr, 2fr, 2.6cm, 2.9cm, 2.3cm),
    align: (center, left, left, center, center, center),
    fill: (x, y) => if y == 0 { luma(235) } else { none },
    table.header([*Nº*], [*Atividade*], [*Descrição*], [*Data \ planejada*], [*Data \ realizada*], [*Situação*]),
    ..l.map(a => (
      [#a.numero], [#a.titulo], [#text(size: 9pt)[#a.descricao]],
      [#a.planejada], [#a.realizada], [#a.situacao],
    )).flatten()
  )
}

// ============================================================
= Atividades realizadas
// ============================================================

#atividade(
  "1", "Agenda telefônica em Flask",
  descricao: "Nivelamento em sala: sistema monolítico Flask + Jinja com persistência em JSON.",
  planejada: "07/08/2026",
  realizada: "07/08/2026 11:30",
  situacao: "entregue",
  evidencia-desc: "Realizada em sala de aula — Nivelamento prático presencial na Fatec Pompeia",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks",
)[
  *O que foi feito.* Desenvolvimento de uma aplicação web monolítica em Python utilizando o framework Flask e o mecanismo de templates Jinja2. O sistema implementou operações de cadastro, edição e listagem de contatos telefônicos com persistência em arquivo JSON, servindo para nivelamento dos conceitos de requisições HTTP (GET/POST), rotas e renderização server-side.

  #evidencia([Atividade 1 — Evidência de execução em sala de aula (Terminal e comandos)], arquivo: "prints/atividade-1-entrega.svg")
  #evidencia([Atividade 1 — Resultado do sistema (Agenda telefônica em Flask e Jinja2)], arquivo: "prints/atividade-1-resultado.svg")

  *Dificuldades e resolução.* A principal dificuldade inicial foi a manipulação concorrente em arquivos locais de texto para persistência de dados, solucionada com rotinas estruturadas de serialização e desserialização de JSON.
]

#atividade(
  "2", "Catálogo de filmes — Tom Hanks",
  descricao: "Consumo da API TMDB, persistência em MariaDB e segregação por usuário.",
  planejada: "20/08/2026",
  realizada: "20/08/2026 15:49",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit b61415d + README + catálogo integrado ao TMDB",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/b61415d",
)[
  *O que foi feito.* Construção da primeira versão do catálogo cinematográfico em Node.js e Express, integrando-se à API RESTful do The Movie Database (TMDB) para carregar dinamicamente a filmografia completa do ator Tom Hanks. Foi implementado o banco relacional MariaDB para persistência de favoritos segregados por usuário e listagem em grade responsiva com pôsteres e avaliações.

  #evidencia([Atividade 2 — Evidência do commit b61415d no GitHub com data/hora e repositório], arquivo: "prints/atividade-2-entrega.svg")
  #evidencia([Atividade 2 — Resultado do sistema (Catálogo de filmes e favoritos no MariaDB)], arquivo: "prints/atividade-2-resultado.svg")

  *Dificuldades e resolução.* A proteção da chave privada de API do TMDB foi o ponto crítico, resolvida pela segregação da chave em variáveis de ambiente (`.env` e Docker Compose), evitando vazamento de credenciais no código-fonte.
]

#atividade(
  "3", "Desacoplando o login — microsserviço de autenticação",
  descricao: "Login, cadastro e esqueci-minha-senha num serviço à parte na rede interna do Docker.",
  planejada: "28/08/2026",
  realizada: "27/08/2026 14:44",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit d46eed2 + docker-compose.yml + microsserviço auth-service desacoplado",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/d46eed2",
)[
  *O que foi feito.* Desacoplamento da arquitetura monolítica com a criação do microsserviço independente `auth-service`. A autenticação passou a utilizar criptografia forte com hash bcrypt (`salt=10`), fluxo seguro de recuperação de senha com tokens de expiração de 30 minutos e envio automático de e-mails transacionais com Nodemailer e Mailtrap, interligados na rede interna bridge do Docker.

  #evidencia([Atividade 3 — Evidência do commit d46eed2 no GitHub com microsserviço de autenticação], arquivo: "prints/atividade-3-entrega.svg")
  #evidencia([Atividade 3 — Resultado do sistema (Auth Service desacoplado, login e recuperação de senha)], arquivo: "prints/atividade-3-resultado.svg")

  *Dificuldades e resolução.* Configuração da comunicação interna HTTP entre os contêineres e garantia de integridade da sessão do usuário sem expor as rotas internas de autenticação para a internet pública.
]

#atividade(
  "4", "Controle de acesso por papel — RBAC",
  descricao: "O campo role passa a decidir permissões reais no backend (403 para usuário comum).",
  planejada: "04/09/2026",
  realizada: "28/08/2026 21:23",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit 21f3b2b + enforcement 403 Forbidden no servidor + painel admin",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/21f3b2b",
)[
  *O que foi feito.* Implementação do modelo de controle de acesso baseado em papel (RBAC) com validação estrita no servidor (Padrão A Centralizado). O sistema estabeleceu os papéis `usuario` e `admin`, restringindo a moderação de comentários de terceiros, a consulta à lista de usuários e a alteração de privilégios com o retorno estrito de `HTTP 403 Forbidden` no backend para usuários não autorizados.

  #evidencia([Atividade 4 — Evidência do commit 21f3b2b no GitHub com regras RBAC], arquivo: "prints/atividade-4-entrega.svg")
  #evidencia([Atividade 4 — Resultado do sistema (Enforcement 403 Forbidden e Painel Administrativo)], arquivo: "prints/atividade-4-resultado.svg")

  *Dificuldades e resolução.* Eliminar qualquer dependência de validações client-side no frontend, garantindo que o backend fizesse a checagem em tempo real junto ao `auth-service` para cada ação protegida.
]

#atividade(
  "5", "Logs e auditoria",
  descricao: "Novo log-service com Redis registrando login, ações sensíveis e tentativas negadas.",
  planejada: "25/09/2026",
  realizada: "30/09/2026 12:30",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit bc388a8 + Redis Streams (XADD/XRANGE) + microsserviço log-service",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/bc388a8",
)[
  *O que foi feito.* Criação de um microsserviço dedicado de observabilidade e auditoria (`log-service`) integrado ao Redis. Utilizando a estrutura de dados de alta performance *Redis Streams* com o comando `XADD`, o sistema passou a registrar de forma imutável todos os eventos críticos (login, 2FA, cadastro, postagem/exclusão de comentários, moderação, uploads e tentativas de acesso negadas 403), disponibilizando a consulta via comando `XRANGE` exclusivamente para administradores.

  #evidencia([Atividade 5 — Evidência do commit bc388a8 no GitHub com log-service e Redis Streams], arquivo: "prints/atividade-5-entrega.svg")
  #evidencia([Atividade 5 — Resultado do sistema (Trilha de auditoria em Redis Streams com XADD/XRANGE)], arquivo: "prints/atividade-5-resultado.svg")

  *Dificuldades e resolução.* Definir a serialização correta de payloads complexos no formato chave-valor do Redis Streams sem sobrecarregar o tempo de resposta das rotas principais da aplicação.
]

#atividade(
  "6", "Upload e perfil de usuário",
  descricao: "Página de perfil com avatar no MinIO; só a referência fica no banco relacional.",
  planejada: "02/10/2026",
  realizada: "30/09/2026 13:31",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit 98b334a + MinIO S3 Object Storage + perfil social e 2FA",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/98b334a",
)[
  *O que foi feito.* Transformação do catálogo em uma rede social cinematográfica completa. Implementação de upload de imagens de avatar direcionadas ao *MinIO Object Storage* (`cgr.dev/chainguard/minio:latest`), gravando apenas a chave de referência no MariaDB e servindo as imagens por streaming reverso com cache HTTP (`Cache-Control: 86400`). A página de perfil passou a exibir nome, e-mail real do usuário, biografia editável, estatísticas de engajamento e vitrine de favoritos. Adicionalmente, implementou-se autenticação em duas etapas (2FA via e-mail OTP) e validação de e-mails reais com checagem DNS MX.

  #evidencia([Atividade 6 — Evidência do commit 98b334a no GitHub com MinIO Object Storage e 2FA], arquivo: "prints/atividade-6-entrega.svg")
  #evidencia([Atividade 6 — Resultado do sistema (Rede social com foto no MinIO, bio, e-mail e estatísticas)], arquivo: "prints/atividade-6-resultado.svg")

  *Dificuldades e resolução.* Substituição da imagem MinIO do Docker Hub por uma imagem pública aberta e segura da Chainguard para contornar restrições de pull no Portainer, além de implementar entrega reversa das fotos mantendo o MinIO isolado na rede interna Docker.
]

// ============================================================
= Atividades extras
// ============================================================

#atividade(
  "E1", "Documentação Swagger / OpenAPI 3.0",
  descricao: "Swagger UI com serviços documentados e execução interativa com 'Try it out'.",
  planejada: "sem prazo",
  realizada: "25/09/2026 12:13",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit 7b427a8 + rota /apidocs com Swagger UI interativo",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/7b427a8",
)[
  *O que foi feito.* Especificação completa da API sob o padrão OpenAPI 3.0 em `openapi.json`, disponibilizando a interface interativa Swagger UI acessível publicamente em `/apidocs` com documentação detalhada de rotas, parâmetros, schemas JSON de requisição e códigos de retorno HTTP.

  #evidencia([Atividade E1 — Interface Swagger UI interativa documentando todos os endpoints RESTful], arquivo: "prints/atividade-e1-resultado.svg")
]

#atividade(
  "E2", "CI/CD com GitHub Actions",
  descricao: "Pipeline automatizado de integração contínua e validação de builds a cada push.",
  planejada: "sem prazo",
  realizada: "25/09/2026 12:13",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit 7b427a8 + workflow automatizado em .github/workflows/ci-cd.yml",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/7b427a8",
)[
  *O que foi feito.* Configuração de pipeline automatizado em `.github/workflows/ci-cd.yml` acionado a cada push ou pull request na branch `main`. O pipeline executa a suíte de testes de validação lógica e de contrato OpenAPI, além de construir e validar as imagens Docker dos microsserviços.

  #evidencia([Atividade E2 — Pipeline de CI/CD automatizado no GitHub Actions com testes e build], arquivo: "prints/atividade-e2-resultado.svg")
]

#atividade(
  "E3", "Observabilidade — Health checks e métricas",
  descricao: "Endpoints de saúde e métricas com monitoramento ativo de dependências e padrão Prometheus.",
  planejada: "sem prazo",
  realizada: "25/09/2026 12:30",
  situacao: "entregue",
  evidencia-desc: "GitHub — Commit 58df72e + endpoints /health e /metrics com dashboard visual",
  url: "https://github.com/glaffamabili/catalogo-tom-hanks/commit/58df72e",
)[
  *O que foi feito.* Implementação de monitoramento de saúde profundo em `/health` com testes ativos no MariaDB, Auth Service, Redis Streams e MinIO Storage, e exportador de métricas em `/metrics` no padrão OpenMetrics (Prometheus) com dashboard visual moderno para acompanhamento de latência, uptime e tráfego.

  #evidencia([Atividade E3 — Dashboard visual de saúde e métricas Prometheus em tempo real], arquivo: "prints/atividade-e3-resultado.svg")
]

// ============================================================
= Considerações finais
// ============================================================

O percurso prático desenvolvido durante este primeiro bimestre proporcionou uma compreensão aprofundada dos desafios reais de arquitetura de software para computação em nuvem. A transição progressiva de uma aplicação monolítica simples para um ecossistema desacoplado de microsserviços evidenciou a importância de isolamento de responsabilidades, segurança defensiva no backend e persistência especializada para cada tipo de dado.

Entre os maiores aprendizados, destaca-se a implementação do RBAC centralizado com enforcement estrito no servidor, a utilização de Redis Streams para auditoria assíncrona sem degradação de performance e a integração com MinIO para armazenamento de arquivos binários, poupando o banco relacional. Para os próximos bimestres, o objetivo é aprofundar em escalabilidade horizontal, balanceamento de carga e práticas avançadas de observabilidade em nuvem.

// ============================================================
= Declaração de autoria
// ============================================================

Declaro que este relatório foi elaborado por mim, individualmente, e que as evidências apresentadas correspondem a entregas de minha autoria, verificáveis nos links e commits informados. Nas atividades realizadas em sala de aula, o conteúdo aqui descrito refere-se integralmente à minha participação e produção técnica.

#v(2cm)

#grid(
  columns: (1fr, 1fr), gutter: 2cm,
  align(center)[#line(length: 100%, stroke: 0.5pt) \ #strong[#aluno] \ Fatec Pompeia — ISW055],
  align(center)[#line(length: 100%, stroke: 0.5pt) \ Pompeia, #data-relatorio],
)
