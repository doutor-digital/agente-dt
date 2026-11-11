/**
 * Mapa das unidades: subdomínio Kommo (tabela `units` do kommo_dashboard) e a
 * credencial correspondente já cadastrada no n8n.
 *
 * Imperatriz é a canônica — é dela que sai o gabarito de campos, tags e opções.
 * Boa Vista existe no dashboard mas **não tem credencial no n8n**, então fica de fora
 * até alguém cadastrar o token dela.
 *
 * Salto: os ids das credenciais são marcadores (`__KOMMO__`, `__TRIGGER__`) — o `ligar-rastreio-salto.sh`
 * cria as credenciais no n8n e troca os marcadores pelos ids reais ao importar o fluxo.
 */
export const UNIDADES = [
  { slug: 'imperatriz',    nome: 'Imperatriz',     subdominio: 'attivacorpoementeitz',     credencial: { id: 'MnPGiOOvaSPm9HgC', name: 'Kommo Imperatriz' },      pasta: 'Imperatriz - Rastreio', canonica: true, tokenAdsEnv: 'META_ADS_TOKEN_IMPERATRIZ' },
  { slug: 'acailandia',    nome: 'Açailândia',     subdominio: 'doutorherniaacailandia',   credencial: { id: 'DqLADDQI9UEv6NiF', name: 'Kommo Açailândia' }, trigger: { id: 'Yp2dK9Y5FSp0tfIU', name: 'WhatsApp Trigger · Açailândia' }, tokenAdsEnv: 'META_ADS_TOKEN_ACAILANDIA' },
  { slug: 'araguaina',     nome: 'Araguaína',      subdominio: 'araguainadoutorhernia',    credencial: { id: 'QzoiphPGyGWg5dGQ', name: 'Kommo Araguaína' }, trigger: { id: 'ZZnhN6aGTxT8xRwS', name: 'WhatsApp Trigger · Araguaína' }, tokenAdsEnv: 'META_ADS_TOKEN_ARAGUAINA' },
  { slug: 'balsas',        nome: 'Balsas',         subdominio: 'doutorherniabalsas',       credencial: { id: '7kVS4ZItRvWsZ9Rc', name: 'Kommo Balsas' }, trigger: { id: 'M5byoYYggB3kpbpC', name: 'WhatsApp Trigger · Balsas' }, tokenAdsEnv: 'META_ADS_TOKEN_BALSAS' },
  { slug: 'canaa',         nome: 'Canaã',          subdominio: 'doutorherniacanaa',        credencial: { id: '8W38EQwnQoHBaWtM', name: 'Kommo Canaã' }, trigger: { id: 'hCZNhjAsNqN8yd5F', name: 'WhatsApp Trigger · Canaã' }, tokenAdsEnv: 'META_ADS_TOKEN_CANAA' },
  { slug: 'maraba',        nome: 'Marabá',         subdominio: 'marabadoutorhernia',       credencial: { id: 'OlXyNeejUa9C25Lq', name: 'Kommo Marabá' }, trigger: { id: 'FfdrmajF7u2ZTN8h', name: 'WhatsApp Trigger · Marabá' }, tokenAdsEnv: 'META_ADS_TOKEN_MARABA' },
  { slug: 'parauapebas',   nome: 'Parauapebas',    subdominio: 'parauapebasdoutorhernia',  credencial: { id: 'uDAqF7NwhVpJaVS0', name: 'Kommo Parauapebas' }, trigger: { id: 'zJr1ho1dNLLOuAmM', name: 'WhatsApp Trigger · Parauapebas' }, tokenAdsEnv: 'META_ADS_TOKEN_PARAUAPEBAS' },
  { slug: 'porto',         nome: 'Porto Nacional', subdominio: 'doutorherniaporto',        credencial: { id: '0pmkejndWKuiPTZC', name: 'Kommo Porto Nacional' }, trigger: { id: 'ruVSzcd7DpD1xQ77', name: 'WhatsApp Trigger · Porto Nacional' }, tokenAdsEnv: 'META_ADS_TOKEN_PORTO' },
  { slug: 'serra',         nome: 'Serra',          subdominio: 'drherniaserra',            credencial: { id: 'q2R9WqjWa9HCGkH4', name: 'Kommo Serra' }, trigger: { id: 'q6f4vQ471pWZykAT', name: 'WhatsApp Trigger · Serra' }, tokenAdsEnv: 'META_ADS_TOKEN_SERRA' },
  { slug: 'rioverde',      nome: 'Rio Verde',      subdominio: 'doutorherniarioverde2026', credencial: { id: 'gJav1pY0g503e5Qf', name: 'Kommo Rio Verde' }, trigger: { id: 'S4a5UQDddxV2XVlr', name: 'WhatsApp Trigger · Rio Verde' } },
  { slug: 'taubate',       nome: 'Taubaté',        subdominio: 'doutorherniataubatedt',    credencial: { id: 'rmHbc6sqKSi9G0TG', name: 'Kommo Taubaté' }, trigger: { id: 'yPMGb4lDTckcfRt9', name: 'WhatsApp Trigger · Taubaté' }, tokenAdsEnv: 'META_ADS_TOKEN_TAUBATE' },
  { slug: 'trauma',        nome: 'Instituto Trauma', subdominio: 'institutotraumakommon',  credencial: { id: 'IDrv4gZyutIINGMw', name: 'Kommo Trauma' }, tokenAdsEnv: 'META_ADS_TOKEN_TRAUMA' },
  { slug: 'timbo',         nome: 'Timbó',          subdominio: 'timbosc',                  credencial: { id: 'XeawYlyRvi6HBZUE', name: 'Kommo Timbó' }, trigger: { id: 'IS0NLrUxBtiQnYEn', name: 'WhatsApp Trigger · Timbó' }, tokenAdsEnv: 'META_ADS_TOKEN_TIMBO' },
  { slug: 'salto',         nome: 'Salto',          subdominio: 'doutorherniasalto',        credencial: { id: '__KOMMO__', name: 'Kommo Salto' }, trigger: { id: '__TRIGGER__', name: 'WhatsApp Trigger · Salto' }, tokenAdsEnv: 'META_ADS_TOKEN_SALTO' },
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
