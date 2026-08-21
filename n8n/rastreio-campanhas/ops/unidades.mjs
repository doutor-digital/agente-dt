/**
 * Mapa das unidades: subdomínio Kommo (tabela `units` do kommo_dashboard) e a
 * credencial correspondente já cadastrada no n8n.
 *
 * Imperatriz é a canônica — é dela que sai o gabarito de campos, tags e opções.
 * Boa Vista existe no dashboard mas **não tem credencial no n8n**, então fica de fora
 * até alguém cadastrar o token dela.
 */
export const UNIDADES = [
  { slug: 'imperatriz',    nome: 'Imperatriz',     subdominio: 'attivacorpoementeitz',     credencial: { id: 'MnPGiOOvaSPm9HgC', name: 'Kommo Imperatriz' },      pasta: 'Imperatriz - Rastreio', canonica: true },
  { slug: 'acailandia',    nome: 'Açailândia',     subdominio: 'doutorherniaacailandia',   credencial: { id: 'DqLADDQI9UEv6NiF', name: 'Kommo Açailândia' }, trigger: { id: 'Yp2dK9Y5FSp0tfIU', name: 'WhatsApp Trigger · Açailândia' } },
  { slug: 'araguaina',     nome: 'Araguaína',      subdominio: 'araguainadoutorhernia',    credencial: { id: 'QzoiphPGyGWg5dGQ', name: 'Kommo Araguaína' }, trigger: { id: 'ZZnhN6aGTxT8xRwS', name: 'WhatsApp Trigger · Araguaína' } },
  { slug: 'balsas',        nome: 'Balsas',         subdominio: 'doutorherniabalsas',       credencial: { id: '7kVS4ZItRvWsZ9Rc', name: 'Kommo Balsas' }, trigger: { id: 'M5byoYYggB3kpbpC', name: 'WhatsApp Trigger · Balsas' } },
  { slug: 'canaa',         nome: 'Canaã',          subdominio: 'doutorherniacanaa',        credencial: { id: '8W38EQwnQoHBaWtM', name: 'Kommo Canaã' }, trigger: { id: 'hCZNhjAsNqN8yd5F', name: 'WhatsApp Trigger · Canaã' } },
  { slug: 'maraba',        nome: 'Marabá',         subdominio: 'marabadoutorhernia',       credencial: { id: 'OlXyNeejUa9C25Lq', name: 'Kommo Marabá' }, trigger: { id: 'FfdrmajF7u2ZTN8h', name: 'WhatsApp Trigger · Marabá' } },
  { slug: 'parauapebas',   nome: 'Parauapebas',    subdominio: 'parauapebasdoutorhernia',  credencial: { id: 'uDAqF7NwhVpJaVS0', name: 'Kommo Parauapebas' }, trigger: { id: 'zJr1ho1dNLLOuAmM', name: 'WhatsApp Trigger · Parauapebas' } },
  { slug: 'porto',         nome: 'Porto Nacional', subdominio: 'doutorherniaporto',        credencial: { id: '0pmkejndWKuiPTZC', name: 'Kommo Porto Nacional' }, trigger: { id: 'ruVSzcd7DpD1xQ77', name: 'WhatsApp Trigger · Porto Nacional' } },
  { slug: 'serra',         nome: 'Serra',          subdominio: 'drherniaserra',            credencial: { id: 'q2R9WqjWa9HCGkH4', name: 'Kommo Serra' } },
  { slug: 'trauma',        nome: 'Instituto Trauma', subdominio: 'institutotraumakommon',  credencial: { id: 'IDrv4gZyutIINGMw', name: 'Kommo Trauma' } },
];

/**
 * Os campos que o rastreio grava, na nomenclatura da Imperatriz. A chave é a mesma
 * usada em `cfg.campos` dentro do workflow — é ela que liga o campo do Kommo ao
 * dado da atribuição.
 */
export const CAMPOS = [
  { chave: 'campanha',        nome: '⌂ Campanha',                tipo: 'text' },
  { chave: 'conjunto',        nome: '⌂ Conjunto de anúncio',     tipo: 'text' },
  { chave: 'anuncio',         nome: '⌂ Anúncio (ad)',            tipo: 'text' },
  { chave: 'anuncioId',       nome: '⌂ ID do anúncio',           tipo: 'text' },
  { chave: 'headline',        nome: '⌂ Título do anúncio',       tipo: 'text' },
  { chave: 'ctwaClid',        nome: '⌂ ctwa_clid',               tipo: 'text' },
  { chave: 'origemUrl',       nome: '⌂ URL de origem do clique', tipo: 'url' },
  { chave: 'plataforma',      nome: '⌂ Plataforma de origem',    tipo: 'text' },
  { chave: 'imagemAnuncio',   nome: '⌂ Imagem do anúncio',       tipo: 'url' },
  { chave: 'ultimoAnuncio',   nome: '⌂ Último anúncio',          tipo: 'text' },
  { chave: 'cliques',         nome: '⌂ Cliques no anúncio',      tipo: 'numeric' },
  { chave: 'primeiroContato', nome: '◷ Data do primeiro contato', tipo: 'date_time' },
  { chave: 'origemTipo',      nome: '⚑ Origem',                  tipo: 'select' },
  { chave: 'utmSource',       nome: 'utm_source',                tipo: 'tracking_data' },
  { chave: 'utmMedium',       nome: 'utm_medium',                tipo: 'tracking_data' },
  { chave: 'utmCampaign',     nome: 'utm_campaign',              tipo: 'tracking_data' },
  { chave: 'utmContent',      nome: 'utm_content',               tipo: 'tracking_data' },
  { chave: 'utmTerm',         nome: 'utm_term',                  tipo: 'tracking_data' },
];

/** Opções que o `⚑ Origem` precisa ter para o rastreio conseguir gravar. */
export const OPCOES_ORIGEM = ['Meta-Facebook', 'Meta-Instagram', 'Org-Facebook', 'Org-Instagram'];

export const TAGS = ['Origem: Anuncio pago', 'Origem: Organico'];
